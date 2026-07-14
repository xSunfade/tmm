// Plaid sync orchestration: gate/freshness helpers, duplicate-connection
// detection, quotas, the transactions-sync workflow wiring, the job queue
// enqueue path, and the worker/scheduler entry points. Shared by the Plaid
// routes, the Plaid webhook, and server startup. Moved verbatim from
// server.js (Phase 2.9 router split).

import { plaidClient } from '../plaidClient.js';
import {
  getToken,
  getTransactionsSyncCursor,
  setTransactionsSyncCursor,
  listItemIdsForUser
} from '../tokenStore.js';
import { supabaseAdmin } from '../supabaseClient.js';
import {
  upsertAccountsForItem,
  getAccountsByUserId,
  getAccountsByUserAndItemId,
  getAccountsByUserAndPlaidAccountIds
} from '../models/account.js';
import {
  upsertTransactionsFromPlaidSync,
  deleteTransactionsByPlaidIds
} from '../models/transaction.js';
import {
  applyPlaidTransactionsSyncAtomic,
  getTransactionDateRangeForItem,
  logPlaidSyncRunFinish,
  logPlaidSyncRunStart,
  updatePlaidCoverageWindow
} from '../models/history.js';
import {
  acquirePlaidItemSyncLock,
  releasePlaidItemSyncLock,
  setPlaidItemHealthy,
  upsertPlaidItemStatus
} from '../models/plaidWebhook.js';
import { collectTransactionsSyncPages } from './plaidSyncEngine.js';
import {
  buildSyncJobDedupeKey,
  enqueuePlaidSyncJob
} from '../models/plaidSyncJobs.js';
import { incrementUsageCounter } from '../models/usageCounter.js';
import {
  ensurePlaidCircuitAllowsRequest,
  recordPlaidCircuitFailure,
  recordPlaidCircuitSuccess
} from '../models/plaidCircuitBreaker.js';
import { createTransactionsSyncWorkflow } from './plaidWorkflows/transactionsSyncWorkflow.js';
import { createArchiveSnapshotForItem } from './historyService.js';
import {
  getPlaidErrorCode,
  getPlaidErrorRequestId,
  isPlaidFailureForBreaker
} from './plaidErrorUtils.js';
import { dateToIsoDate, shiftIsoDateByDays, parseIsoTimestamp, isFutureIso } from './serverUtils.js';

export const PLAID_SYNC_PAGE_SIZE = 500;
export const DEFAULT_BACKFILL_DAYS = Number(process.env.PLAID_TRANSACTIONS_BACKFILL_DAYS || 10);
export const PLAID_SYNC_USE_QUEUE = String(process.env.PLAID_SYNC_USE_QUEUE || 'true').toLowerCase() !== 'false';
export const PLAID_SYNC_USE_RPC_APPLY = String(process.env.PLAID_SYNC_USE_RPC_APPLY || 'true').toLowerCase() !== 'false';
export const PLAID_EXCHANGE_REQUIRE_LINK_INTENT = String(process.env.PLAID_EXCHANGE_REQUIRE_LINK_INTENT || 'true').toLowerCase() !== 'false';
export const PLAID_SYNC_WORKER_ENABLED = String(process.env.RUN_PLAID_WORKER || 'true').toLowerCase() !== 'false';
export const PLAID_SYNC_COOLDOWN_SECONDS = Number(process.env.PLAID_SYNC_COOLDOWN_SECONDS || 30);
export const PLAID_SYNC_OUTER_GATE_MINUTES = Number(process.env.PLAID_SYNC_OUTER_GATE_MINUTES || 15);
export const PLAID_SYNC_INNER_HEALTHY_MINUTES = Number(process.env.PLAID_SYNC_INNER_HEALTHY_MINUTES || 60);
export const PLAID_SYNC_INNER_DEGRADED_MINUTES = Number(process.env.PLAID_SYNC_INNER_DEGRADED_MINUTES || 360);
export const PLAID_SYNC_DEDUPE_BUCKET_MINUTES = Number(process.env.PLAID_SYNC_DEDUPE_BUCKET_MINUTES || 15);
export const PLAID_ALLOW_FORCE_REFRESH = String(process.env.PLAID_ALLOW_FORCE_REFRESH || 'false').toLowerCase() === 'true';
export const PLAID_SYNC_USER_DAILY_MAX = Number(process.env.PLAID_SYNC_USER_DAILY_MAX || 300);
export const PLAID_SYNC_ITEM_HOURLY_MAX = Number(process.env.PLAID_SYNC_ITEM_HOURLY_MAX || 50);
export const PLAID_SYNC_WEBHOOK_DELAY_MS = Number(process.env.PLAID_SYNC_WEBHOOK_DELAY_MS || 30_000);
export const PLAID_ITEM_CAP = Math.max(1, Number(process.env.PLAID_ITEM_CAP || 5));
export const PLAID_ITEM_SAFETY_CEILING = Math.max(PLAID_ITEM_CAP, Number(process.env.PLAID_ITEM_SAFETY_CEILING || 10));
export const PLAID_NEW_CONNECTIONS_PER_7_DAYS = Math.max(1, Number(process.env.PLAID_NEW_CONNECTIONS_PER_7_DAYS || 2));
export const PLAID_NEW_CONNECTIONS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
let scheduledSyncRunning = false;

