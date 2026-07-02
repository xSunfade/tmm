import { supabaseAdmin } from '../supabaseClient.js';

const DEFAULT_RECONCILIATION_THRESHOLD = 250;

function toIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export async function getHistoryTimezoneForUser(userId) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('history_timezone')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load user history timezone: ${error.message}`);
  }
  return data?.history_timezone || 'UTC';
}

export function stableAsOfDate({ now = new Date(), timezone = 'UTC', useMonthEnd = false } = {}) {
  const safeTimezone = timezone || 'UTC';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [year, month, day] = formatter.format(now).split('-').map(Number);
  const base = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 0));
  if (!useMonthEnd) return base;
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 23, 59, 59, 0));
}

export async function createSnapshotsForAccounts(userId, accounts, options = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { snapshotRows: [], totalNetWorth: 0, pointDate: null };
  }
  const timezone = options.timezone || 'UTC';
  const asOf = options.asOf || stableAsOfDate({ timezone, useMonthEnd: !!options.useMonthEnd });
  const pointDate = toIsoDate(asOf);
  const source = options.source || 'plaid';
  const confidence = options.confidence || 'high';
  const pointSource = options.pointSource || 'plaid_archived';
  const skipIfFreshWithinMinutes = Number(options.skipIfFreshWithinMinutes || 0);

  if (skipIfFreshWithinMinutes > 0) {
    const freshnessCutoff = new Date(Date.now() - (skipIfFreshWithinMinutes * 60 * 1000)).toISOString();
    const { data: existingPoint, error: existingPointError } = await supabaseAdmin
      .from('net_worth_points')
      .select('id,updated_at')
      .eq('user_id', userId)
      .eq('point_date', pointDate)
      .eq('source', pointSource)
      .gte('updated_at', freshnessCutoff)
      .maybeSingle();
    if (existingPointError) {
      throw new Error(`Failed to check existing net worth point freshness: ${existingPointError.message}`);
    }
    if (existingPoint) {
      return {
        snapshotRows: [],
        totalNetWorth: 0,
        pointDate,
        point: null,
        skipped: true,
        skipReason: 'fresh_point_exists'
      };
    }
  }

  const snapshotRows = accounts.map((acc) => ({
    user_id: userId,
    account_id: acc.id,
    as_of: asOf.toISOString(),
    balance: Number(acc.balance || 0),
    available: acc.available == null ? null : Number(acc.available),
    currency_code: acc.currency_code || 'USD',
    source
  }));

  const { data: snapshots, error } = await supabaseAdmin
    .from('account_balance_snapshots')
    .upsert(snapshotRows, { onConflict: 'account_id,as_of', ignoreDuplicates: false })
    .select();
  if (error) {
    throw new Error(`Failed to create account balance snapshots: ${error.message}`);
  }

  const totalNetWorth = snapshotRows.reduce((sum, row) => sum + Number(row.balance || 0), 0);
  const pointPayload = {
    user_id: userId,
    point_date: pointDate,
    net_worth: totalNetWorth,
    source: pointSource,
    confidence,
    reconciled: !!options.reconciled,
    metadata: options.metadata || {}
  };
  const { data: points, error: pointsError } = await supabaseAdmin
    .from('net_worth_points')
    .upsert(pointPayload, { onConflict: 'user_id,point_date', ignoreDuplicates: false })
    .select()
    .single();
  if (pointsError) {
    throw new Error(`Failed to upsert net worth point from snapshots: ${pointsError.message}`);
  }

  return { snapshotRows: snapshots || [], totalNetWorth, pointDate, point: points };
}

export async function logPlaidSyncRunStart({
  syncRunId,
  itemId,
  userId,
  cursorBefore,
  backfillStartDate,
  backfillEndDate
}) {
  const payload = {
    sync_run_id: syncRunId,
    item_id: itemId,
    user_id: userId,
    cursor_before: cursorBefore || null,
    backfill_start_date: backfillStartDate || null,
    backfill_end_date: backfillEndDate || null,
    status: 'running',
    started_at: new Date().toISOString()
  };
  const { error } = await supabaseAdmin.from('plaid_sync_runs').insert(payload);
  if (error) {
    throw new Error(`Failed to log sync run start: ${error.message}`);
  }
}

export async function logPlaidSyncRunFinish({
  syncRunId,
  cursorAfter,
  addedCount,
  modifiedCount,
  removedCount,
  upsertedCount,
  deletedCount,
  skippedUnmappedAccounts,
  status = 'completed',
  errorMessage = null
}) {
  const { error } = await supabaseAdmin
    .from('plaid_sync_runs')
    .update({
      cursor_after: cursorAfter || null,
      added_count: addedCount || 0,
      modified_count: modifiedCount || 0,
      removed_count: removedCount || 0,
      upserted_count: upsertedCount || 0,
      deleted_count: deletedCount || 0,
      skipped_unmapped_accounts: skippedUnmappedAccounts || 0,
      status,
      error_message: errorMessage,
      finished_at: new Date().toISOString()
    })
    .eq('sync_run_id', syncRunId);
  if (error) {
    throw new Error(`Failed to log sync run finish: ${error.message}`);
  }
}

export async function applyPlaidTransactionsSyncAtomic({
  userId,
  itemId,
  nextCursor,
  upserts = [],
  removedIds = [],
  coverage = null,
  syncRunId,
  counts = {}
}) {
  const { data, error } = await supabaseAdmin.rpc('plaid_apply_transactions_sync', {
    p_user_id: userId,
    p_item_id: itemId,
    p_next_cursor: nextCursor || null,
    p_upserts: upserts || [],
    p_removed_ids: removedIds || [],
    p_coverage: coverage || null,
    p_sync_run_id: syncRunId,
    p_counts: counts || {}
  });
  if (error) {
    throw new Error(`Failed to apply Plaid sync atomically: ${error.message}`);
  }
  return data || {};
}

export async function getRecentPlaidSyncRuns(userId, limit = 25) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Number(limit))) : 25;
  const { data, error } = await supabaseAdmin
    .from('plaid_sync_runs')
    .select('sync_run_id,item_id,status,error_message,added_count,modified_count,removed_count,started_at,finished_at')
    .eq('user_id', userId)
    .order('started_at', { ascending: false })
    .limit(safeLimit);
  if (error) {
    throw new Error(`Failed to load recent Plaid sync runs: ${error.message}`);
  }
  return data || [];
}

export async function updatePlaidCoverageWindow(itemId, userId, range) {
  const earliest = toIsoDate(range?.earliest);
  const latest = toIsoDate(range?.latest);
  if (!earliest && !latest) return;

  const { data, error } = await supabaseAdmin
    .from('plaid_tokens')
    .select('earliest_txn_date_seen,latest_txn_date_seen')
    .eq('item_id', itemId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load Plaid coverage row: ${error.message}`);
  }
  if (!data) return;

  const currentEarliest = toIsoDate(data.earliest_txn_date_seen);
  const currentLatest = toIsoDate(data.latest_txn_date_seen);
  const nextEarliest = [currentEarliest, earliest].filter(Boolean).sort()[0] || null;
  const nextLatest = [currentLatest, latest].filter(Boolean).sort().slice(-1)[0] || null;

  const { error: updateError } = await supabaseAdmin
    .from('plaid_tokens')
    .update({
      earliest_txn_date_seen: nextEarliest,
      latest_txn_date_seen: nextLatest,
      updated_at: new Date().toISOString()
    })
    .eq('item_id', itemId)
    .eq('user_id', userId);
  if (updateError) {
    throw new Error(`Failed to update Plaid coverage window: ${updateError.message}`);
  }
}

