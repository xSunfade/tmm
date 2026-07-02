import { authFetch } from '../api/authFetch';

export type PlaidSyncTriggerResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  message?: string;
  running?: boolean;
  job_id?: string | null;
  accounts_refresh?: Array<{ item_id: string; ok: boolean; error?: string; account_count?: number }>;
};

function normalizeSyncResponse(data: Record<string, unknown> | null): PlaidSyncTriggerResult {
  if (!data) {
    return {
      ok: false,
      skipped: true,
      reason: 'empty_response',
      message: 'Sync returned no response.'
    };
  }
  const running = !!(data.running || data.queued || data.already_running);
  return {
    ok: !!data.ok,
    skipped: !!data.skipped,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
    message: typeof data.message === 'string' ? data.message : undefined,
    running,
    job_id: typeof data.job_id === 'string' ? data.job_id : null,
    accounts_refresh: Array.isArray(data.accounts_refresh) ? data.accounts_refresh as PlaidSyncTriggerResult['accounts_refresh'] : undefined
  };
}

export async function triggerPlaidTransactionsSync(
  plaidBaseUrl: string,
  options: { userInitiated?: boolean; itemId?: string } = {}
): Promise<PlaidSyncTriggerResult> {
  const base = plaidBaseUrl.replace(/\/$/, '');
  const body: Record<string, unknown> = {
    user_initiated: !!options.userInitiated
  };
  if (options.itemId) body.item_id = options.itemId;

  try {
    const data = await authFetch(`${base}/api/plaid/transactions/sync`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    return normalizeSyncResponse(data);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed.message === 'string') {
      return {
        ok: false,
        skipped: !!parsed.skipped,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'error',
        message: parsed.message,
        accounts_refresh: Array.isArray(parsed.accounts_refresh)
          ? parsed.accounts_refresh as PlaidSyncTriggerResult['accounts_refresh']
          : undefined
      };
    }
    if (raw.includes('Unauthorized') || raw.includes('"error":"Unauthorized"')) {
      return {
        ok: false,
        reason: 'unauthorized',
        message: 'Could not authenticate. Try signing out and back in, then refresh again.'
      };
    }
    return {
      ok: false,
      reason: 'error',
      message: raw || 'Could not start bank data sync.'
    };
  }
}

export function describePlaidSyncResult(result: PlaidSyncTriggerResult): string {
  if (result.message) return result.message;
  if (result.running) return 'Updating bank data from Plaid…';
  if (result.ok && result.reason === 'accounts_refresh_only') {
    return 'Account balances refreshed from Plaid.';
  }
  if (result.ok) return 'Bank data sync started.';
  if (result.skipped && result.reason === 'outer_gate') {
    return 'Sync was skipped because a sync attempt ran recently.';
  }
  if (result.skipped) return 'Sync was skipped.';
  return 'Could not refresh bank data.';
}