function normalizeDuplicateValue(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function normalizeDuplicateName(name) {
  const s = normalizeDuplicateValue(name);
  if (!s) return null;
  return s.toLowerCase().replace(/\s+/g, ' ');
}

function normalizeDuplicateMask(mask) {
  return normalizeDuplicateValue(mask);
}

function collectDuplicateAccountKeys(accounts, isIncoming) {
  const nameMask = new Set();
  const maskTypeSubtype = new Set();
  for (const account of accounts || []) {
    const name = normalizeDuplicateName(account?.name);
    const mask = normalizeDuplicateMask(account?.mask);
    const type = normalizeDuplicateValue(account?.type);
    const subtype = normalizeDuplicateValue(account?.subtype);
    if (name && mask) {
      nameMask.add(`${name}|${mask}`);
    }
    // Fallback when account names vary but type/subtype+mask remain stable.
    if (mask && (type || subtype)) {
      maskTypeSubtype.add(`${mask}|${type || ''}|${subtype || ''}`);
    }
  }

  return {
    hasStrongSignal: isIncoming
      ? nameMask.size > 0 || maskTypeSubtype.size > 0
      : true,
    nameMask,
    maskTypeSubtype
  };
}

function hasSetIntersection(a, b) {
  for (const value of a) {
    if (b.has(value)) return true;
  }
  return false;
}

function accountsOverlapForDuplicateCheck(incomingAccounts, existingAccounts) {
  const incomingKeys = collectDuplicateAccountKeys(incomingAccounts, true);
  const existingKeys = collectDuplicateAccountKeys(existingAccounts, false);
  if (incomingKeys.nameMask.size > 0 && existingKeys.nameMask.size > 0) {
    if (hasSetIntersection(incomingKeys.nameMask, existingKeys.nameMask)) return true;
  }
  if (incomingKeys.maskTypeSubtype.size > 0 && existingKeys.maskTypeSubtype.size > 0) {
    if (hasSetIntersection(incomingKeys.maskTypeSubtype, existingKeys.maskTypeSubtype)) return true;
  }
  return false;
}

export async function findDuplicateConnectedItem({ userId, linkSuccessMetadata, requestId }) {
  const institutionId = normalizeDuplicateValue(linkSuccessMetadata?.institution_id);
  if (!institutionId) {
    return null;
  }

  const incomingAccounts = Array.isArray(linkSuccessMetadata?.accounts)
    ? linkSuccessMetadata.accounts
    : [];

  const { data: tokenRows, error: tokenRowsErr } = await supabaseAdmin
    .from('plaid_tokens')
    .select('item_id')
    .eq('user_id', userId);
  if (tokenRowsErr) {
    throw new Error(`Failed to read Plaid items for duplicate check: ${tokenRowsErr.message}`);
  }
  const connectedItemIds = Array.from(new Set((tokenRows || []).map((row) => row.item_id).filter(Boolean)));
  if (connectedItemIds.length === 0) {
    return null;
  }

  const existingAccounts = await getAccountsByUserId(userId);
  const existingAccountsByItem = new Map();
  for (const account of existingAccounts || []) {
    if (!connectedItemIds.includes(account.plaid_item_id)) continue;
    if (!existingAccountsByItem.has(account.plaid_item_id)) {
      existingAccountsByItem.set(account.plaid_item_id, []);
    }
    existingAccountsByItem.get(account.plaid_item_id).push(account);
  }

  const connectedItemMetadata = await Promise.all(connectedItemIds.map(async (itemId) => {
    try {
      const accessToken = await getToken(itemId, userId);
      const itemRes = await plaidClient.itemGet({ access_token: accessToken });
      return {
        itemId,
        institutionId: normalizeDuplicateValue(itemRes?.data?.item?.institution_id)
      };
    } catch (err) {
      console.warn(JSON.stringify({
        type: 'plaid_duplicate_check_item_lookup_failed',
        requestId,
        userId,
        itemId,
        plaidRequestId: getPlaidErrorRequestId(err),
        message: err?.message || 'Unknown error',
        timestamp: new Date().toISOString()
      }));
      return null;
    }
  }));

  const sameInstitutionItems = connectedItemMetadata
    .filter((row) => row && row.institutionId === institutionId)
    .map((row) => row.itemId);

  for (const itemId of sameInstitutionItems) {
    const itemAccounts = existingAccountsByItem.get(itemId) || [];
    if (accountsOverlapForDuplicateCheck(incomingAccounts, itemAccounts)) {
      return {
        itemId,
        institutionId,
        reason: 'institution_and_account_match'
      };
    }
  }

  const incomingHasSignals = collectDuplicateAccountKeys(incomingAccounts, true).hasStrongSignal;
  if (!incomingHasSignals && sameInstitutionItems.length > 0) {
    return {
      itemId: sameInstitutionItems[0],
      institutionId,
      reason: 'institution_only_fallback'
    };
  }

  return null;
}

function buildSyncUpsertPayload(allUpserts = []) {
  return (allUpserts || [])
    .filter((tx) => tx?.transaction_id && tx?.account_id && tx?.date)
    .map((tx) => ({
      plaid_transaction_id: tx.transaction_id,
      plaid_account_id: tx.account_id,
      amount: tx.amount,
      date: tx.date,
      name: tx.name || 'Unknown',
      category: tx.category || [],
      merchant_name: tx.merchant_name || null,
      pending: !!tx.pending,
      iso_currency_code: tx.iso_currency_code || null,
      unofficial_currency_code: tx.unofficial_currency_code || null
    }));
}

export async function enforceSyncQuotas({ userId, itemId, phase }) {
  const userQuota = await incrementUsageCounter({
    metric: `plaid_sync_${phase}_user_daily`,
    userId,
    itemId: null,
    windowSeconds: 86400,
    max: PLAID_SYNC_USER_DAILY_MAX
  });
  if (!userQuota.allowed) {
    const err = new Error('User daily Plaid sync quota exceeded');
    err.code = 'SYNC_USER_DAILY_QUOTA_EXCEEDED';
    err.status = 429;
    err.noRetry = true;
    throw err;
  }
  if (itemId) {
    const itemQuota = await incrementUsageCounter({
      metric: `plaid_sync_${phase}_item_hourly`,
      userId,
      itemId,
      windowSeconds: 3600,
      max: PLAID_SYNC_ITEM_HOURLY_MAX
    });
    if (!itemQuota.allowed) {
      const err = new Error('Item hourly Plaid sync quota exceeded');
      err.code = 'SYNC_ITEM_HOURLY_QUOTA_EXCEEDED';
      err.status = 429;
      err.noRetry = true;
      throw err;
    }
  }
}

export function isItemDegraded(statusRow) {
  if (!statusRow) return false;
  if (statusRow.needs_update_mode) return true;
  if (statusRow.status === 'action_required' || statusRow.status === 'sync_error') return true;
  return Number(statusRow.consecutive_failures || 0) > 0;
}

export function getFreshWindowMinutesForItem(statusRow) {
  return isItemDegraded(statusRow)
    ? PLAID_SYNC_INNER_DEGRADED_MINUTES
    : PLAID_SYNC_INNER_HEALTHY_MINUTES;
}

export function isItemFresh(statusRow, now = new Date()) {
  const lastSync = parseIsoTimestamp(statusRow?.last_sync_finished_at);
  if (!lastSync) return false;
  const maxAgeMs = getFreshWindowMinutesForItem(statusRow) * 60 * 1000;
  return (now.getTime() - lastSync.getTime()) < maxAgeMs;
}

export function getMostRecentItemSyncAt(itemStatuses = []) {
  const latest = itemStatuses
    .map((s) => parseIsoTimestamp(s?.last_sync_finished_at))
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return latest || null;
}

export function computeNextEligibleSyncAt(statusRow, now = new Date()) {
  if (!statusRow) return now.toISOString();
  const candidates = [now.getTime()];
  const lockUntil = parseIsoTimestamp(statusRow.sync_locked_until);
  if (lockUntil && lockUntil.getTime() > now.getTime()) candidates.push(lockUntil.getTime());
  const cooldownUntil = parseIsoTimestamp(statusRow.cooldown_until);
  if (cooldownUntil && cooldownUntil.getTime() > now.getTime()) candidates.push(cooldownUntil.getTime());
  const lastSync = parseIsoTimestamp(statusRow.last_sync_finished_at);
  if (lastSync) {
    const outerGateMs = Math.max(1, PLAID_SYNC_OUTER_GATE_MINUTES) * 60 * 1000;
    candidates.push(lastSync.getTime() + outerGateMs);
  }
  return new Date(Math.max(...candidates)).toISOString();
}

export async function getUserActiveSyncJobs(userId, limit = 25) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const { data, error } = await supabaseAdmin
    .from('plaid_sync_jobs')
    .select('job_id,status,created_at,started_at,item_id,job_type,trigger')
    .eq('user_id', userId)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (error) {
    throw new Error(`Failed to load active Plaid sync jobs: ${error.message}`);
  }
  return data || [];
}