export async function getTransactionDateRangeForItem(itemId, userId, accountIds = []) {
  let ids = accountIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    const { data: accounts, error: accountsError } = await supabaseAdmin
      .from('accounts')
      .select('id')
      .eq('user_id', userId)
      .eq('plaid_item_id', itemId);
    if (accountsError) throw new Error(`Failed to load accounts for date range: ${accountsError.message}`);
    ids = (accounts || []).map((a) => a.id);
  }
  if (!ids.length) return { earliest: null, latest: null };

  const { data: earliestRows, error: e1 } = await supabaseAdmin
    .from('transactions')
    .select('date')
    .in('account_id', ids)
    .order('date', { ascending: true })
    .limit(1);
  if (e1) throw new Error(`Failed to read earliest transaction date: ${e1.message}`);

  const { data: latestRows, error: e2 } = await supabaseAdmin
    .from('transactions')
    .select('date')
    .in('account_id', ids)
    .order('date', { ascending: false })
    .limit(1);
  if (e2) throw new Error(`Failed to read latest transaction date: ${e2.message}`);

  return {
    earliest: earliestRows?.[0]?.date || null,
    latest: latestRows?.[0]?.date || null
  };
}

export async function getCoverageForUser(userId) {
  const { data, error } = await supabaseAdmin
    .from('plaid_tokens')
    .select('earliest_txn_date_seen,latest_txn_date_seen')
    .eq('user_id', userId);
  if (error) {
    throw new Error(`Failed to load Plaid coverage for user: ${error.message}`);
  }
  const earliest = (data || [])
    .map((row) => toIsoDate(row.earliest_txn_date_seen))
    .filter(Boolean)
    .sort()[0] || null;
  const latest = (data || [])
    .map((row) => toIsoDate(row.latest_txn_date_seen))
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;
  return { earliest, latest };
}

