import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

const LEGACY_PLAN_KEY = 'mm-plan';
const DEFAULT_INFLATION = 2.5;

export type LegacyAssumptions = {
  inflation: number;
  start: string;
  finnhubKey: string;
};

export type LegacySettings = {
  assumptions: LegacyAssumptions;
  lastSavedIso: string | null;
  hasLegacyPlan: boolean;
};

type LegacyPlan = {
  assumptions?: Partial<LegacyAssumptions>;
  lastSaved?: string | null;
  alternatives?: Record<string, unknown>;
};

function getDefaultStartDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function readLegacyPlan(): LegacyPlan | null {
  const raw = getScopedLocalStorageItem(LEGACY_PLAN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LegacyPlan;
  } catch (error) {
    console.warn('[settings] Failed to parse legacy plan', error);
    return null;
  }
}

export function loadLegacySettings(): LegacySettings {
  const plan = readLegacyPlan();
  const assumptions = plan?.assumptions ?? {};
  return {
    assumptions: {
      inflation: Number.isFinite(assumptions.inflation)
        ? Number(assumptions.inflation)
        : DEFAULT_INFLATION,
      start: typeof assumptions.start === 'string' && assumptions.start.trim()
        ? assumptions.start
        : getDefaultStartDate(),
      finnhubKey: typeof assumptions.finnhubKey === 'string' ? assumptions.finnhubKey : ''
    },
    lastSavedIso: plan?.lastSaved ?? null,
    hasLegacyPlan: Boolean(plan)
  };
}

export function saveLegacySettings(next: LegacyAssumptions): { ok: boolean; error?: string } {
  try {
    const plan = readLegacyPlan() ?? {
      alternatives: { Baseline: { income: [], expense: [], asset: [], debt: [] } }
    };
    plan.assumptions = {
      inflation: next.inflation,
      start: next.start,
      finnhubKey: next.finnhubKey
    };
    plan.lastSaved = new Date().toISOString();
    setScopedLocalStorageItem(LEGACY_PLAN_KEY, JSON.stringify(plan));
    return { ok: true };
  } catch (error) {
    console.warn('[settings] Failed to persist legacy settings', error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