export async function recordPlaidConnectionEvent({
  userId,
  itemId,
  eventType,
  connectionType,
  institutionId = null,
  metadata = {}
}) {
  const payload = {
    user_id: userId,
    item_id: itemId,
    event_type: eventType,
    connection_type: connectionType,
    institution_id: institutionId || null,
    metadata: metadata || {}
  };
  const { error } = await supabaseAdmin
    .from('plaid_connection_events')
    .insert(payload);
  if (error) {
    throw new Error(`Failed to record plaid connection event: ${error.message}`);
  }
}

export async function updatePlaidTokenInstitution(userId, itemId, { institutionId, institutionName }) {
  const { error } = await supabaseAdmin
    .from('plaid_tokens')
    .update({
      institution_id: institutionId || null,
      institution_name: institutionName || null,
      updated_at: new Date().toISOString()
    })
    .eq('item_id', itemId)
    .eq('user_id', userId);
  if (error) {
    throw new Error(`Failed to update plaid token institution: ${error.message}`);
  }
}

export async function getRecentNewConnections(userId, now = new Date()) {
  const sinceIso = new Date(now.getTime() - PLAID_NEW_CONNECTIONS_WINDOW_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('plaid_connection_events')
    .select('created_at')
    .eq('user_id', userId)
    .eq('event_type', 'connect')
    .eq('connection_type', 'new')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true });
  if (error) {
    throw new Error(`Failed to load recent new connections: ${error.message}`);
  }
  return data || [];
}