export async function getHistoryPoints(userId, startDate, endDate) {
  let query = supabaseAdmin
    .from('net_worth_points')
    .select('point_date,net_worth,source,confidence,reconciled')
    .eq('user_id', userId)
    .order('point_date', { ascending: true });

  if (startDate) query = query.gte('point_date', startDate);
  if (endDate) query = query.lte('point_date', endDate);

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load history points: ${error.message}`);
  }
  return data || [];
}

export async function getReconciliationOverrides(userId, startDate, endDate) {
  let query = supabaseAdmin
    .from('history_reconciliation_overrides')
    .select('id,point_date,chosen_source,checkpoint_value,plaid_value')
    .eq('user_id', userId)
    .order('point_date', { ascending: true });
  if (startDate) query = query.gte('point_date', startDate);
  if (endDate) query = query.lte('point_date', endDate);
  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load reconciliation overrides: ${error.message}`);
  }
  return data || [];
}

export async function upsertReconciliationOverride({
  userId,
  pointDate,
  chosenSource,
  checkpointValue,
  plaidValue,
  reason = null
}) {
  const payload = {
    user_id: userId,
    point_date: pointDate,
    chosen_source: chosenSource,
    checkpoint_value: checkpointValue ?? null,
    plaid_value: plaidValue ?? null,
    reason
  };
  const { data, error } = await supabaseAdmin
    .from('history_reconciliation_overrides')
    .upsert(payload, { onConflict: 'user_id,point_date', ignoreDuplicates: false })
    .select()
    .single();
  if (error) {
    throw new Error(`Failed to save reconciliation override: ${error.message}`);
  }
  return data;
}

export function mergePointsWithCheckpoints({
  points,
  checkpoints = [],
  threshold = DEFAULT_RECONCILIATION_THRESHOLD,
  coverage = null,
  overrides = []
}) {
  const byDate = new Map();
  const overridesByDate = new Map((overrides || []).map((o) => [o.point_date, o]));

  for (const point of points || []) {
    byDate.set(point.point_date, {
      date: point.point_date,
      value: Number(point.net_worth || 0),
      source: point.source,
      confidence: point.confidence || 'high',
      reconciled: !!point.reconciled,
      needsReview: false
    });
  }

  for (const cp of checkpoints || []) {
    if (!cp?.date) continue;
    const date = cp.date.slice(0, 10);
    const checkpointValue = Number(cp.netWorth || 0);
    const existing = byDate.get(date);
    const override = overridesByDate.get(date);

    if (!existing) {
      byDate.set(date, {
        date,
        value: checkpointValue,
        source: cp.source === 'auto-monthly' ? 'checkpoint_auto' : 'checkpoint_user',
        confidence: cp.confidence || 'high',
        reconciled: false,
        needsReview: false
      });
      continue;
    }

    const delta = Math.abs(Number(existing.value || 0) - checkpointValue);
    const inCoverage = coverage?.earliest && coverage?.latest
      ? date >= coverage.earliest && date <= coverage.latest
      : false;
    const hasCoverageBounds = !!(coverage?.earliest && coverage?.latest);
    const existingIsPlaid = existing.source === 'plaid_live' || existing.source === 'plaid_archived';

    if (override?.chosen_source === 'checkpoint') {
      byDate.set(date, {
        date,
        value: checkpointValue,
        source: cp.source === 'auto-monthly' ? 'checkpoint_auto' : 'checkpoint_user',
        confidence: cp.confidence || 'high',
        reconciled: true,
        needsReview: false
      });
      continue;
    }

    if (override?.chosen_source === 'plaid') {
      byDate.set(date, {
        ...existing,
        reconciled: true,
        needsReview: false
      });
      continue;
    }

    // Default precedence: if we already have a Plaid-derived point on this date,
    // keep it unless user explicitly overrode to checkpoint.
    if (existingIsPlaid) {
      byDate.set(date, {
        ...existing,
        needsReview: (inCoverage || !hasCoverageBounds) ? delta > threshold : false,
        checkpointValue,
        plaidValue: Number(existing.value || 0)
      });
      continue;
    }

    if (inCoverage) {
      byDate.set(date, {
        ...existing,
        needsReview: delta > threshold,
        checkpointValue,
        plaidValue: Number(existing.value || 0)
      });
      continue;
    }

    byDate.set(date, {
      date,
      value: checkpointValue,
      source: cp.source === 'auto-monthly' ? 'checkpoint_auto' : 'checkpoint_user',
      confidence: cp.confidence || 'high',
      reconciled: false,
      needsReview: false
    });
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
