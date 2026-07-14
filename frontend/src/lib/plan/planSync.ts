// Server-side plan sync client (Phase 2.3, ADR-1 / D14).
//
// Talks to the backend's /api/plan routes via authFetch (relative paths; the
// Vite dev proxy and production reverse proxy route them to the backend).
// The server is the authoritative source of truth; localStorage remains the
// offline cache (planPersistence.ts).

import { authFetch } from '../api/authFetch';
import type { PlanState } from './types';

export type ServerPlanResponse = {
  plan: Record<string, unknown> | null;
  schema_version?: string;
  size_bytes?: number;
  client_saved_at?: string | null;
  updated_at?: string | null;
};

export type PlanPushResult =
  | { status: 'saved'; clientSavedAt: string | null; sizeWarning: boolean }
  | { status: 'conflict'; serverClientSavedAt: string | null }
  | { status: 'error'; message: string };

export type PlanRevisionSummary = {
  id: string;
  schema_version: string;
  size_bytes: number;
  reason: 'save' | 'pre_import' | 'pre_migration' | 'manual';
  client_saved_at: string | null;
  created_at: string;
};

export type PlanRevision = PlanRevisionSummary & {
  plan: Record<string, unknown>;
};

export type PushPlanOptions = {
  /** Server client_saved_at this edit was based on; enables 409 conflict detection. */
  baseClientSavedAt?: string | null;
  reason?: 'save' | 'pre_import' | 'pre_migration' | 'manual';
  clientSavedAt?: string;
};

/**
 * Server persistence excludes device-local and derived state:
 *  - lastRun: cached simulation output; bloats every save and revision
 *  - assumptions.finnhubKey: user secret, never leaves the device (SEC-10)
 */
export function stripPlanForServer(plan: PlanState): Record<string, unknown> {
  const { lastRun: _lastRun, ...rest } = plan;
  return {
    ...rest,
    lastRun: null,
    assumptions: { ...plan.assumptions, finnhubKey: '' }
  };
}

/** Carries device-local fields over when hydrating a server plan. */
export function mergeServerPlanWithLocal(
  serverPlan: Record<string, unknown>,
  local: PlanState
): Record<string, unknown> {
  const serverAssumptions =
    serverPlan.assumptions && typeof serverPlan.assumptions === 'object'
      ? (serverPlan.assumptions as Record<string, unknown>)
      : {};
  return {
    ...serverPlan,
    assumptions: {
      ...serverAssumptions,
      finnhubKey: local.assumptions?.finnhubKey || ''
    }
  };
}

export async function fetchServerPlan(): Promise<ServerPlanResponse | null> {
  try {
    const data = (await authFetch('/api/plan', { method: 'GET' })) as ServerPlanResponse | null;
    return data ?? null;
  } catch (error) {
    console.warn('[plan-sync] Failed to load server plan', error);
    return null;
  }
}

function parseErrorPayload(error: unknown): Record<string, unknown> | null {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function pushPlanToServer(
  plan: PlanState,
  options: PushPlanOptions = {}
): Promise<PlanPushResult> {
  const clientSavedAt = options.clientSavedAt || new Date().toISOString();
  const body: Record<string, unknown> = {
    plan: stripPlanForServer(plan),
    schema_version: plan.schemaVersion || '2.0',
    client_saved_at: clientSavedAt,
    reason: options.reason || 'save'
  };
  if (options.baseClientSavedAt !== undefined && options.baseClientSavedAt !== null) {
    body.base_client_saved_at = options.baseClientSavedAt;
  }
  try {
    const data = (await authFetch('/api/plan', {
      method: 'PUT',
      body: JSON.stringify(body)
    })) as { client_saved_at?: string | null; size_warning?: boolean } | null;
    return {
      status: 'saved',
      clientSavedAt: data?.client_saved_at ?? clientSavedAt,
      sizeWarning: !!data?.size_warning
    };
  } catch (error) {
    const payload = parseErrorPayload(error);
    if (payload?.code === 'plan_conflict') {
      return {
        status: 'conflict',
        serverClientSavedAt:
          typeof payload.server_client_saved_at === 'string' ? payload.server_client_saved_at : null
      };
    }
    const message = payload?.message
      ? String(payload.message)
      : error instanceof Error
        ? error.message
        : 'Plan save failed';
    return { status: 'error', message };
  }
}

export async function fetchPlanRevisions(): Promise<PlanRevisionSummary[]> {
  try {
    const data = (await authFetch('/api/plan/revisions', { method: 'GET' })) as {
      revisions?: PlanRevisionSummary[];
    } | null;
    return data?.revisions ?? [];
  } catch (error) {
    console.warn('[plan-sync] Failed to list plan revisions', error);
    return [];
  }
}

export async function fetchPlanRevision(revisionId: string): Promise<PlanRevision | null> {
  try {
    const data = (await authFetch(`/api/plan/revisions/${encodeURIComponent(revisionId)}`, {
      method: 'GET'
    })) as { revision?: PlanRevision } | null;
    return data?.revision ?? null;
  } catch (error) {
    console.warn('[plan-sync] Failed to load plan revision', error);
    return null;
  }
}

/** ISO-8601 string compare; null/undefined sorts oldest. */
export function isNewer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return a > b;
}

function planHasEntities(plan: PlanState): boolean {
  const alternatives = plan.alternatives || {};
  return Object.values(alternatives).some(
    (alt) =>
      !!alt &&
      (alt.income.length > 0 || alt.expense.length > 0 || alt.asset.length > 0 || alt.debt.length > 0)
  );
}

/**
 * Pre-import snapshot (Phase 2.5, D14): before a Sheets refresh or XLSX import
 * replaces the plan, push the *current* plan as a `pre_import` revision so the
 * replacement is recoverable from Plan Backups. Best-effort: an offline or
 * signed-out session must not block the import itself. Empty plans are skipped
 * (nothing worth recovering).
 */
export async function snapshotPlanBeforeReplace(current: PlanState): Promise<void> {
  if (!planHasEntities(current)) return;
  try {
    await pushPlanToServer(current, { reason: 'pre_import' });
  } catch (error) {
    console.warn('[plan-sync] Pre-import snapshot failed (continuing with import)', error);
  }
}