export function computeConnectionRetryAfterDate(events = []) {
  if (!events.length) return null;
  const oldest = parseIsoTimestamp(events[0]?.created_at);
  if (!oldest) return null;
  return new Date(oldest.getTime() + PLAID_NEW_CONNECTIONS_WINDOW_MS).toISOString();
}

export function deriveAccountFreshness({ itemConnected, itemStatus, accountLastSyncedAt, now = new Date() }) {
  if (!itemConnected) return { is_current: false, is_stale: true, stale_reason: 'disconnected' };
  if (itemStatus?.needs_update_mode || itemStatus?.status === 'action_required') {
    return { is_current: false, is_stale: true, stale_reason: 'needs_update' };
  }
  if (isFutureIso(itemStatus?.cooldown_until, now)) {
    return { is_current: false, is_stale: true, stale_reason: 'cooldown' };
  }
  if (isFutureIso(itemStatus?.sync_locked_until, now)) {
    return { is_current: false, is_stale: true, stale_reason: 'locked' };
  }
  const accountSync = parseIsoTimestamp(accountLastSyncedAt);
  const itemSync = parseIsoTimestamp(itemStatus?.last_sync_finished_at);
  const referenceSync = accountSync && itemSync
    ? (accountSync.getTime() >= itemSync.getTime() ? accountSync : itemSync)
    : (accountSync || itemSync);
  if (!referenceSync) return { is_current: false, is_stale: true, stale_reason: 'never_synced' };
  const maxAgeMs = getFreshWindowMinutesForItem(itemStatus) * 60 * 1000;
  const stale = (now.getTime() - referenceSync.getTime()) >= maxAgeMs;
  return { is_current: !stale, is_stale: stale, stale_reason: stale ? 'stale' : null };
}

// Kept for parity with the pre-split server.js (not currently referenced).
export async function fetchAllTransactionsSyncUpdates(accessToken, baseCursor) {
  return collectTransactionsSyncPages({
    initialCursor: baseCursor || null,
    maxMutationRetries: 1,
    fetchPage: async (cursor) => {
      const response = await plaidClient.transactionsSync({
        access_token: accessToken,
        cursor,
        count: PLAID_SYNC_PAGE_SIZE
      });
      return response.data || {};
    }
  });
}

// Kept for parity with the pre-split server.js (not currently referenced).
export async function fetchTransactionsWindow(accessToken, startDate, endDate) {
  const transactions = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: PLAID_SYNC_PAGE_SIZE, offset }
    });
    const data = response.data || {};
    const chunk = data.transactions || [];
    transactions.push(...chunk);
    total = Number(data.total_transactions || chunk.length || 0);
    offset += chunk.length;
    if (chunk.length === 0) break;
  }
  return transactions;
}

export const syncTransactionsForItem = createTransactionsSyncWorkflow({
  plaidClient,
  getToken,
  getTransactionsSyncCursor,
  setTransactionsSyncCursor,
  upsertTransactionsFromPlaidSync,
  deleteTransactionsByPlaidIds,
  getAccountsByUserAndPlaidAccountIds,
  getAccountsByUserAndItemId,
  getTransactionDateRangeForItem,
  updatePlaidCoverageWindow,
  applyPlaidTransactionsSyncAtomic,
  logPlaidSyncRunStart,
  logPlaidSyncRunFinish,
  createArchiveSnapshotForItem,
  setPlaidItemHealthy,
  recordPlaidCircuitSuccess,
  recordPlaidCircuitFailure,
  upsertPlaidItemStatus,
  releasePlaidItemSyncLock,
  acquirePlaidItemSyncLock,
  ensurePlaidCircuitAllowsRequest,
  enforceSyncQuotas,
  shiftIsoDateByDays,
  dateToIsoDate,
  buildSyncUpsertPayload,
  getPlaidErrorCode,
  isPlaidFailureForBreaker,
  constants: {
    PLAID_SYNC_PAGE_SIZE,
    DEFAULT_BACKFILL_DAYS,
    PLAID_SYNC_USE_RPC_APPLY,
    PLAID_SYNC_COOLDOWN_SECONDS,
    PLAID_SYNC_LOCK_SECONDS: Number(process.env.PLAID_SYNC_LOCK_SECONDS || 120),
    PLAID_SYNC_MUTATION_RETRIES: 1
  }
});

export async function enqueueSyncForItem({
  userId,
  itemId,
  trigger = 'manual',
  payload = {},
  delayMs = 0
}) {
  if (!PLAID_SYNC_USE_QUEUE) {
    const result = await syncTransactionsForItem(itemId, userId, {
      forceRefresh: !!payload.force_refresh
    });
    return { job_id: null, immediate: true, result };
  }
  await enforceSyncQuotas({ userId, itemId, phase: 'enqueue' });
  const dedupeKey = buildSyncJobDedupeKey({
    userId,
    itemId,
    bucketMinutes: PLAID_SYNC_DEDUPE_BUCKET_MINUTES
  });
  const result = await enqueuePlaidSyncJob({
    userId,
    itemId,
    trigger,
    payload,
    delayMs,
    dedupeKey
  });
  console.log(JSON.stringify({
    type: 'plaid_sync_job_enqueued',
    jobId: result?.job?.job_id || null,
    userId,
    itemId: itemId || null,
    trigger,
    dedupeKey,
    created: !!result.created,
    timestamp: new Date().toISOString()
  }));
  return result.job;
}

export async function refreshAccountsForItem(userId, itemId) {
  const result = await refreshAccountsForItemWithResult(userId, itemId);
  if (!result.ok) {
    console.warn(JSON.stringify({
      type: 'plaid_accounts_refresh_after_sync_failed',
      userId,
      itemId,
      message: result.error || 'unknown_error',
      timestamp: new Date().toISOString()
    }));
    return [];
  }
  return result.accounts || [];
}

export async function refreshAccountsForItemWithResult(userId, itemId) {
  try {
    const accessToken = await getToken(itemId, userId);
    const response = await plaidClient.accountsGet({ access_token: accessToken });
    const plaidAccounts = response?.data?.accounts || [];
    if (!plaidAccounts.length) {
      return { item_id: itemId, ok: true, account_count: 0, accounts: [] };
    }
    const accounts = await upsertAccountsForItem(userId, itemId, plaidAccounts);
    return { item_id: itemId, ok: true, account_count: accounts.length, accounts };
  } catch (err) {
    return {
      item_id: itemId,
      ok: false,
      error: err?.message || String(err || 'unknown_error'),
      accounts: []
    };
  }
}

export async function processPlaidSyncJob(job, workerId) {
  const payload = job.payload || {};
  const itemId = job.item_id || null;
  const userId = job.user_id;
  const startedAtMs = Date.now();
  if (!userId) {
    const err = new Error('Plaid sync job missing user_id');
    err.noRetry = true;
    throw err;
  }
  if (job.job_type === 'sync_all' || !itemId) {
    const payloadItemIds = Array.isArray(payload.item_ids) ? payload.item_ids.filter(Boolean) : [];
    const itemIds = payloadItemIds.length > 0 ? payloadItemIds : await listItemIdsForUser(userId);
    const results = [];
    for (const id of itemIds) {
      results.push(await syncTransactionsForItem(id, userId, {
        forceRefresh: !!payload.force_refresh,
        workerId
      }));
      await refreshAccountsForItem(userId, id);
    }
    return {
      job_type: job.job_type,
      worker_id: workerId,
      item_count: itemIds.length,
      elapsed_ms: Date.now() - startedAtMs,
      results
    };
  }
  const result = await syncTransactionsForItem(itemId, userId, {
    forceRefresh: !!payload.force_refresh,
    workerId
  });
  await refreshAccountsForItem(userId, itemId);
  return {
    ...result,
    worker_id: workerId,
    trigger: job.trigger,
    dedupe_key: job.dedupe_key || null,
    elapsed_ms: Date.now() - startedAtMs
  };
}

export async function runScheduledTransactionsSync() {
  if (scheduledSyncRunning) return;
  scheduledSyncRunning = true;
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('plaid_tokens')
      .select('item_id,user_id');
    if (error) throw new Error(error.message);

    for (const row of rows || []) {
      try {
        if (PLAID_SYNC_USE_QUEUE) {
          await enqueueSyncForItem({
            userId: row.user_id,
            itemId: row.item_id,
            trigger: 'scheduled',
            payload: { force_refresh: false },
            delayMs: 0
          });
        } else {
          await syncTransactionsForItem(row.item_id, row.user_id);
        }
      } catch (err) {
        console.error(`Scheduled Plaid sync failed for item ${row.item_id}:`, err.message);
      }
    }
  } finally {
    scheduledSyncRunning = false;
  }
}
