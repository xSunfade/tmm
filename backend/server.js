// Express server for Plaid API integration
// Handles all Plaid API calls server-side for security

import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import config from './config.js';
import { plaidClient, isPlaidConfigured } from './plaidClient.js';
import {
  storeToken,
  getToken,
  removeToken,
  initializeTokenStorage,
  getTransactionsSyncCursor,
  setTransactionsSyncCursor,
  listItemIdsForUser
} from './tokenStore.js';
import { requestLogger } from './middleware/logging.js';
import { correlationMiddleware } from './middleware/correlation.js';
import { requireAuth, requireTmmPlus } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { securityHeaders, createRequestTimeoutMiddleware } from './middleware/security.js';
import { validateBody, validateQuery, schemas } from './middleware/validation.js';
import { supabaseAdmin } from './supabaseClient.js';
import {
  upsertAccountsForItem,
  getAccountsByUserId,
  getAccountsByUserAndItemId,
  getItemIdsWithAccounts,
  updateAccountFromPlaidData,
  getAccountsByUserAndPlaidAccountIds,
  getAccountById,
  deleteAccountsByUserAndItemId
} from './models/account.js';
import {
  upsertTransactionsFromPlaidSync,
  deleteTransactionsByPlaidIds,
  getTransactionsByAccount,
  getTransactionsByUserId,
  deleteTransactionsByAccount
} from './models/transaction.js';
import {
  createSnapshotsForAccounts,
  applyPlaidTransactionsSyncAtomic,
  getCoverageForUser,
  getHistoryPoints,
  getHistoryTimezoneForUser,
  getRecentPlaidSyncRuns,
  getReconciliationOverrides,
  getTransactionDateRangeForItem,
  logPlaidSyncRunFinish,
  logPlaidSyncRunStart,
  mergePointsWithCheckpoints,
  stableAsOfDate,
  updatePlaidCoverageWindow,
  upsertReconciliationOverride
} from './models/history.js';
import {
  acquirePlaidItemSyncLock,
  getPlaidItemStatusesForUser,
  getRecentPlaidWebhookEvents,
  markPlaidWebhookEventProcessed,
  recordPlaidWebhookEvent,
  releasePlaidItemSyncLock,
  removePlaidItemStatus,
  setPlaidItemHealthy,
  upsertPlaidItemStatus
} from './models/plaidWebhook.js';
import { collectTransactionsSyncPages, dedupePlaidTransactions } from './lib/plaidSyncEngine.js';
import { getValidationResponse } from './lib/validationMode.js';
import {
  completePlaidLinkIntent,
  failPlaidLinkIntent,
  getPlaidLinkIntent,
  startPlaidLinkIntent
} from './models/plaidLinkIntent.js';
import {
  buildSyncJobDedupeKey,
  enqueuePlaidSyncJob,
  getRecentPlaidSyncJobs
} from './models/plaidSyncJobs.js';
import { incrementUsageCounter } from './models/usageCounter.js';
import {
  ensurePlaidCircuitAllowsRequest,
  getPlaidCircuitBreaker,
  recordPlaidCircuitFailure,
  recordPlaidCircuitSuccess
} from './models/plaidCircuitBreaker.js';
import { startPlaidSyncWorker } from './lib/plaidSyncWorker.js';
import { createTransactionsSyncWorkflow } from './lib/plaidWorkflows/transactionsSyncWorkflow.js';
import {
  createDeletionRequest,
  CURRENT_PRIVACY_POLICY_VERSION,
  failDeletionRequest,
  getLatestConsent,
  PLAID_CONSENT_TYPE,
  recordPrivacyConsent,
  completeDeletionRequest
} from './models/privacy.js';
import {
  storeGoogleTokens,
  getGoogleTokens,
  removeGoogleTokens,
  hasGoogleTokens
} from './storage/googleTokens.js';
import { createListPlaidItemsHandler, removePlaidItemForUser } from './lib/plaidItemHandlers.js';

const app = express();
const PORT = config.port;
const stripe = config.stripe.secretKey
  ? new Stripe(config.stripe.secretKey, { apiVersion: '2026-01-28.clover' })
  : null;
const STRIPE_UPGRADE_STATUSES = new Set(['active', 'trialing']);
const STRIPE_DOWNGRADE_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

// Request correlation and logging (must be before other middleware)
app.use(correlationMiddleware);
app.use(requestLogger);
app.use(securityHeaders({ enableHsts: config.enableHsts }));
app.use(createRequestTimeoutMiddleware(config.requestTimeoutMs));

// Multi-origin CORS support
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) {
      return callback(null, true);
    }

    // Check if origin is in allowed list
    if (config.corsOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // Optional local dev override.
      if (config.allowDevUnlistedCors) {
        console.warn(`⚠️  CORS: Allowing unlisted origin: ${origin}`);
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true
}));
// Stripe webhook signatures require the raw request body; register before JSON parsing.
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: config.jsonBodyLimit, strict: true }));

// Request validation middleware
const validateRequest = (req, res, next) => {
  if (req.method === 'POST' && !req.body) {
    return res.status(400).json({ error: 'Request body is required' });
  }
  next();
};

app.use(validateRequest);

const apiRateLimit = createRateLimiter({
  id: 'api-global',
  windowMs: 60_000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 240)
});
app.use('/api', apiRateLimit);

// Plaid routes fail fast with 503 when credentials are absent (FRAGILE-5);
// the client itself is lazy so the server boots without them (dev/Sheets-only
// work). The webhook route is excluded: it only records + enqueues.
app.use(['/api/plaid', '/api/ops/plaid'], (req, res, next) => {
  if (!isPlaidConfigured()) {
    return res.status(503).json({
      error: 'Plaid integration is not configured on this server',
      code: 'PLAID_NOT_CONFIGURED'
    });
  }
  next();
});

const webhookRateLimit = createRateLimiter({
  id: 'webhook-plaid',
  windowMs: 60_000,
  max: Number(process.env.PLAID_WEBHOOK_RATE_LIMIT_MAX || 180)
});

const createLinkTokenRateLimit = createRateLimiter({
  id: 'plaid-create-link-token',
  windowMs: 60_000,
  max: Number(process.env.PLAID_CREATE_LINK_RATE_LIMIT_MAX || 40),
  keyFn: (req) => req.userId || req.ip
});

const exchangeTokenRateLimit = createRateLimiter({
  id: 'plaid-exchange-token',
  windowMs: 60_000,
  max: Number(process.env.PLAID_EXCHANGE_RATE_LIMIT_MAX || 30),
  keyFn: (req) => req.userId || req.ip
});

const syncRateLimit = createRateLimiter({
  id: 'plaid-sync',
  windowMs: 60_000,
  max: Number(process.env.PLAID_SYNC_RATE_LIMIT_MAX || 16),
  keyFn: (req) => req.userId || req.ip
});

const PLAID_SYNC_PAGE_SIZE = 500;
const DEFAULT_BACKFILL_DAYS = Number(process.env.PLAID_TRANSACTIONS_BACKFILL_DAYS || 10);
const PLAID_SYNC_USE_QUEUE = String(process.env.PLAID_SYNC_USE_QUEUE || 'true').toLowerCase() !== 'false';
const PLAID_SYNC_USE_RPC_APPLY = String(process.env.PLAID_SYNC_USE_RPC_APPLY || 'true').toLowerCase() !== 'false';
const PLAID_EXCHANGE_REQUIRE_LINK_INTENT = String(process.env.PLAID_EXCHANGE_REQUIRE_LINK_INTENT || 'true').toLowerCase() !== 'false';
const PLAID_SYNC_WORKER_ENABLED = String(process.env.RUN_PLAID_WORKER || 'true').toLowerCase() !== 'false';
const PLAID_SYNC_COOLDOWN_SECONDS = Number(process.env.PLAID_SYNC_COOLDOWN_SECONDS || 30);
const PLAID_SYNC_OUTER_GATE_MINUTES = Number(process.env.PLAID_SYNC_OUTER_GATE_MINUTES || 15);
const PLAID_SYNC_INNER_HEALTHY_MINUTES = Number(process.env.PLAID_SYNC_INNER_HEALTHY_MINUTES || 60);
const PLAID_SYNC_INNER_DEGRADED_MINUTES = Number(process.env.PLAID_SYNC_INNER_DEGRADED_MINUTES || 360);
const PLAID_SYNC_DEDUPE_BUCKET_MINUTES = Number(process.env.PLAID_SYNC_DEDUPE_BUCKET_MINUTES || 15);
const PLAID_ALLOW_FORCE_REFRESH = String(process.env.PLAID_ALLOW_FORCE_REFRESH || 'false').toLowerCase() === 'true';
const PLAID_SYNC_USER_DAILY_MAX = Number(process.env.PLAID_SYNC_USER_DAILY_MAX || 300);
const PLAID_SYNC_ITEM_HOURLY_MAX = Number(process.env.PLAID_SYNC_ITEM_HOURLY_MAX || 50);
const PLAID_SYNC_WEBHOOK_DELAY_MS = Number(process.env.PLAID_SYNC_WEBHOOK_DELAY_MS || 30_000);
const HISTORY_ARCHIVE_NOOP_WINDOW_MINUTES = Math.max(0, Number(process.env.HISTORY_ARCHIVE_NOOP_WINDOW_MINUTES || 0));
const HISTORY_TMM_WRITE_USER_HOURLY_MAX = Math.max(1, Number(process.env.HISTORY_TMM_WRITE_USER_HOURLY_MAX || 12));
const HISTORY_TMM_WRITE_GLOBAL_HOURLY_MAX = Math.max(1, Number(process.env.HISTORY_TMM_WRITE_GLOBAL_HOURLY_MAX || 10000));
const HISTORY_TMM_WRITE_GLOBAL_USER_ID = String(process.env.HISTORY_TMM_WRITE_GLOBAL_USER_ID || '').trim();
const PLAID_ITEM_CAP = Math.max(1, Number(process.env.PLAID_ITEM_CAP || 5));
const PLAID_ITEM_SAFETY_CEILING = Math.max(PLAID_ITEM_CAP, Number(process.env.PLAID_ITEM_SAFETY_CEILING || 10));
const PLAID_NEW_CONNECTIONS_PER_7_DAYS = Math.max(1, Number(process.env.PLAID_NEW_CONNECTIONS_PER_7_DAYS || 2));
const PLAID_NEW_CONNECTIONS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
let scheduledSyncRunning = false;

function dateToIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

function shiftIsoDateByDays(days, fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setUTCDate(d.getUTCDate() - days);
  return dateToIsoDate(d);
}

function buildForensics(points) {
  return (points || [])
    .filter((p) => p?.needsReview)
    .map((p) => {
      const checkpointValue = Number(p.checkpointValue || 0);
      const plaidValue = Number(p.plaidValue || p.value || 0);
      const delta = plaidValue - checkpointValue;
      const classification = Math.abs(delta) <= 0.01 ? 'rounding' : 'modified_tx';
      return {
        date: p.date,
        delta,
        classification,
        confidence: classification === 'rounding' ? 'high' : 'medium',
        evidence: {
          checkpointValue,
          plaidValue
        }
      };
    });
}

function getPlaidErrorCode(err) {
  return err?.response?.data?.error_code || null;
}

function getPlaidResponseRequestId(response) {
  const id = response?.data?.request_id || response?.data?.requestId || null;
  return id ? String(id) : null;
}

function getPlaidErrorRequestId(err) {
  const id =
    err?.response?.data?.request_id ||
    err?.response?.data?.requestId ||
    err?.response?.headers?.['plaid-request-id'] ||
    err?.response?.headers?.['x-request-id'] ||
    null;
  return id ? String(id) : null;
}

function isPlaidFailureForBreaker(err) {
  const code = getPlaidErrorCode(err);
  return [
    'RATE_LIMIT_EXCEEDED',
    'INSTITUTION_DOWN',
    'PRODUCTS_NOT_SUPPORTED',
    'INTERNAL_SERVER_ERROR',
    'API_ERROR'
  ].includes(String(code || ''));
}

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

async function findDuplicateConnectedItem({ userId, linkSuccessMetadata, requestId }) {
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

async function enforceSyncQuotas({ userId, itemId, phase }) {
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

function parseIsoTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function getLocalDateString(value, timezone = 'UTC') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const safeTimezone = timezone || 'UTC';
  const toLocalDate = (timeZone) => {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  };
  try {
    return toLocalDate(safeTimezone) || toLocalDate('UTC');
  } catch {
    return toLocalDate('UTC');
  }
}

function parseBooleanFlag(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseAltNamesFromValue(value) {
  if (!value) return [];
  const csv = String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set(csv));
}

function isFutureIso(value, now = new Date()) {
  const d = parseIsoTimestamp(value);
  return !!d && d.getTime() > now.getTime();
}

function isItemDegraded(statusRow) {
  if (!statusRow) return false;
  if (statusRow.needs_update_mode) return true;
  if (statusRow.status === 'action_required' || statusRow.status === 'sync_error') return true;
  return Number(statusRow.consecutive_failures || 0) > 0;
}

function getFreshWindowMinutesForItem(statusRow) {
  return isItemDegraded(statusRow)
    ? PLAID_SYNC_INNER_DEGRADED_MINUTES
    : PLAID_SYNC_INNER_HEALTHY_MINUTES;
}

function isItemFresh(statusRow, now = new Date()) {
  const lastSync = parseIsoTimestamp(statusRow?.last_sync_finished_at);
  if (!lastSync) return false;
  const maxAgeMs = getFreshWindowMinutesForItem(statusRow) * 60 * 1000;
  return (now.getTime() - lastSync.getTime()) < maxAgeMs;
}

function getMostRecentItemSyncAt(itemStatuses = []) {
  const latest = itemStatuses
    .map((s) => parseIsoTimestamp(s?.last_sync_finished_at))
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return latest || null;
}

function computeNextEligibleSyncAt(statusRow, now = new Date()) {
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

async function getUserActiveSyncJobs(userId, limit = 25) {
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

async function recordPlaidConnectionEvent({
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

async function updatePlaidTokenInstitution(userId, itemId, { institutionId, institutionName }) {
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

async function getRecentNewConnections(userId, now = new Date()) {
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

function computeConnectionRetryAfterDate(events = []) {
  if (!events.length) return null;
  const oldest = parseIsoTimestamp(events[0]?.created_at);
  if (!oldest) return null;
  return new Date(oldest.getTime() + PLAID_NEW_CONNECTIONS_WINDOW_MS).toISOString();
}

function deriveAccountFreshness({ itemConnected, itemStatus, accountLastSyncedAt, now = new Date() }) {
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

async function fetchAllTransactionsSyncUpdates(accessToken, baseCursor) {
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

async function fetchTransactionsWindow(accessToken, startDate, endDate) {
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

const syncTransactionsForItem = createTransactionsSyncWorkflow({
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

async function enqueueSyncForItem({
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

async function refreshAccountsForItem(userId, itemId) {
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

async function refreshAccountsForItemWithResult(userId, itemId) {
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

async function processPlaidSyncJob(job, workerId) {
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

async function runScheduledTransactionsSync() {
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

async function getAccountsForUser(userId) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id,user_id,plaid_item_id,balance,currency_code')
    .eq('user_id', userId);
  if (error) throw new Error(`Failed to load user accounts: ${error.message}`);
  return data || [];
}

async function createArchiveSnapshotForUser(userId, options = {}) {
  const accounts = await getAccountsForUser(userId);
  if (!accounts.length) {
    return { snapshotRows: [], totalNetWorth: 0, pointDate: null, point: null };
  }
  const timezone = options.timezone || (await getHistoryTimezoneForUser(userId));
  const skipIfFreshWithinMinutes = options.forceArchive
    ? 0
    : (Number(options.skipIfFreshWithinMinutes) || HISTORY_ARCHIVE_NOOP_WINDOW_MINUTES);
  return createSnapshotsForAccounts(userId, accounts, {
    timezone,
    asOf: options.asOf,
    useMonthEnd: !!options.useMonthEnd,
    source: options.source || 'plaid',
    pointSource: options.pointSource || 'plaid_archived',
    confidence: options.confidence || 'high',
    metadata: options.metadata || {},
    skipIfFreshWithinMinutes
  });
}

async function createArchiveSnapshotForItem(userId, itemId, options = {}) {
  const accounts = await getAccountsByUserAndItemId(userId, itemId);
  if (!accounts.length) {
    return { snapshotRows: [], totalNetWorth: 0, pointDate: null, point: null };
  }
  const timezone = options.timezone || (await getHistoryTimezoneForUser(userId));
  const skipIfFreshWithinMinutes = options.forceArchive
    ? 0
    : (Number(options.skipIfFreshWithinMinutes) || HISTORY_ARCHIVE_NOOP_WINDOW_MINUTES);
  return createSnapshotsForAccounts(userId, accounts, {
    timezone,
    asOf: options.asOf,
    useMonthEnd: !!options.useMonthEnd,
    source: options.source || 'plaid',
    pointSource: options.pointSource || 'plaid_archived',
    confidence: options.confidence || 'high',
    metadata: options.metadata || { reason: 'item_disconnect', item_id: itemId },
    skipIfFreshWithinMinutes
  });
}

async function runScheduledHistorySnapshots() {
  const { data: plusUsers, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('plan_tier', 'tmm_plus');
  if (error) throw new Error(`Failed to load TMM+ users for snapshots: ${error.message}`);
  for (const row of plusUsers || []) {
    try {
      await createArchiveSnapshotForUser(row.id, {
        useMonthEnd: true,
        pointSource: 'plaid_archived',
        metadata: { trigger: 'scheduled_snapshot' }
      });
    } catch (err) {
      console.error(`Scheduled history snapshot failed for user ${row.id}:`, err.message);
    }
  }
}

async function deriveNetWorthPointsFromSnapshots(userId, startDate, endDate) {
  let query = supabaseAdmin
    .from('account_balance_snapshots')
    .select('as_of,balance,source')
    .eq('user_id', userId)
    .order('as_of', { ascending: true });
  if (startDate) query = query.gte('as_of', `${startDate}T00:00:00.000Z`);
  if (endDate) query = query.lte('as_of', `${endDate}T23:59:59.999Z`);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to load snapshots for fallback points: ${error.message}`);
  const grouped = new Map();
  for (const row of data || []) {
    const date = String(row.as_of).slice(0, 10);
    const current = grouped.get(date) || { net: 0, source: row.source || 'plaid_archived' };
    current.net += Number(row.balance || 0);
    grouped.set(date, current);
  }
  return Array.from(grouped.entries()).map(([pointDate, value]) => ({
    point_date: pointDate,
    net_worth: value.net,
    source: value.source || 'plaid_archived',
    confidence: 'high',
    reconciled: false
  }));
}

function deriveCoverageFromPoints(points) {
  const plaidDates = (points || [])
    .filter((p) => p?.source === 'plaid_live' || p?.source === 'plaid_archived')
    .map((p) => String(p.point_date || p.date || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  if (!plaidDates.length) return { earliest: null, latest: null };
  return {
    earliest: plaidDates[0],
    latest: plaidDates[plaidDates.length - 1]
  };
}

async function bestEffortDeleteByUser(table, userId) {
  try {
    const { error } = await supabaseAdmin.from(table).delete().eq('user_id', userId);
    if (error && !String(error.message || '').toLowerCase().includes('does not exist')) {
      throw error;
    }
  } catch (err) {
    const message = err?.message || '';
    if (!String(message).toLowerCase().includes('does not exist')) {
      throw err;
    }
  }
}

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  const requestId = req.requestId || 'unknown';
  
  // Log error with correlation ID (verbosity depends on environment)
  const errorLog = {
    type: 'error',
    requestId,
    method: req.method,
    path: req.path,
    error: err.message,
    timestamp: new Date().toISOString()
  };
  
  if (config.logging.verbose) {
    errorLog.stack = err.stack;
    errorLog.fullError = err.toString();
  }

  if (err.response) {
    // Plaid API error metadata (safe identifiers for support/debugging)
    errorLog.plaidRequestId = getPlaidErrorRequestId(err);
    errorLog.plaidErrorCode = getPlaidErrorCode(err);
    errorLog.plaidErrorType = err?.response?.data?.error_type || null;
    errorLog.plaidHttpStatus = err?.response?.status || null;
  }
  
  console.error(JSON.stringify(errorLog));
  
  if (err.response) {
    // Plaid API error
    const status = err.response.status || 500;
    const errorMessage = err.response.data?.error_message || 'Plaid API error';
    
    return res.status(status).json({
      error: errorMessage,
      request_id: getPlaidErrorRequestId(err),
      error_code: getPlaidErrorCode(err),
      ...(config.logging.verbose && { details: err.response.data })
    });
  }
  
  // CORS error
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      error: 'CORS policy violation',
      message: 'Origin not allowed'
    });
  }

  if (err.status && Number.isInteger(Number(err.status))) {
    return res.status(Number(err.status)).json({
      error: err.message || 'Request failed',
      code: err.code || null
    });
  }
  
  // Generic error
  res.status(500).json({
    error: config.isProduction ? 'Internal server error' : err.message
  });
};

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    requestId: req.requestId
  });
});

app.get('/', (req, res) => {
  res.send('TMM Backend is running 🚀');
});

function getGoogleConfigOrThrow() {
  if (!config.google.clientId || !config.google.clientSecret || !config.google.redirectUri) {
    throw new Error('Google OAuth configuration missing');
  }
  return config.google;
}

function buildGoogleAuthUrl(userId) {
  const google = getGoogleConfigOrThrow();
  const params = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: google.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: google.scopes,
    state: userId
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const google = getGoogleConfigOrThrow();
  const body = new URLSearchParams({
    code,
    client_id: google.clientId,
    client_secret: google.clientSecret,
    redirect_uri: google.redirectUri,
    grant_type: 'authorization_code'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token exchange failed: ${error}`);
  }
  const tokenResponse = await response.json();
  return tokenResponse;
}

async function refreshAccessToken(refreshToken) {
  const google = getGoogleConfigOrThrow();
  const body = new URLSearchParams({
    client_id: google.clientId,
    client_secret: google.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token refresh failed: ${error}`);
  }
  return response.json();
}

async function fetchGoogleProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function getValidGoogleTokens(userId) {
  const tokens = await getGoogleTokens(userId);
  if (!tokens) return null;
  const expiresAt = new Date(tokens.expires_at).getTime();
  const now = Date.now();
  if (expiresAt > now + 60000) {
    return tokens;
  }
  if (!tokens.refresh_token) {
    return tokens;
  }
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  const nextTokens = {
    ...tokens,
    access_token: refreshed.access_token,
    expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
  };
  await storeGoogleTokens(userId, nextTokens);
  return nextTokens;
}

const GOOGLE_SHEETS_FETCH_TIMEOUT_MS = 25000;
// Google Sheets allows 60 write requests/min/user. On 429/503 the request was NOT
// processed, so retrying with backoff is safe (no risk of duplicate appends) and lets
// large syncs succeed as the per-minute quota refills.
// Worst-case cumulative backoff = 1000+2000+4000+8000 = 15s (plus small jitter). Kept below
// the frontend Sheets request timeout so a backing-off retry can finish instead of being aborted.
const GOOGLE_SHEETS_MAX_RETRIES = 4;
const GOOGLE_SHEETS_RETRY_BASE_MS = 1000;
const GOOGLE_SHEETS_RETRY_MAX_MS = 8000;
const GOOGLE_SHEETS_RETRYABLE_STATUS = new Set([429, 503]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds, or null. */
function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function googleSheetsFetch(url, options = {}) {
  let attempt = 0;
  while (true) {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(GOOGLE_SHEETS_FETCH_TIMEOUT_MS)
    });
    if (!GOOGLE_SHEETS_RETRYABLE_STATUS.has(response.status) || attempt >= GOOGLE_SHEETS_MAX_RETRIES) {
      return response;
    }
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    const backoffMs = Math.min(
      GOOGLE_SHEETS_RETRY_MAX_MS,
      GOOGLE_SHEETS_RETRY_BASE_MS * 2 ** attempt
    );
    const jitterMs = Math.floor(Math.random() * 250);
    const waitMs = (retryAfterMs != null ? retryAfterMs : backoffMs) + jitterMs;
    // Drain the body so the underlying connection can be reused.
    try {
      await response.arrayBuffer();
    } catch {
      // Ignore drain failures; we are discarding this response anyway.
    }
    console.warn(JSON.stringify({
      type: 'google_sheets_retry',
      status: response.status,
      attempt: attempt + 1,
      waitMs
    }));
    await sleep(waitMs);
    attempt += 1;
  }
}

function getFallbackAppOrigin(req) {
  const reqOrigin = String(req.headers.origin || '').trim();
  if (reqOrigin) {
    try {
      return new URL(reqOrigin).origin;
    } catch {
      // Ignore invalid Origin header and continue to configured fallback.
    }
  }
  return config.corsOrigins[0] || 'http://localhost:5173';
}

function resolveAbsoluteUrl(candidate, fallback) {
  if (!candidate || typeof candidate !== 'string') return fallback;
  try {
    return new URL(candidate).toString();
  } catch {
    return fallback;
  }
}

function getStripeSubscriptionCustomerId(subscriptionObject) {
  const customer = subscriptionObject?.customer;
  if (typeof customer === 'string') return customer;
  if (customer && typeof customer === 'object' && typeof customer.id === 'string') return customer.id;
  return null;
}

async function resolveStripeUserIdFromEventObject(object) {
  const metadata = object?.metadata || {};
  const metadataUserId = metadata.user_id || metadata.supabase_user_id || null;
  if (metadataUserId) return metadataUserId;

  const customerId = getStripeSubscriptionCustomerId(object);
  if (!customerId) return null;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve Stripe customer mapping: ${error.message}`);
  return data?.id || null;
}

async function getOrCreateStripeCustomerIdForUser(userId, email) {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }

  if (profile?.stripe_customer_id) {
    return profile.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: {
      user_id: userId,
      supabase_user_id: userId
    }
  });

  const { error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({ stripe_customer_id: customer.id })
    .eq('id', userId);
  if (updateError) {
    throw new Error(`Failed to save Stripe customer id: ${updateError.message}`);
  }

  return customer.id;
}

app.post('/api/stripe/create-checkout-session', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured on the backend' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database admin client unavailable' });
    }
    if (!config.stripe.tmmPlusPriceId) {
      return res.status(503).json({ error: 'STRIPE_PRICE_ID_TMM_PLUS is not configured' });
    }

    const origin = getFallbackAppOrigin(req);
    const body = req.body || {};
    const successUrl = resolveAbsoluteUrl(body.success_url, `${origin}?stripe=success`);
    const cancelUrl = resolveAbsoluteUrl(body.cancel_url, `${origin}?stripe=cancel`);
    const customerId = await getOrCreateStripeCustomerIdForUser(req.userId, req.user?.email || null);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: config.stripe.tmmPlusPriceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: req.userId,
      subscription_data: {
        metadata: {
          user_id: req.userId,
          supabase_user_id: req.userId
        }
      }
    });

    if (!session.url) {
      throw new Error('Stripe did not return a Checkout session URL');
    }

    return res.json({ url: session.url });
  } catch (err) {
    return next(err);
  }
});

app.post('/api/stripe/create-portal-session', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured on the backend' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database admin client unavailable' });
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load profile: ${error.message}`);
    }
    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No subscription found; use Upgrade to TMM+ to subscribe.' });
    }

    const origin = getFallbackAppOrigin(req);
    const body = req.body || {};
    const returnUrl = resolveAbsoluteUrl(body.return_url, `${origin}?stripe=success`);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: returnUrl
    });

    return res.json({ url: portalSession.url });
  } catch (err) {
    return next(err);
  }
});

// Stripe webhook endpoint (server-only, no user JWT). Requires raw body for signature verification.
app.post('/api/webhooks/stripe', async (req, res, next) => {
  try {
    if (!stripe || !config.stripe.webhookSecret) {
      return res.status(503).json({ error: 'Stripe webhook is not configured' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database admin client unavailable' });
    }

    const requestId = req.requestId || 'unknown';
    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      console.warn(JSON.stringify({
        type: 'webhook_rejected',
        requestId,
        reason: 'Bearer token not allowed on webhook',
        path: req.path,
        timestamp: new Date().toISOString()
      }));
      return res.status(403).json({ error: 'Webhook endpoint does not accept user authentication' });
    }

    const stripeSignature = String(req.headers['stripe-signature'] || '');
    if (!stripeSignature) {
      return res.status(400).json({ error: 'Stripe signature missing' });
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, stripeSignature, config.stripe.webhookSecret);
    } catch (err) {
      return res.status(400).json({ error: `Invalid Stripe signature: ${err.message}` });
    }

    const eventType = event.type || null;
    const object = event.data?.object || {};
    const candidateUserId = await resolveStripeUserIdFromEventObject(object);
    const status = String(object.status || '').toLowerCase();
    const isSubscriptionUpdate = eventType === 'customer.subscription.updated';
    const shouldUpgrade = candidateUserId && (
      eventType === 'customer.subscription.created' ||
      (isSubscriptionUpdate && STRIPE_UPGRADE_STATUSES.has(status))
    );
    const shouldDowngrade = candidateUserId && (
      eventType === 'customer.subscription.deleted' ||
      (isSubscriptionUpdate && STRIPE_DOWNGRADE_STATUSES.has(status))
    );

    if (shouldUpgrade) {
      const { error: upgradeError } = await supabaseAdmin
        .from('profiles')
        .update({ plan_tier: 'tmm_plus' })
        .eq('id', candidateUserId);
      if (upgradeError) {
        throw new Error(`Stripe upgrade profile update failed: ${upgradeError.message}`);
      }
    }

    if (shouldDowngrade) {
      try {
        await createArchiveSnapshotForUser(candidateUserId, {
          pointSource: 'plaid_archived',
          metadata: { trigger: 'stripe_downgrade', event_type: eventType }
        });
      } catch (archiveErr) {
        console.error(`Stripe downgrade archive hook failed for ${candidateUserId}:`, archiveErr.message);
      }

      const { error: downgradeError } = await supabaseAdmin
        .from('profiles')
        .update({ plan_tier: 'free' })
        .eq('id', candidateUserId);
      if (downgradeError) {
        throw new Error(`Stripe downgrade profile update failed: ${downgradeError.message}`);
      }
    }

    console.log(JSON.stringify({
      type: 'webhook_stripe',
      requestId,
      path: req.path,
      eventType,
      candidateUserId,
      status,
      timestamp: new Date().toISOString()
    }));
    return res.status(200).json({ received: true });
  } catch (err) {
    return next(err);
  }
});

// Plaid webhook endpoint (server-only, no user JWT).
app.post('/api/webhooks/plaid', webhookRateLimit, async (req, res, next) => {
  try {
    const requestId = req.requestId || 'unknown';
    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      return res.status(403).json({ error: 'Webhook endpoint does not accept user authentication' });
    }

    const payload = req.body || {};
    const webhookType = payload.webhook_type;
    const webhookCode = payload.webhook_code;
    const itemId = payload.item_id;
    const plaidErrorCode = payload.error?.error_code || null;
    const plaidRequestId = payload.request_id || payload.error?.request_id || null;
    let userId = null;

    if (itemId) {
      const { data } = await supabaseAdmin
        .from('plaid_tokens')
        .select('user_id')
        .eq('item_id', itemId)
        .maybeSingle();
      userId = data?.user_id || null;
    }

    const recorded = await recordPlaidWebhookEvent({
      payload,
      requestId,
      userId,
      status: 'received'
    });
    if (recorded.duplicate) {
      return res.status(200).json({ received: true, duplicate: true });
    }

    if (webhookType === 'TRANSACTIONS' && webhookCode === 'SYNC_UPDATES_AVAILABLE' && itemId) {
      if (!userId) {
        throw new Error('Failed to resolve webhook item owner');
      }
      await enqueueSyncForItem({
        userId,
        itemId,
        trigger: 'webhook',
        payload: { force_refresh: false, source: 'SYNC_UPDATES_AVAILABLE' },
        delayMs: PLAID_SYNC_WEBHOOK_DELAY_MS
      });
    }

    if (webhookCode === 'LOGIN_REPAIRED' && userId && itemId) {
      await setPlaidItemHealthy(userId, itemId, {
        trigger: 'webhook',
        webhookType: webhookType || null,
        webhookCode: 'LOGIN_REPAIRED'
      });
    }

    const isRevocation = webhookCode === 'USER_PERMISSION_REVOKED' || webhookCode === 'USER_ACCOUNT_REVOKED';
    if (isRevocation && userId && itemId) {
      try {
        const accessToken = await getToken(itemId, userId);
        try {
          await plaidClient.itemRemove({ access_token: accessToken });
        } catch (err) {
          console.warn(JSON.stringify({
            type: 'plaid_item_remove_revocation_failed',
            requestId,
            userId,
            itemId,
            plaidRequestId: getPlaidErrorRequestId(err),
            message: err?.message || String(err || 'unknown_error'),
            timestamp: new Date().toISOString()
          }));
        }
      } catch (_) {
        // Token already missing or invalid
      }
      try {
        await removeToken(itemId, userId);
      } catch (err) {
        console.warn(`[plaid] removeToken on revocation for ${itemId}:`, err?.message || err);
      }
      const itemAccounts = await getAccountsByUserAndItemId(userId, itemId);
      for (const acc of itemAccounts) {
        try {
          await deleteTransactionsByAccount(acc.id);
        } catch (_) {
          // best effort
        }
      }
      try {
        await deleteAccountsByUserAndItemId(userId, itemId);
      } catch (err) {
        console.warn(`[plaid] deleteAccountsByUserAndItemId on revocation for ${itemId}:`, err?.message || err);
      }
      await upsertPlaidItemStatus({
        userId,
        itemId,
        status: 'revoked',
        needsUpdateMode: false,
        webhookType: webhookType || null,
        webhookCode,
        metadata: payload
      });
    }

    const requiresUpdateMode = (
      webhookCode === 'PENDING_DISCONNECT' ||
      webhookCode === 'PENDING_EXPIRATION' ||
      plaidErrorCode === 'ITEM_LOGIN_REQUIRED' ||
      plaidErrorCode === 'ITEM_ERROR' ||
      webhookCode === 'NEW_ACCOUNTS_AVAILABLE'
    );

    if (requiresUpdateMode && userId && itemId) {
      await upsertPlaidItemStatus({
        userId,
        itemId,
        status: 'action_required',
        needsUpdateMode: true,
        lastErrorCode: plaidErrorCode,
        webhookType,
        webhookCode,
        metadata: payload
      });
    }

    await markPlaidWebhookEventProcessed(recorded.eventHash, 'processed');

    console.log(JSON.stringify({
      type: 'webhook_plaid',
      requestId,
      userId,
      webhookType,
      webhookCode,
      plaidErrorCode,
      plaidRequestId,
      itemId: itemId || null,
      timestamp: new Date().toISOString()
    }));
    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
});

// Google OAuth - get authorization URL
app.post('/api/google/oauth/authorize', requireAuth, async (req, res, next) => {
  try {
    const url = buildGoogleAuthUrl(req.userId);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// Google OAuth callback
app.get('/api/google/oauth/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({ error: 'Missing OAuth code or state' });
    }
    const tokenResponse = await exchangeCodeForTokens(code);
    const profile = await fetchGoogleProfile(tokenResponse.access_token);
    const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();
    await storeGoogleTokens(state, {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      expires_at: expiresAt,
      google_user_id: profile?.id || null,
      google_user_email: profile?.email || null
    });
    const base = config.google.frontendRedirect || '/';
    const sep = base.includes('?') ? '&' : '?';
    const redirect = `${base}${sep}sheets=connected`;
    res.redirect(redirect);
  } catch (err) {
    next(err);
  }
});

// Google Picker - get access token for Drive Picker (requires auth + connected)
app.get('/api/google/token-for-picker', requireAuth, async (req, res, next) => {
  try {
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    res.json({ accessToken: tokens.access_token });
  } catch (err) {
    next(err);
  }
});

// Google tokens status — validate/refresh so UI shows correct state on load (no false CONNECTED when token expired/revoked)
app.get('/api/google/tokens', requireAuth, async (req, res, next) => {
  try {
    const tokens = await getValidGoogleTokens(req.userId);
    if (tokens) {
      return res.json({
        connected: true,
        expiresAt: tokens.expires_at || null,
        email: tokens.google_user_email || null
      });
    }
    return res.json({ connected: false, expiresAt: null, email: null });
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired') || msg.includes('Token has been revoked') || msg.includes('Google token refresh failed')) {
      await removeGoogleTokens(req.userId).catch(() => {});
      return res.json({ connected: false, expiresAt: null, email: null });
    }
    next(err);
  }
});

// Google disconnect
app.delete('/api/google/tokens', requireAuth, async (req, res, next) => {
  try {
    await removeGoogleTokens(req.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - create spreadsheet
app.post('/api/google/sheets/create', requireAuth, async (req, res, next) => {
  try {
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const title = req.body?.title || 'The Money Machine Plan';
    const sheets = Array.isArray(req.body?.sheets)
      ? req.body.sheets
      : ['Settings', 'Alternatives', 'Augments', 'Checkpoints', 'TMM_META'];
    const response = await googleSheetsFetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: { title },
        sheets: sheets.map((name) => ({ properties: { title: name } }))
      })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets create failed: ${error}`);
    }
    const data = await response.json();
    res.json({ spreadsheetId: data.spreadsheetId, spreadsheetUrl: data.spreadsheetUrl });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - read
app.post('/api/google/sheets/read', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, range } = req.body;
    if (!spreadsheetId || !range) {
      return res.status(400).json({ error: 'spreadsheetId and range are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
    const response = await googleSheetsFetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets read failed: ${error}`);
    }
    const data = await response.json();
    res.json({ values: data.values || [] });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - spreadsheet metadata (e.g. title for import toast)
app.get('/api/google/sheets/metadata', requireAuth, async (req, res, next) => {
  try {
    const spreadsheetId = req.query.spreadsheetId;
    if (!spreadsheetId || typeof spreadsheetId !== 'string') {
      return res.status(400).json({ error: 'spreadsheetId query is required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=properties.title`;
    const response = await googleSheetsFetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets metadata failed: ${error}`);
    }
    const data = await response.json();
    const title = data.properties?.title || 'Spreadsheet';
    res.json({ title });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - write
app.post('/api/google/sheets/write', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, range, values, valueInputOption } = req.body;
    if (!spreadsheetId || !range || !values) {
      return res.status(400).json({ error: 'spreadsheetId, range, values are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption || 'USER_ENTERED'}`;
    const response = await googleSheetsFetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets write failed: ${error}`);
    }
    const data = await response.json();
    res.json({ updatedCells: data.updatedCells });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - append
app.post('/api/google/sheets/append', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, range, values, valueInputOption } = req.body;
    if (!spreadsheetId || !range || !values) {
      return res.status(400).json({ error: 'spreadsheetId, range, values are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=${valueInputOption || 'USER_ENTERED'}`;
    const response = await googleSheetsFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets append failed: ${error}`);
    }
    const data = await response.json();
    res.json({ updates: data.updates });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - clear range (fixed tables / full-replace only; never use for entity-row deletion)
app.post('/api/google/sheets/clear', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, range } = req.body;
    if (!spreadsheetId || !range) {
      return res.status(400).json({ error: 'spreadsheetId and range are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`;
    const response = await googleSheetsFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets clear failed: ${error}`);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - values batchUpdate (multiple ranges written in ONE write request).
// Used to collapse per-row entity updates into a single quota-costing call.
app.post('/api/google/sheets/valuesBatchUpdate', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, data, valueInputOption } = req.body;
    if (!spreadsheetId || !Array.isArray(data)) {
      return res.status(400).json({ error: 'spreadsheetId and data array are required' });
    }
    if (data.length === 0) {
      return res.json({ totalUpdatedCells: 0 });
    }
    for (const entry of data) {
      if (!entry || typeof entry.range !== 'string' || !Array.isArray(entry.values)) {
        return res.status(400).json({ error: 'Each data entry requires a string range and values array' });
      }
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
    const response = await googleSheetsFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        valueInputOption: valueInputOption || 'USER_ENTERED',
        data: data.map((entry) => ({ range: entry.range, values: entry.values }))
      })
    });
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Sheets valuesBatchUpdate failed: ${error}`);
    }
    const result = await response.json();
    res.json({ totalUpdatedCells: result.totalUpdatedCells ?? 0 });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - create missing tabs by title (for older spreadsheets connected via picker)
app.post('/api/google/sheets/ensureTabs', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, sheetNames } = req.body;
    if (!spreadsheetId || !Array.isArray(sheetNames)) {
      return res.status(400).json({ error: 'spreadsheetId and sheetNames array are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });

    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(title)`;
    const metaRes = await googleSheetsFetch(metaUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!metaRes.ok) {
      const err = await metaRes.text();
      throw new Error(`Sheets metadata failed: ${err}`);
    }
    const meta = await metaRes.json();
    const existing = new Set(
      (meta.sheets || [])
        .map((s) => s.properties?.title)
        .filter((title) => typeof title === 'string')
    );

    const toCreate = [...new Set(sheetNames.map((name) => String(name).trim()).filter(Boolean))]
      .filter((name) => !existing.has(name));

    if (toCreate.length === 0) {
      return res.json({ ok: true, created: [] });
    }

    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const batchRes = await googleSheetsFetch(batchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: toCreate.map((title) => ({ addSheet: { properties: { title } } }))
      })
    });
    if (!batchRes.ok) {
      const err = await batchRes.text();
      throw new Error(`Sheets ensureTabs failed: ${err}`);
    }
    res.json({ ok: true, created: toCreate });
  } catch (err) {
    next(err);
  }
});

// Google Sheets - batchUpdate (delete rows via DeleteDimension; rowIndices 1-based, applied descending)
app.post('/api/google/sheets/batchUpdate', requireAuth, async (req, res, next) => {
  try {
    const { spreadsheetId, operations } = req.body;
    if (!spreadsheetId || !Array.isArray(operations)) {
      return res.status(400).json({ error: 'spreadsheetId and operations array are required' });
    }
    const tokens = await getValidGoogleTokens(req.userId);
    if (!tokens) return res.status(400).json({ error: 'Google not connected' });

    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`;
    const metaRes = await googleSheetsFetch(metaUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (!metaRes.ok) {
      const err = await metaRes.text();
      throw new Error(`Sheets metadata failed: ${err}`);
    }
    const meta = await metaRes.json();
    const nameToId = {};
    for (const s of meta.sheets || []) {
      const title = s.properties?.title;
      if (title != null) nameToId[title] = s.properties.sheetId;
    }

    const requests = [];
    for (const op of operations) {
      if (op.type !== 'deleteRows' || !op.sheetName || !Array.isArray(op.rowIndices)) continue;
      const sheetId = nameToId[op.sheetName];
      if (!(op.sheetName in nameToId)) {
        return res.status(400).json({ error: `Sheet not found: ${op.sheetName}` });
      }
      const sorted = [...op.rowIndices].filter((r) => Number.isInteger(r) && r >= 2).sort((a, b) => b - a);
      for (const oneBasedRow of sorted) {
        const startIndex = oneBasedRow - 1;
        const endIndex = oneBasedRow;
        requests.push({
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex, endIndex }
          }
        });
      }
    }

    if (requests.length === 0) {
      return res.json({ ok: true });
    }
    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`;
    const batchRes = await googleSheetsFetch(batchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ requests })
    });
    if (!batchRes.ok) {
      const err = await batchRes.text();
      throw new Error(`Sheets batchUpdate failed: ${err}`);
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Create Plaid Link token (requires auth + TMM+)
app.post(
  '/api/plaid/create-link-token',
  requireAuth,
  requireTmmPlus,
  createLinkTokenRateLimit,
  validateBody(schemas.createLinkTokenBody),
  async (req, res, next) => {
  try {
    const userId = req.userId;

    if (!req.body?.update_item_id) {
      const connectedItemIds = await listItemIdsForUser(userId);
      const currentCount = connectedItemIds.length;
      if (currentCount >= PLAID_ITEM_SAFETY_CEILING) {
        console.warn(JSON.stringify({
          type: 'plaid_item_cap_hit',
          requestId: req.requestId || 'unknown',
          userId,
          hitType: 'safety_ceiling',
          currentCount,
          cap: PLAID_ITEM_SAFETY_CEILING,
          timestamp: new Date().toISOString()
        }));
        return res.status(403).json({
          error: `Unable to add another institution right now. Internal safety ceiling (${PLAID_ITEM_SAFETY_CEILING}) reached.`,
          code: 'PLAID_ITEM_SAFETY_CEILING',
          current_count: currentCount,
          cap: PLAID_ITEM_SAFETY_CEILING
        });
      }
      if (currentCount >= PLAID_ITEM_CAP) {
        console.warn(JSON.stringify({
          type: 'plaid_item_cap_hit',
          requestId: req.requestId || 'unknown',
          userId,
          hitType: 'user_cap',
          currentCount,
          cap: PLAID_ITEM_CAP,
          timestamp: new Date().toISOString()
        }));
        return res.status(403).json({
          error: `You've reached the ${PLAID_ITEM_CAP} connection limit. Disconnect an institution to add another.`,
          code: 'PLAID_ITEM_CAP_REACHED',
          current_count: currentCount,
          cap: PLAID_ITEM_CAP
        });
      }
    }
    
    const request = {
      user: {
        client_user_id: userId,
      },
      client_name: 'Money Machine',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    };
    if (req.body?.update_item_id) {
      let accessToken;
      try {
        accessToken = await getToken(req.body.update_item_id, userId);
      } catch (err) {
        if (err.message && err.message.includes('Token not found')) {
          return res.status(404).json({ error: 'Item not found or disconnected for update mode' });
        }
        throw err;
      }
      request.access_token = accessToken;
      if (req.body.account_selection_enabled === true) {
        request.update = { account_selection_enabled: true };
      }
    }
    if (process.env.PLAID_WEBHOOK_URL) {
      request.webhook = process.env.PLAID_WEBHOOK_URL;
    }

    const response = await plaidClient.linkTokenCreate(request);
    const plaidRequestId = getPlaidResponseRequestId(response);
    console.log(JSON.stringify({
      type: 'plaid_link_token_created',
      requestId: req.requestId || 'unknown',
      userId,
      plaidRequestId,
      updateMode: Boolean(req.body?.update_item_id),
      timestamp: new Date().toISOString()
    }));
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    next(err);
  }
});

app.post(
  '/api/plaid/link-telemetry',
  requireAuth,
  requireTmmPlus,
  validateBody(schemas.linkTelemetryBody),
  async (req, res, next) => {
  try {
    const userId = req.userId;
    const payload = req.body || {};
    console.log(JSON.stringify({
      type: 'plaid_link_telemetry',
      requestId: req.requestId || 'unknown',
      userId,
      eventType: payload.event_type,
      eventName: payload.event_name || null,
      viewName: payload.view_name || null,
      status: payload.status || null,
      reason: payload.reason || null,
      institutionId: payload.institution_id || null,
      institutionName: payload.institution_name || null,
      linkSessionId: payload.link_session_id || null,
      plaidRequestId: payload.request_id || null,
      errorCode: payload.error_code || null,
      errorType: payload.error_type || null,
      exitStatus: payload.exit_status || null,
      linkIntentId: payload.link_intent_id || null,
      itemId: payload.item_id || null,
      duplicateItem: payload.duplicate_item === true,
      isUpdateMode: payload.is_update_mode === true,
      metadata: payload.metadata || null,
      timestamp: new Date().toISOString()
    }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// List Plaid items (institutions) for the authenticated user (requires auth + TMM+)
app.get(
  '/api/plaid/items',
  requireAuth,
  requireTmmPlus,
  createListPlaidItemsHandler({ supabaseAdmin, itemCap: PLAID_ITEM_CAP })
);

app.get('/api/plaid/item-status', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const statuses = await getPlaidItemStatusesForUser(req.userId);
    res.json({ statuses });
  } catch (err) {
    next(err);
  }
});

app.get('/api/privacy/consent-status', requireAuth, async (req, res, next) => {
  try {
    const latest = await getLatestConsent(req.userId, PLAID_CONSENT_TYPE);
    const hasAcceptedOlderVersion =
      !!latest &&
      latest.accepted === true &&
      latest.policy_version !== CURRENT_PRIVACY_POLICY_VERSION;
    const accepted =
      !!latest &&
      latest.accepted === true &&
      latest.policy_version === CURRENT_PRIVACY_POLICY_VERSION;
    res.json({
      consent_type: PLAID_CONSENT_TYPE,
      policy_version: CURRENT_PRIVACY_POLICY_VERSION,
      accepted,
      requires_reconsent: hasAcceptedOlderVersion,
      latest
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/privacy/consent', requireAuth, validateBody(schemas.privacyConsentBody), async (req, res, next) => {
  try {
    const consent = await recordPrivacyConsent({
      userId: req.userId,
      consentType: req.body.consent_type,
      policyVersion: req.body.policy_version,
      accepted: req.body.accepted,
      metadata: { source: 'frontend' }
    });
    res.json({ ok: true, consent });
  } catch (err) {
    next(err);
  }
});

app.post('/api/privacy/delete-account', requireAuth, validateBody(schemas.deleteAccountBody), async (req, res, next) => {
  const userId = req.userId;
  const confirmText = String(req.body.confirm_text || '').trim().toUpperCase();
  if (confirmText !== 'DELETE MY DATA') {
    return res.status(400).json({ error: "confirm_text must be exactly 'DELETE MY DATA'" });
  }

  let deletionRequest = null;
  try {
    deletionRequest = await createDeletionRequest(userId, {
      reason: req.body.reason || null,
      requested_via: 'api'
    });

    const itemIds = await listItemIdsForUser(userId);
    for (const itemId of itemIds) {
      try {
        const accessToken = await getToken(itemId, userId);
        await plaidClient.itemRemove({ access_token: accessToken });
      } catch (err) {
        console.warn(`[privacy] Plaid item/remove failed for ${itemId}:`, err?.message || err);
      }
      try {
        await removeToken(itemId, userId);
      } catch (err) {
        console.warn(`[privacy] removeToken failed for ${itemId}:`, err?.message || err);
      }
    }

    await Promise.all([
      bestEffortDeleteByUser('privacy_consents', userId),
      bestEffortDeleteByUser('plaid_webhook_events', userId),
      bestEffortDeleteByUser('plaid_item_status', userId),
      bestEffortDeleteByUser('plaid_sync_runs', userId),
      bestEffortDeleteByUser('history_reconciliation_overrides', userId),
      bestEffortDeleteByUser('net_worth_points', userId),
      bestEffortDeleteByUser('account_balance_snapshots', userId),
      bestEffortDeleteByUser('accounts', userId),
      bestEffortDeleteByUser('plaid_tokens', userId),
      bestEffortDeleteByUser('google_sheets_tokens', userId),
      bestEffortDeleteByUser('user_onboarding', userId),
      bestEffortDeleteByUser('profiles', userId)
    ]);

    // Legacy table from early schema migration (best effort).
    try {
      await supabaseAdmin.from('users').delete().eq('id', userId);
    } catch (_) {
      // Ignore missing legacy table.
    }

    if (deletionRequest?.id) {
      await completeDeletionRequest(deletionRequest.id);
    }
    // Final auth user deletion (cascades remaining auth-scoped rows).
    await supabaseAdmin.auth.admin.deleteUser(userId);

    res.json({ ok: true, deleted: true });
  } catch (err) {
    if (deletionRequest?.id) {
      try {
        await failDeletionRequest(deletionRequest.id, err?.message || 'unknown deletion error');
      } catch (statusErr) {
        console.error('[privacy] Failed to set deletion request failure status:', statusErr?.message || statusErr);
      }
    }
    next(err);
  }
});

app.post(
  '/api/auth/mfa/remove-factor',
  requireAuth,
  validateBody(schemas.mfaRemoveFactorBody),
  async (req, res, next) => {
    try {
      if (!supabaseAdmin) {
        return res.status(503).json({
          error: 'Service unavailable',
          message: 'MFA management is not available'
        });
      }
      const userId = req.userId;
      const factorId = req.body.factor_id;
      const { data, error } = await supabaseAdmin.auth.admin.mfa.deleteFactor({
        id: factorId,
        userId
      });
      if (error) {
        return res.status(400).json({
          error: 'Failed to remove MFA factor',
          message: error.message
        });
      }
      res.json({ ok: true, removed: data?.id ?? factorId });
    } catch (err) {
      next(err);
    }
  }
);

app.get('/api/ops/plaid/health', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const userId = req.userId;
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [syncRuns, webhookEvents, itemStatuses, breaker, jobs] = await Promise.all([
      getRecentPlaidSyncRuns(userId, 50),
      getRecentPlaidWebhookEvents(userId, sinceIso, 200),
      getPlaidItemStatusesForUser(userId),
      getPlaidCircuitBreaker(),
      getRecentPlaidSyncJobs({ limit: 200 })
    ]);

    const failedSyncRuns = syncRuns.filter((run) => run.status === 'failed');
    const actionRequiredItems = itemStatuses.filter((item) => item.needs_update_mode);
    const userJobs = jobs.filter((job) => job.user_id === userId);
    const jobsByStatus = userJobs.reduce((acc, job) => {
      const key = job.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const webhookCountsByStatus = webhookEvents.reduce((acc, event) => {
      const key = event.status || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    res.json({
      window: 'last_24h',
      generated_at: new Date().toISOString(),
      sync_runs_total: syncRuns.length,
      sync_runs_failed: failedSyncRuns.length,
      webhooks_total: webhookEvents.length,
      webhooks_by_status: webhookCountsByStatus,
      sync_jobs_total: userJobs.length,
      sync_jobs_by_status: jobsByStatus,
      circuit_breaker: {
        state: breaker?.state || 'closed',
        reason: breaker?.reason || null,
        next_try_at: breaker?.next_try_at || null,
        failure_count_window: breaker?.failure_count_window || 0
      },
      item_status_total: itemStatuses.length,
      item_status_action_required: actionRequiredItems.length,
      action_required_items: actionRequiredItems.map((item) => ({
        item_id: item.item_id,
        status: item.status,
        last_error_code: item.last_error_code,
        last_webhook_code: item.last_webhook_code,
        last_webhook_at: item.last_webhook_at
      }))
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/ops/plaid/jobs', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const status = req.query?.status ? String(req.query.status) : null;
    const limit = req.query?.limit ? Number(req.query.limit) : 100;
    const rows = await getRecentPlaidSyncJobs({ status, limit });
    const mine = rows.filter((r) => r.user_id === req.userId);
    res.json({ jobs: mine });
  } catch (err) {
    next(err);
  }
});

app.post('/api/ops/plaid/dev/webhook-smoke', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    if (config.env === 'production') {
      return res.status(403).json({ error: 'Not available in production runtime' });
    }

    const plaidEnvironment = String(config.plaid.environment || 'sandbox').toLowerCase();
    const acknowledgedProd = parseBooleanFlag(process.env.I_ACK_PROD, false);
    if (plaidEnvironment === 'production' && !acknowledgedProd) {
      return res.status(403).json({
        error: 'Production Plaid smoke checks require I_ACK_PROD=true'
      });
    }

    const webhookUrl = String(process.env.PLAID_WEBHOOK_URL || '').trim();
    if (!/^https:\/\//i.test(webhookUrl) || !/\/api\/webhooks\/plaid$/i.test(webhookUrl)) {
      return res.status(400).json({
        error: 'PLAID_WEBHOOK_URL must be set to https://<host>/api/webhooks/plaid'
      });
    }

    const requestedItemIds = Array.isArray(req.body?.item_ids)
      ? req.body.item_ids
        .map((itemId) => String(itemId || '').trim())
        .filter(Boolean)
      : [];
    const requestFireSandboxSync = parseBooleanFlag(req.body?.fire_sandbox_sync, false);
    const fireSandboxSync = plaidEnvironment === 'sandbox' && requestFireSandboxSync;
    const userId = req.userId;

    const connectedItemIds = await listItemIdsForUser(userId);
    const connectedSet = new Set(connectedItemIds);
    const targetItemIds = (requestedItemIds.length > 0 ? requestedItemIds : connectedItemIds)
      .filter((itemId, index, arr) => arr.indexOf(itemId) === index)
      .filter((itemId) => connectedSet.has(itemId));

    if (targetItemIds.length === 0) {
      return res.status(404).json({
        error: 'No connected Plaid items found for this user'
      });
    }

    const results = [];
    for (const itemId of targetItemIds) {
      const itemResult = {
        item_id: itemId,
        webhook_update_ok: false,
        webhook_update_request_id: null,
        sandbox_fire_ok: false,
        sandbox_fire_request_id: null,
        error: null
      };
      try {
        const accessToken = await getToken(itemId, userId);
        const updateRes = await plaidClient.itemWebhookUpdate({
          access_token: accessToken,
          webhook: webhookUrl
        });
        itemResult.webhook_update_ok = true;
        itemResult.webhook_update_request_id = getPlaidResponseRequestId(updateRes);

        if (fireSandboxSync) {
          const fireRes = await plaidClient.sandboxItemFireWebhook({
            access_token: accessToken,
            webhook_type: 'TRANSACTIONS',
            webhook_code: 'SYNC_UPDATES_AVAILABLE'
          });
          itemResult.sandbox_fire_ok = true;
          itemResult.sandbox_fire_request_id = getPlaidResponseRequestId(fireRes);
        }
      } catch (err) {
        itemResult.error = {
          message: err?.message || 'Unknown error',
          plaid_request_id: getPlaidErrorRequestId(err),
          plaid_error_code: getPlaidErrorCode(err)
        };
      }
      results.push(itemResult);
    }

    const ok = results.every((result) => result.webhook_update_ok && (!fireSandboxSync || result.sandbox_fire_ok));
    res.status(ok ? 200 : 502).json({
      ok,
      plaid_environment: plaidEnvironment,
      fire_sandbox_sync: fireSandboxSync,
      item_count: targetItemIds.length,
      webhook_url: webhookUrl,
      results
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/plaid/sync/status', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const userId = req.userId;
    const now = new Date();
    const [activeJobs, itemStatuses] = await Promise.all([
      getUserActiveSyncJobs(userId, 25),
      getPlaidItemStatusesForUser(userId)
    ]);
    const activeJob = activeJobs[0] || null;
    res.json({
      running: activeJobs.length > 0,
      active_job: activeJob
        ? {
          job_id: activeJob.job_id,
          status: activeJob.status,
          started_at: activeJob.started_at || activeJob.created_at || null
        }
        : null,
      now_iso: now.toISOString(),
      sync_outer_gate_minutes: Math.max(1, PLAID_SYNC_OUTER_GATE_MINUTES),
      items: (itemStatuses || []).map((item) => ({
        item_id: item.item_id,
        status: item.status || null,
        needs_update_mode: !!item.needs_update_mode,
        last_sync_started_at: item.last_sync_started_at || null,
        last_sync_finished_at: item.last_sync_finished_at || null,
        sync_locked_until: item.sync_locked_until || null,
        cooldown_until: item.cooldown_until || null,
        next_eligible_at: computeNextEligibleSyncAt(item, now),
        last_error_code: item.last_error_code || null,
        last_webhook_code: item.last_webhook_code || null
      }))
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/ops/plaid/breaker', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const breaker = await getPlaidCircuitBreaker();
    res.json({ breaker });
  } catch (err) {
    next(err);
  }
});

// Get all stored accounts for the authenticated user (from DB; for listing and disconnected state)
app.get('/api/plaid/user-accounts', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const userId = req.userId;
    const { getAccountsByUserId } = await import('./models/account.js');
    const accounts = await getAccountsByUserId(userId);
    res.json({ accounts });
  } catch (err) {
    next(err);
  }
});

// Get items with nested accounts from DB only (no live Plaid API calls in this read endpoint).
app.get('/api/plaid/items-with-accounts', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const validation = await getValidationResponse('GET', '/api/plaid/items-with-accounts', req);
    if (validation) return res.json(validation);
    const userId = req.userId;
    const { getAccountsByUserId } = await import('./models/account.js');
    const [tokenRows, allAccounts, itemStatuses] = await Promise.all([
      supabaseAdmin.from('plaid_tokens').select('item_id, institution_name').eq('user_id', userId),
      getAccountsByUserId(userId),
      getPlaidItemStatusesForUser(userId)
    ]);
    const connectedItemIds = new Set((tokenRows.data || []).map((r) => r.item_id));
    const institutionNameByItem = new Map((tokenRows.data || []).map((r) => [r.item_id, r.institution_name || null]));
    const statusByItem = new Map((itemStatuses || []).map((s) => [s.item_id, s]));
    const byItem = new Map();
    for (const acc of allAccounts) {
      const itemId = acc.plaid_item_id;
      if (!byItem.has(itemId)) {
        byItem.set(itemId, {
          item_id: itemId,
          institution_name: institutionNameByItem.get(itemId) ?? null,
          connected: connectedItemIds.has(itemId),
          item_status: statusByItem.get(itemId) || null,
          accounts: []
        });
      }
      byItem.get(itemId).accounts.push({
        plaid_account_id: acc.plaid_account_id,
        name: acc.name,
        type: acc.type,
        subtype: acc.subtype,
        balance: acc.balance,
        currency_code: acc.currency_code,
        last_synced_at: acc.last_synced_at
      });
    }
    const now = new Date();
    const items = Array.from(byItem.values()).map((item) => {
      const itemStatus = item.item_status || null;
      const accounts = item.accounts.map((acc) => {
        const freshness = deriveAccountFreshness({
          itemConnected: item.connected,
          itemStatus,
          accountLastSyncedAt: acc.last_synced_at,
          now
        });
        return {
          ...acc,
          current: freshness.is_current, // Legacy compatibility for existing frontend mapping
          is_current: freshness.is_current,
          is_stale: freshness.is_stale,
          stale_reason: freshness.stale_reason
        };
      });
      return { ...item, accounts };
    });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.json({
      items,
      item_count: connectedItemIds.size,
      item_cap: PLAID_ITEM_CAP
    });
  } catch (err) {
    next(err);
  }
});

// Exchange public token for access token (requires authentication)
app.post(
  '/api/plaid/exchange-token',
  requireAuth,
  requireTmmPlus,
  exchangeTokenRateLimit,
  validateBody(schemas.exchangeTokenBody),
  async (req, res, next) => {
  try {
    const { public_token, link_intent_id, link_success_metadata, reconnect_item_id } = req.body;

    if (!public_token) {
      return res.status(400).json({ error: 'public_token is required' });
    }

    // Use authenticated user ID from middleware
    const userId = req.userId;
    if (PLAID_EXCHANGE_REQUIRE_LINK_INTENT && !link_intent_id) {
      return res.status(400).json({ error: 'link_intent_id is required' });
    }

    const linkIntentId = link_intent_id || null;
    if (linkIntentId) {
      const started = await startPlaidLinkIntent({
        userId,
        linkIntentId,
        requestId: req.requestId || null,
        publicToken: public_token
      });
      if (!started) {
        const existing = await getPlaidLinkIntent(userId, linkIntentId);
        if (existing?.status === 'completed' && existing?.result_json) {
          return res.json(existing.result_json);
        }
        if (existing?.status === 'started') {
          return res.status(202).json({
            status: 'in_progress',
            link_intent_id: linkIntentId
          });
        }
        if (existing?.status === 'failed') {
          return res.status(409).json({
            error: existing.error_message || 'Previous link intent failed',
            code: existing.error_code || 'LINK_INTENT_FAILED',
            link_intent_id: linkIntentId
          });
        }
      }
    }

    const duplicateItem = await findDuplicateConnectedItem({
      userId,
      linkSuccessMetadata: link_success_metadata,
      requestId: req.requestId || 'unknown'
    });
    if (duplicateItem) {
      const responsePayload = {
        duplicate_item: true,
        duplicate_item_id: duplicateItem.itemId,
        duplicate_reason: duplicateItem.reason,
        institution_id: duplicateItem.institutionId
      };
      console.log(JSON.stringify({
        type: 'plaid_exchange_token_duplicate_blocked',
        requestId: req.requestId || 'unknown',
        userId,
        duplicateItemId: duplicateItem.itemId,
        duplicateReason: duplicateItem.reason,
        institutionId: duplicateItem.institutionId,
        linkIntentId,
        timestamp: new Date().toISOString()
      }));
      if (linkIntentId) {
        await completePlaidLinkIntent({
          userId,
          linkIntentId,
          resultJson: responsePayload
        });
      }
      return res.json(responsePayload);
    }

    const breakerCheck = await ensurePlaidCircuitAllowsRequest();
    if (!breakerCheck.allowed) {
      return res.status(503).json({
        error: 'Plaid temporarily unavailable',
        code: 'PLAID_CIRCUIT_OPEN',
        next_try_at: breakerCheck.breaker?.next_try_at || null
      });
    }

    const request = {
      public_token: public_token
    };

    const response = await plaidClient.itemPublicTokenExchange(request);
    const plaidRequestIdExchange = getPlaidResponseRequestId(response);
    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;
    const institutionId = link_success_metadata?.institution_id || null;
    const institutionName = link_success_metadata?.institution_name || null;
    const reconnectItemId = reconnect_item_id ? String(reconnect_item_id).trim() : null;

    const accountsResponse = await plaidClient.accountsGet({ access_token: accessToken });
    const plaidRequestIdAccountsGet = getPlaidResponseRequestId(accountsResponse);
    const plaidAccounts = accountsResponse.data.accounts || [];

    if (reconnectItemId) {
      const oldAccounts = await getAccountsByUserAndItemId(userId, reconnectItemId);
      const accountIdMapping =
        oldAccounts.length > 0 && plaidAccounts.length > 0
          ? buildReconnectAccountIdMapping(oldAccounts, plaidAccounts)
          : {};
      await storeToken(reconnectItemId, accessToken, userId);
      await updatePlaidTokenInstitution(userId, reconnectItemId, { institutionId, institutionName });
      await deleteAccountsByUserAndItemId(userId, reconnectItemId);
      if (plaidAccounts.length > 0) {
        await upsertAccountsForItem(userId, reconnectItemId, plaidAccounts);
      }
      await setPlaidItemHealthy(userId, reconnectItemId, {
        trigger: 'exchange_token_reconnect'
      });
      await recordPlaidConnectionEvent({
        userId,
        itemId: reconnectItemId,
        eventType: 'connect',
        connectionType: 'reconnect',
        institutionId,
        metadata: {
          link_intent_id: linkIntentId || null,
          plaid_request_id_exchange: plaidRequestIdExchange,
          plaid_request_id_accounts_get: plaidRequestIdAccountsGet,
          from_item_id: itemId
        }
      });
      console.log(JSON.stringify({
        type: 'plaid_exchange_token_reconnect',
        requestId: req.requestId || 'unknown',
        userId,
        plaidRequestIdExchange,
        plaidRequestIdAccountsGet,
        oldItemId: reconnectItemId,
        newItemId: itemId,
        mappedAccounts: Object.keys(accountIdMapping || {}).length,
        linkIntentId,
        timestamp: new Date().toISOString()
      }));
      const responsePayload = Object.keys(accountIdMapping || {}).length > 0
        ? { item_id: reconnectItemId, account_id_mapping: accountIdMapping }
        : { item_id: reconnectItemId };
      if (linkIntentId) {
        await completePlaidLinkIntent({
          userId,
          linkIntentId,
          resultJson: responsePayload
        });
      }
      await recordPlaidCircuitSuccess();
      return res.json(responsePayload);
    }

    // Check for orphan items (accounts without tokens) and attempt to reconnect in place.
    let matchedOrphanId = null;
    let matchedOldAccounts = null;
    let accountIdMapping = null;
    if (plaidAccounts.length > 0) {
      const [tokenRows, itemIdsWithAccounts] = await Promise.all([
        supabaseAdmin.from('plaid_tokens').select('item_id').eq('user_id', userId),
        getItemIdsWithAccounts(userId)
      ]);
      const connectedItemIds = new Set((tokenRows.data || []).map((r) => r.item_id));
      const orphanItemIds = (itemIdsWithAccounts || []).filter((id) => id && !connectedItemIds.has(id));

      for (const orphanItemId of orphanItemIds) {
        const oldAccounts = await getAccountsByUserAndItemId(userId, orphanItemId);
        if (!oldAccounts || oldAccounts.length === 0) continue;
        if (oldAccounts.length !== plaidAccounts.length) continue;

        const mapping = buildReconnectAccountIdMapping(oldAccounts, plaidAccounts);
        for (const oldAcc of oldAccounts) {
          if (!mapping[oldAcc.plaid_account_id]) {
            const sameId = plaidAccounts.find((acc) => acc.account_id === oldAcc.plaid_account_id);
            if (sameId) mapping[oldAcc.plaid_account_id] = oldAcc.plaid_account_id;
          }
        }

        if (Object.keys(mapping).length === oldAccounts.length) {
          matchedOrphanId = orphanItemId;
          matchedOldAccounts = oldAccounts;
          accountIdMapping = mapping;
          break;
        }
      }
    }

    if (matchedOrphanId && matchedOldAccounts && accountIdMapping) {
      await storeToken(matchedOrphanId, accessToken, userId);
      await updatePlaidTokenInstitution(userId, matchedOrphanId, { institutionId, institutionName });
      for (const oldAcc of matchedOldAccounts) {
        const newPlaidId = accountIdMapping[oldAcc.plaid_account_id];
        const newPlaidAcc = plaidAccounts.find((acc) => acc.account_id === newPlaidId);
        if (newPlaidAcc) {
          await updateAccountFromPlaidData(oldAcc.id, newPlaidAcc);
        }
      }
      await setPlaidItemHealthy(userId, matchedOrphanId, {
        trigger: 'exchange_token_orphan_reconnect'
      });
      await recordPlaidConnectionEvent({
        userId,
        itemId: matchedOrphanId,
        eventType: 'connect',
        connectionType: 'reconnect',
        institutionId,
        metadata: {
          link_intent_id: linkIntentId || null,
          plaid_request_id_exchange: plaidRequestIdExchange,
          plaid_request_id_accounts_get: plaidRequestIdAccountsGet,
          from_item_id: itemId
        }
      });
      console.log(JSON.stringify({
        type: 'plaid_exchange_token_reconnect',
        requestId: req.requestId || 'unknown',
        userId,
        plaidRequestIdExchange,
        plaidRequestIdAccountsGet,
        oldItemId: matchedOrphanId,
        newItemId: itemId,
        mappedAccounts: Object.keys(accountIdMapping).length,
        linkIntentId,
        timestamp: new Date().toISOString()
      }));
      const responsePayload = {
        item_id: matchedOrphanId,
        account_id_mapping: accountIdMapping
      };
      if (linkIntentId) {
        await completePlaidLinkIntent({
          userId,
          linkIntentId,
          resultJson: responsePayload
        });
      }
      await recordPlaidCircuitSuccess();
      return res.json({
        ...responsePayload
      });
    }

    const recentNewConnections = await getRecentNewConnections(userId);
    if (recentNewConnections.length >= PLAID_NEW_CONNECTIONS_PER_7_DAYS) {
      const retryAfterDate = computeConnectionRetryAfterDate(recentNewConnections);
      console.warn(JSON.stringify({
        type: 'plaid_weekly_cap_hit',
        requestId: req.requestId || 'unknown',
        userId,
        newConnectionsThisWeek: recentNewConnections.length,
        cap: PLAID_NEW_CONNECTIONS_PER_7_DAYS,
        retryAfterDate,
        timestamp: new Date().toISOString()
      }));
      if (linkIntentId) {
        await failPlaidLinkIntent({
          userId,
          linkIntentId,
          errorCode: 'PLAID_CONNECTION_STABILITY_LIMIT',
          errorMessage: 'Connection Stability Policy limit reached'
        });
      }
      return res.status(429).json({
        error: retryAfterDate
          ? `You can add another connection on ${retryAfterDate.slice(0, 10)}.`
          : 'Connection Stability Policy limit reached. Please try again later.',
        code: 'PLAID_CONNECTION_STABILITY_LIMIT',
        retry_after_date: retryAfterDate ? retryAfterDate.slice(0, 10) : null,
        new_connections_this_week: recentNewConnections.length
      });
    }

    // Store the access token securely with authenticated user ID (default path)
    await storeToken(itemId, accessToken, userId);
    await updatePlaidTokenInstitution(userId, itemId, { institutionId, institutionName });

    // Persist sub-accounts to accounts table for this item
    if (plaidAccounts.length > 0) {
      await upsertAccountsForItem(userId, itemId, plaidAccounts);
    }
    await recordPlaidConnectionEvent({
      userId,
      itemId,
      eventType: 'connect',
      connectionType: 'new',
      institutionId,
      metadata: {
        link_intent_id: linkIntentId || null,
        plaid_request_id_exchange: plaidRequestIdExchange,
        plaid_request_id_accounts_get: plaidRequestIdAccountsGet
      }
    });
    await setPlaidItemHealthy(userId, itemId, { trigger: 'exchange_token' });
    console.log(JSON.stringify({
      type: 'plaid_exchange_token_success',
      requestId: req.requestId || 'unknown',
      userId,
      plaidRequestIdExchange,
      plaidRequestIdAccountsGet,
      itemId,
      accountsUpserted: plaidAccounts.length,
      linkIntentId,
      timestamp: new Date().toISOString()
    }));
    const responsePayload = { item_id: itemId };
    if (linkIntentId) {
      await completePlaidLinkIntent({
        userId,
        linkIntentId,
        resultJson: responsePayload
      });
    }
    await recordPlaidCircuitSuccess();

    res.json({
      ...responsePayload
      // Do NOT return access_token to client for security
    });
  } catch (err) {
    console.error(JSON.stringify({
      type: 'plaid_exchange_token_error',
      requestId: req.requestId || 'unknown',
      userId: req.userId || null,
      plaidRequestId: getPlaidErrorRequestId(err),
      errorCode: getPlaidErrorCode(err) || err.code || null,
      message: err?.message || 'Unknown error',
      timestamp: new Date().toISOString()
    }));
    if (getPlaidErrorCode(err) || isPlaidFailureForBreaker(err)) {
      try {
        await recordPlaidCircuitFailure({
          reason: getPlaidErrorCode(err) || err.code || 'plaid_exchange_failure'
        });
      } catch (breakerErr) {
        console.error('Failed to update breaker on exchange-token failure:', breakerErr.message);
      }
    }
    const { link_intent_id } = req.body || {};
    if (link_intent_id && req.userId) {
      try {
        await failPlaidLinkIntent({
          userId: req.userId,
          linkIntentId: link_intent_id,
          errorCode: getPlaidErrorCode(err) || err.code || 'PLAID_EXCHANGE_FAILED',
          errorMessage: err?.message || 'Unknown error'
        });
      } catch (intentErr) {
        console.error('Failed to mark link intent as failed:', intentErr.message);
      }
    }
    next(err);
  }
});

app.get('/api/plaid/link-intents/:link_intent_id', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const userId = req.userId;
    const linkIntentId = String(req.params.link_intent_id || '').trim();
    if (!linkIntentId) {
      return res.status(400).json({ error: 'link_intent_id is required' });
    }
    const row = await getPlaidLinkIntent(userId, linkIntentId);
    if (!row) {
      return res.status(404).json({ error: 'Link intent not found' });
    }
    return res.json({
      link_intent_id: linkIntentId,
      status: row.status,
      result: row.result_json || null,
      error_code: row.error_code || null,
      error_message: row.error_message || null
    });
  } catch (err) {
    next(err);
  }
});

// Build old_plaid_account_id -> new_plaid_account_id mapping for reconnect (so frontend can remap plan.connectedAccountId).
// Match by persistent_account_id when both have it; else by (type, subtype, mask). Tiebreaker: first match by index/order.
function buildReconnectAccountIdMapping(oldAccounts, newPlaidAccounts) {
  const mapping = {};
  const newByPersistent = new Map();
  const newByKey = new Map(); // key = type|subtype|mask for fallback
  for (const a of newPlaidAccounts) {
    if (a.persistent_account_id) newByPersistent.set(a.persistent_account_id, a);
    const k = `${a.type || ''}|${a.subtype || ''}|${a.mask || ''}`;
    if (!newByKey.has(k)) newByKey.set(k, []);
    newByKey.get(k).push(a);
  }
  const usedNewIds = new Set();
  for (const old of oldAccounts) {
    let newAcc = null;
    if (old.persistent_account_id && newByPersistent.has(old.persistent_account_id)) {
      newAcc = newByPersistent.get(old.persistent_account_id);
    }
    if (!newAcc) {
      const k = `${old.type || ''}|${old.subtype || ''}|${old.mask || ''}`;
      const candidates = newByKey.get(k) || [];
      newAcc = candidates.find((c) => !usedNewIds.has(c.account_id)) || candidates[0];
    }
    if (newAcc && newAcc.account_id !== old.plaid_account_id) {
      mapping[old.plaid_account_id] = newAcc.account_id;
      usedNewIds.add(newAcc.account_id);
    }
  }
  return mapping;
}

// Reconnect in place: move token and accounts from new_item_id to old_item_id so the same group is restored (no duplicate).
// Returns account_id_mapping (old_plaid_account_id -> new_plaid_account_id) so the frontend can remap plan.connectedAccountId.
app.post(
  '/api/plaid/reconnect-in-place',
  requireAuth,
  requireTmmPlus,
  validateBody(schemas.reconnectInPlaceBody),
  async (req, res, next) => {
  try {
    const { old_item_id, new_item_id } = req.body;
    const userId = req.userId;
    if (!old_item_id || !new_item_id || old_item_id === new_item_id) {
      return res.status(400).json({ error: 'old_item_id and new_item_id are required and must differ' });
    }
    const {
      getAccountsByUserAndItemId,
      upsertAccountsForItem,
      deleteAccountsByUserAndItemId
    } = await import('./models/account.js');

    const oldAccounts = await getAccountsByUserAndItemId(userId, old_item_id);
    const accessToken = await getToken(new_item_id, userId);
    const plaidRes = await plaidClient.accountsGet({ access_token: accessToken });
    const plaidRequestIdAccountsGet = getPlaidResponseRequestId(plaidRes);
    const newPlaidAccounts = plaidRes.data.accounts || [];

    const account_id_mapping = buildReconnectAccountIdMapping(oldAccounts, newPlaidAccounts);

    await storeToken(old_item_id, accessToken, userId);
    await removeToken(new_item_id, userId);

    await deleteAccountsByUserAndItemId(userId, old_item_id);
    if (newPlaidAccounts.length > 0) {
      await upsertAccountsForItem(userId, old_item_id, newPlaidAccounts);
    }
    await deleteAccountsByUserAndItemId(userId, new_item_id);
    await setPlaidItemHealthy(userId, old_item_id, { trigger: 'reconnect_in_place' });
    await removePlaidItemStatus(userId, new_item_id);

    console.log(JSON.stringify({
      type: 'plaid_reconnect_in_place',
      requestId: req.requestId || 'unknown',
      userId,
      plaidRequestIdAccountsGet,
      oldItemId: old_item_id,
      newItemId: new_item_id,
      accountsFetched: newPlaidAccounts.length,
      timestamp: new Date().toISOString()
    }));
    res.json({ ok: true, item_id: old_item_id, account_id_mapping });
  } catch (err) {
    next(err);
  }
});

// Remove a Plaid item (all its accounts) for this user. Use when user chooses to remove a "Plaid Connection Lost" group.
app.post(
  '/api/plaid/remove-item',
  requireAuth,
  requireTmmPlus,
  validateBody(schemas.plaidItemBody),
  async (req, res, next) => {
  try {
    const { item_id } = req.body;
    const userId = req.userId;
    if (!item_id) {
      return res.status(400).json({ error: 'item_id is required' });
    }
    // Full removal (BUG-3): revokes at Plaid and deletes the token row.
    // See removePlaidItemForUser for the remove-item vs disconnect contract.
    await removePlaidItemForUser(
      {
        getToken,
        removeToken,
        plaidClient,
        createArchiveSnapshotForItem,
        deleteAccountsByUserAndItemId,
        removePlaidItemStatus,
        recordPlaidConnectionEvent
      },
      { userId, itemId: item_id }
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Remove a single Plaid account (one sub-account) for this user. Use when user removes one CFA from the list.
app.post(
  '/api/plaid/remove-account',
  requireAuth,
  requireTmmPlus,
  validateBody(schemas.plaidAccountBody),
  async (req, res, next) => {
  try {
    const { plaid_account_id } = req.body;
    const userId = req.userId;
    if (!plaid_account_id) {
      return res.status(400).json({ error: 'plaid_account_id is required' });
    }
    const { deleteAccountByUserAndPlaidAccountId } = await import('./models/account.js');
    await deleteAccountByUserAndPlaidAccountId(userId, plaid_account_id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Fetch accounts for an item (requires auth + TMM+, token must belong to user)
app.post('/api/plaid/accounts', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const { item_id } = req.body;
    const userId = req.userId;
    
    if (!item_id) {
      return res.status(400).json({ error: 'item_id is required' });
    }
    
    // Get access token from storage (user-scoped)
    const accessToken = await getToken(item_id, userId);
    
    const request = {
      access_token: accessToken,
    };
    
    const response = await plaidClient.accountsGet(request);
    res.json({ accounts: response.data.accounts });
  } catch (err) {
    if (err.message && err.message.includes('Token not found')) {
      return res.status(404).json({ error: 'Item not found or disconnected' });
    }
    next(err);
  }
});

// Fetch account balance (requires authentication)
app.post('/api/plaid/balance', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const { item_id, account_id } = req.body;
    
    if (!item_id) {
      return res.status(400).json({ error: 'item_id is required' });
    }
    
    // Use authenticated user ID from middleware
    const userId = req.userId;
    
    // Get access token from storage (validated for this user)
    const accessToken = await getToken(item_id, userId);
    
    const request = {
      access_token: accessToken,
    };
    
    // If account_id is provided, filter to that account
    if (account_id) {
      request.options = {
        account_ids: [account_id],
      };
    }
    
    const response = await plaidClient.accountsBalanceGet(request);
    
    // If account_id was specified, find that specific account
    if (account_id) {
      const account = response.data.accounts.find(acc => acc.account_id === account_id);
      if (account) {
        return res.json({
          balance: account.balances.current || 0,
          accounts: [account]
        });
      }
      return res.status(404).json({ error: 'Account not found' });
    }
    
    // Return all accounts
    res.json({
      accounts: response.data.accounts,
      balance: response.data.accounts.reduce((sum, acc) => sum + (acc.balances.current || 0), 0)
    });
  } catch (err) {
    if (err.message && err.message.includes('Token not found')) {
      return res.status(404).json({ error: 'Item not found or disconnected' });
    }
    next(err);
  }
});

// Fetch transactions (requires authentication)
app.post(
  '/api/plaid/transactions/sync',
  requireAuth,
  requireTmmPlus,
  syncRateLimit,
  validateBody(schemas.transactionsSyncBody),
  async (req, res, next) => {
  try {
    const validation = await getValidationResponse('POST', '/api/plaid/transactions/sync', req);
    if (validation) return res.json(validation);
    const { item_id, force_refresh, user_initiated } = req.body || {};
    const debugMode = String(req.query?.debug || '').trim() === '1';
    const userId = req.userId;
    const userInitiated = !!user_initiated;
    const forceRefreshRequested = !!force_refresh;
    const forceRefresh = forceRefreshRequested && PLAID_ALLOW_FORCE_REFRESH && config.env !== 'production';
    const now = new Date();
    const connectedItemIds = await listItemIdsForUser(userId);

    if (item_id && !connectedItemIds.includes(item_id)) {
      return res.status(404).json({ error: 'Item not found or disconnected' });
    }

    const activeJobs = await getUserActiveSyncJobs(userId, 25);
    if (activeJobs.length > 0) {
      const activeJobIds = activeJobs.map((job) => job.job_id).filter(Boolean);
      return res.status(202).json({
        ok: true,
        already_running: true,
        queued: false,
        running: true,
        job_id: activeJobIds[0] || null,
        job_ids: activeJobIds
      });
    }

    const itemStatuses = await getPlaidItemStatusesForUser(userId);
    const statusByItem = new Map((itemStatuses || []).map((status) => [status.item_id, status]));
    const timezone = await getHistoryTimezoneForUser(userId);
    const mostRecentSync = getMostRecentItemSyncAt(itemStatuses);
    const todayLocal = getLocalDateString(now, timezone);
    const lastSyncLocal = mostRecentSync ? getLocalDateString(mostRecentSync, timezone) : null;
    const firstOpenOfDayOverride = !!lastSyncLocal && !!todayLocal && lastSyncLocal < todayLocal;
    const bypassGates = userInitiated || forceRefresh || firstOpenOfDayOverride;

    if (!bypassGates) {
      const outerWindowMs = Math.max(1, PLAID_SYNC_OUTER_GATE_MINUTES) * 60 * 1000;
      if (mostRecentSync && (now.getTime() - mostRecentSync.getTime()) < outerWindowMs) {
        const payload = {
          ok: false,
          skipped: true,
          reason: 'outer_gate',
          message: 'Sync was skipped because a sync attempt ran recently. Try again later or use Refresh bank data.',
          first_open_of_day_override: firstOpenOfDayOverride,
          most_recent_sync_at: mostRecentSync?.toISOString() || null,
          sync_outer_gate_minutes: Math.max(1, PLAID_SYNC_OUTER_GATE_MINUTES)
        };
        if (debugMode) return res.status(200).json(payload);
        return res.status(200).json(payload);
      }
    }

    const targetItemIds = item_id ? [item_id] : connectedItemIds;
    const eligibleItemIds = [];
    const skippedItems = [];
    for (const id of targetItemIds) {
      const status = statusByItem.get(id) || null;
      if (status?.needs_update_mode || status?.status === 'action_required') {
        skippedItems.push({ item_id: id, reason: 'needs_update' });
        continue;
      }
      if (isFutureIso(status?.sync_locked_until, now)) {
        skippedItems.push({ item_id: id, reason: 'locked' });
        continue;
      }
      if (isFutureIso(status?.cooldown_until, now)) {
        skippedItems.push({ item_id: id, reason: 'cooldown' });
        continue;
      }
      if (!bypassGates && isItemFresh(status, now)) {
        skippedItems.push({ item_id: id, reason: 'fresh' });
        continue;
      }
      eligibleItemIds.push(id);
    }

    if (eligibleItemIds.length === 0) {
      if (userInitiated && targetItemIds.length > 0) {
        const refreshTargets = targetItemIds.filter((id) => {
          const status = statusByItem.get(id) || null;
          return !(status?.needs_update_mode || status?.status === 'action_required');
        });
        const accountsRefresh = [];
        for (const id of refreshTargets) {
          accountsRefresh.push(await refreshAccountsForItemWithResult(userId, id));
        }
        const refreshed = accountsRefresh.filter((row) => row.ok && (row.account_count || 0) > 0);
        const failed = accountsRefresh.filter((row) => !row.ok);
        if (refreshed.length > 0) {
          return res.status(200).json({
            ok: true,
            skipped: false,
            reason: 'accounts_refresh_only',
            message: failed.length > 0
              ? 'Some account balances were refreshed; others could not be updated.'
              : 'Account balances refreshed from Plaid.',
            accounts_refresh: accountsRefresh,
            skipped_items: skippedItems
          });
        }
        if (failed.length > 0) {
          return res.status(502).json({
            ok: false,
            skipped: true,
            reason: 'accounts_refresh_failed',
            message: failed[0]?.error || 'Could not refresh account balances from Plaid.',
            accounts_refresh: accountsRefresh,
            skipped_items: skippedItems
          });
        }
      }
      const skipPayload = {
        ok: false,
        skipped: true,
        reason: 'no_eligible_items',
        message: skippedItems.some((row) => row.reason === 'needs_update')
          ? 'Reconnect the institution in Plaid update mode before refreshing.'
          : 'Sync was skipped. All connected institutions were recently checked.',
        first_open_of_day_override: firstOpenOfDayOverride,
        skipped_items: skippedItems
      };
      if (debugMode) return res.status(200).json(skipPayload);
      return res.status(200).json(skipPayload);
    }

    const triggerPayload = {
      force_refresh: forceRefresh,
      user_initiated: userInitiated,
      item_ids: eligibleItemIds,
      requested_item_id: item_id || null
    };

    if (PLAID_SYNC_USE_QUEUE) {
      await enforceSyncQuotas({ userId, itemId: null, phase: 'enqueue' });
      const dedupeKey = buildSyncJobDedupeKey({
        userId,
        itemId: null,
        bucketMinutes: PLAID_SYNC_DEDUPE_BUCKET_MINUTES
      });
      const result = await enqueuePlaidSyncJob({
        userId,
        itemId: null,
        trigger: 'manual',
        payload: triggerPayload,
        delayMs: 0,
        dedupeKey,
        jobType: 'sync_all'
      });
      const jobId = result?.job?.job_id || null;
      return res.status(202).json({
        ok: true,
        queued: !!result.created,
        already_running: !result.created,
        running: true,
        message: result.created ? 'Bank data sync started.' : 'Bank data sync is already running.',
        job_id: jobId,
        job_ids: jobId ? [jobId] : [],
        eligible_item_ids: eligibleItemIds,
        skipped_items: skippedItems
      });
    }

    const options = { forceRefresh };
    const results = [];
    for (const id of eligibleItemIds) {
      try {
        results.push(await syncTransactionsForItem(id, userId, options));
        await refreshAccountsForItem(userId, id);
      } catch (err) {
        results.push({ item_id: id, error: err.message });
      }
    }
    return res.status(202).json({
      ok: true,
      queued: false,
      already_running: false,
      job_id: null,
      job_ids: [],
      eligible_item_ids: eligibleItemIds,
      skipped_items: skippedItems,
      results
    });
  } catch (err) {
    if (err.message && err.message.includes('Token not found')) {
      return res.status(404).json({ error: 'Item not found or disconnected' });
    }
    next(err);
  }
});

// Fetch transactions (requires authentication)
app.post(
  '/api/plaid/transactions',
  requireAuth,
  requireTmmPlus,
  validateBody(schemas.plaidTransactionsBody),
  async (req, res, next) => {
  try {
    const { item_id, start_date, end_date } = req.body;
    
    if (!item_id) {
      return res.status(400).json({ error: 'item_id is required' });
    }
    if (!start_date || !end_date) {
      return res.status(400).json({ error: 'start_date and end_date are required (YYYY-MM-DD format)' });
    }
    
    // Use authenticated user ID from middleware
    const userId = req.userId;
    
    // Get access token from storage (validated for this user)
    const accessToken = await getToken(item_id, userId);
    
    const request = {
      access_token: accessToken,
      start_date: start_date,
      end_date: end_date,
    };
    
    const response = await plaidClient.transactionsGet(request);
    
    // Transform transactions to a simpler format
    const transactions = response.data.transactions.map(tx => ({
      transaction_id: tx.transaction_id,
      account_id: tx.account_id,
      amount: tx.amount,
      date: tx.date,
      name: tx.name,
      category: tx.category || [],
      merchant_name: tx.merchant_name,
      pending: tx.pending,
      iso_currency_code: tx.iso_currency_code,
      unofficial_currency_code: tx.unofficial_currency_code,
    }));
    
    res.json({ transactions });
  } catch (err) {
    if (err.message && err.message.includes('Token not found')) {
      return res.status(404).json({ error: 'Item not found or disconnected' });
    }
    next(err);
  }
});

// Read synced transactions from DB (requires authentication)
app.get('/api/plaid/transactions/db', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const validation = await getValidationResponse('GET', '/api/plaid/transactions/db', req);
    if (validation) return res.json(validation);
    const userId = req.userId;
    const {
      account_id,
      start_date,
      end_date,
      limit: rawLimit,
      offset: rawOffset
    } = req.query;

    const options = {
      startDate: start_date || undefined,
      endDate: end_date || undefined
    };

    const parsedLimit = Number(rawLimit);
    const parsedOffset = Number(rawOffset);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      options.limit = Math.min(parsedLimit, 500);
    }
    if (Number.isFinite(parsedOffset) && parsedOffset >= 0) {
      options.offset = parsedOffset;
    }

    if (account_id) {
      const account = await getAccountById(account_id);
      if (!account || account.user_id !== userId) {
        return res.status(404).json({ error: 'Account not found' });
      }
      const transactions = await getTransactionsByAccount(account_id, options);
      return res.json({ transactions });
    }

    const transactions = await getTransactionsByUserId(userId, options);
    return res.json({ transactions });
  } catch (err) {
    next(err);
  }
});

// Read historical net-worth points (Plaid live/archive + optional checkpoint merge).
app.get('/api/history/net-worth', requireAuth, validateQuery(schemas.historyNetWorthQuery), async (req, res, next) => {
  try {
    const validation = await getValidationResponse('GET', '/api/history/net-worth', req);
    if (validation) {
      if (String(req.query.forensics || '').toLowerCase() === 'true') {
        return res.json({ ...validation, forensics: buildForensics(validation.points) });
      }
      return res.json(validation);
    }
    const userId = req.userId;
    const startDate = req.query.start_date ? String(req.query.start_date) : null;
    const endDate = req.query.end_date ? String(req.query.end_date) : null;

    let points = await getHistoryPoints(userId, startDate, endDate);
    if (!points.length) {
      points = await deriveNetWorthPointsFromSnapshots(userId, startDate, endDate);
    }

    const tokenCoverage = await getCoverageForUser(userId);
    const fallbackCoverage = deriveCoverageFromPoints(points);
    const coverage = {
      earliest: tokenCoverage.earliest || fallbackCoverage.earliest || null,
      latest: tokenCoverage.latest || fallbackCoverage.latest || null
    };
    const overrides = await getReconciliationOverrides(userId, startDate, endDate);
    const merged = mergePointsWithCheckpoints({
      points,
      checkpoints: [],
      coverage,
      overrides
    });

    const payload = {
      points: merged,
      coverage,
      as_of_rule: 'end_of_day_utc'
    };
    if (String(req.query.forensics || '').toLowerCase() === 'true') {
      payload.forensics = buildForensics(merged);
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Option B from plan: frontend sends checkpoints so backend can reconcile/merge.
app.post('/api/history/net-worth', requireAuth, validateBody(schemas.historyNetWorthBody), async (req, res, next) => {
  try {
    const validation = await getValidationResponse('POST', '/api/history/net-worth', req);
    if (validation) {
      if (String(req.query.forensics || '').toLowerCase() === 'true' || req.body?.forensics === true) {
        return res.json({ ...validation, forensics: buildForensics(validation.points) });
      }
      return res.json(validation);
    }
    const userId = req.userId;
    const body = req.body || {};
    const startDate = body.start_date || null;
    const endDate = body.end_date || null;
    const checkpoints = Array.isArray(body.checkpoints) ? body.checkpoints : [];
    const threshold = Number.isFinite(Number(body.threshold))
      ? Number(body.threshold)
      : 250;

    let points = await getHistoryPoints(userId, startDate, endDate);
    if (!points.length) {
      points = await deriveNetWorthPointsFromSnapshots(userId, startDate, endDate);
    }
    const tokenCoverage = await getCoverageForUser(userId);
    const fallbackCoverage = deriveCoverageFromPoints(points);
    const coverage = {
      earliest: tokenCoverage.earliest || fallbackCoverage.earliest || null,
      latest: tokenCoverage.latest || fallbackCoverage.latest || null
    };
    const overrides = await getReconciliationOverrides(userId, startDate, endDate);
    const merged = mergePointsWithCheckpoints({
      points,
      checkpoints,
      threshold,
      coverage,
      overrides
    });

    const payload = {
      points: merged,
      coverage,
      threshold,
      as_of_rule: 'end_of_day_utc'
    };
    if (String(req.query.forensics || '').toLowerCase() === 'true' || req.body?.forensics === true) {
      payload.forensics = buildForensics(merged);
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// Read TMM-total net worth points per alternative (manual + connected, per alt/day).
app.get('/api/history/net-worth/tmm', requireAuth, validateQuery(schemas.historyNetWorthTmmQuery), async (req, res, next) => {
  try {
    const userId = req.userId;
    const startDate = req.query.start_date ? String(req.query.start_date) : null;
    const endDate = req.query.end_date ? String(req.query.end_date) : null;
    const altNames = parseAltNamesFromValue(req.query.alt_names);

    let query = supabaseAdmin
      .from('net_worth_points_alt')
      .select('alt,point_date,net_worth,source,confidence')
      .eq('user_id', userId)
      .order('point_date', { ascending: true });
    if (startDate) query = query.gte('point_date', startDate);
    if (endDate) query = query.lte('point_date', endDate);
    if (altNames.length) query = query.in('alt', altNames);

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to load TMM net worth history points: ${error.message}`);
    }

    const tokenCoverage = await getCoverageForUser(userId);
    const points = (data || []).map((row) => ({
      alt: row.alt,
      date: row.point_date,
      value: Number(row.net_worth || 0),
      source: row.source || 'tmm_total',
      confidence: row.confidence || 'high',
      reconciled: false,
      needsReview: false
    }));

    // Backward compatibility: if per-alt points do not exist yet, fan out legacy points.
    if (!points.length && altNames.length) {
      let legacyPoints = await getHistoryPoints(userId, startDate, endDate);
      if (!legacyPoints.length) {
        legacyPoints = await deriveNetWorthPointsFromSnapshots(userId, startDate, endDate);
      }
      const fallback = altNames.flatMap((alt) =>
        (legacyPoints || []).map((p) => ({
          alt,
          date: p.point_date,
          value: Number(p.net_worth || 0),
          source: p.source || 'plaid_archived',
          confidence: p.confidence || 'high',
          reconciled: !!p.reconciled,
          needsReview: false
        }))
      );
      return res.json({
        points: fallback,
        coverage: tokenCoverage,
        as_of_rule: 'end_of_day_utc'
      });
    }

    return res.json({
      points,
      coverage: tokenCoverage,
      as_of_rule: 'end_of_day_utc'
    });
  } catch (err) {
    next(err);
  }
});

// Upsert TMM-total net worth points per alternative for today's history point.
app.post('/api/history/net-worth/tmm', requireAuth, validateBody(schemas.historyNetWorthTmmUpsertBody), async (req, res, next) => {
  try {
    const userId = req.userId;
    const body = req.body || {};
    const inputPoints = Array.isArray(body.points) ? body.points : [];
    if (!inputPoints.length) {
      return res.status(400).json({ error: 'points is required' });
    }

    const userQuota = await incrementUsageCounter({
      metric: 'history_tmm_write_user_hourly',
      userId,
      itemId: null,
      windowSeconds: 3600,
      max: HISTORY_TMM_WRITE_USER_HOURLY_MAX
    });
    if (!userQuota.allowed) {
      return res.status(429).json({
        error: 'Hourly TMM history write quota exceeded',
        count: userQuota.count,
        bucket_start: userQuota.bucket_start
      });
    }

    if (HISTORY_TMM_WRITE_GLOBAL_USER_ID) {
      const globalQuota = await incrementUsageCounter({
        metric: 'history_tmm_write_global_hourly',
        userId: HISTORY_TMM_WRITE_GLOBAL_USER_ID,
        itemId: null,
        windowSeconds: 3600,
        max: HISTORY_TMM_WRITE_GLOBAL_HOURLY_MAX
      });
      if (!globalQuota.allowed) {
        return res.status(429).json({
          error: 'Global TMM history write quota exceeded',
          count: globalQuota.count,
          bucket_start: globalQuota.bucket_start
        });
      }
    }

    const timezone = await getHistoryTimezoneForUser(userId);
    const requestedAsOf = body.as_of ? parseIsoTimestamp(body.as_of) : null;
    const asOf = stableAsOfDate({ now: requestedAsOf || new Date(), timezone });
    const pointDate = dateToIsoDate(asOf);

    const byAlt = new Map();
    for (const point of inputPoints) {
      const alt = String(point.alt || '').trim();
      if (!alt) continue;
      byAlt.set(alt, Number(point.net_worth || 0));
    }
    if (!byAlt.size) {
      return res.status(400).json({ error: 'At least one valid alt point is required' });
    }

    const rows = Array.from(byAlt.entries()).map(([alt, netWorth]) => ({
      user_id: userId,
      alt,
      point_date: pointDate,
      net_worth: netWorth,
      source: 'tmm_total',
      confidence: 'high',
      metadata: {
        trigger: 'sync_completion',
        as_of: asOf.toISOString()
      }
    }));

    const { data, error } = await supabaseAdmin
      .from('net_worth_points_alt')
      .upsert(rows, { onConflict: 'user_id,alt,point_date', ignoreDuplicates: false })
      .select('alt,point_date,net_worth');
    if (error) {
      throw new Error(`Failed to upsert TMM net worth history points: ${error.message}`);
    }

    res.json({
      ok: true,
      point_date: pointDate,
      upserted_count: rows.length,
      points: data || []
    });
  } catch (err) {
    next(err);
  }
});

// Reconciliation choice endpoint.
app.post(
  '/api/history/reconciliation',
  requireAuth,
  validateBody(schemas.historyReconciliationBody),
  async (req, res, next) => {
  try {
    const validation = await getValidationResponse('POST', '/api/history/reconciliation', req);
    if (validation) return res.json(validation);
    const userId = req.userId;
    const {
      point_date,
      chosen_source,
      checkpoint_value,
      plaid_value,
      reason
    } = req.body || {};
    if (!point_date || !chosen_source) {
      return res.status(400).json({ error: 'point_date and chosen_source are required' });
    }
    if (!['checkpoint', 'plaid'].includes(chosen_source)) {
      return res.status(400).json({ error: "chosen_source must be 'checkpoint' or 'plaid'" });
    }

    const override = await upsertReconciliationOverride({
      userId,
      pointDate: String(point_date).slice(0, 10),
      chosenSource: chosen_source,
      checkpointValue: checkpoint_value,
      plaidValue: plaid_value,
      reason: reason || null
    });

    const valueToUse = chosen_source === 'checkpoint'
      ? Number(checkpoint_value || 0)
      : Number(plaid_value || 0);
    const sourceToUse = chosen_source === 'checkpoint'
      ? 'checkpoint_user'
      : 'plaid_live';
    await supabaseAdmin
      .from('net_worth_points')
      .upsert({
        user_id: userId,
        point_date: String(point_date).slice(0, 10),
        net_worth: valueToUse,
        source: sourceToUse,
        confidence: 'high',
        reconciled: true,
        override_id: override.id
      }, { onConflict: 'user_id,point_date', ignoreDuplicates: false });

    res.json({ ok: true, override });
  } catch (err) {
    next(err);
  }
});

// Manual archive trigger (useful for tier transitions/admin workflows).
app.post('/api/history/archive', requireAuth, validateBody(schemas.historyArchiveBody), async (req, res, next) => {
  try {
    const userId = req.userId;
    const { use_month_end } = req.body || {};
    const snapshot = await createArchiveSnapshotForUser(userId, {
      useMonthEnd: !!use_month_end,
      pointSource: 'plaid_archived',
      metadata: { trigger: 'manual_archive' },
      forceArchive: true
    });
    res.json({ ok: true, snapshot });
  } catch (err) {
    next(err);
  }
});

// Disconnect an item (requires authentication)
app.post(
  '/api/plaid/disconnect',
  requireAuth,
  requireTmmPlus,
  validateBody(schemas.plaidItemBody),
  async (req, res, next) => {
  try {
    const { item_id } = req.body;
    
    // Use authenticated user ID from middleware
    const userId = req.userId;
    
    if (!item_id) {
      return res.status(400).json({ error: 'item_id is required' });
    }
    
    let accessToken;
    try {
      accessToken = await getToken(item_id, userId);
    } catch (err) {
      if (err.message && err.message.includes('Token not found')) {
        return res.status(404).json({ error: 'Item not found' });
      }
      throw err;
    }

    try {
      await plaidClient.itemRemove({ access_token: accessToken });
    } catch (err) {
      console.warn(`[plaid] item/remove failed for ${item_id}:`, err?.message || err);
    }

    await createArchiveSnapshotForItem(userId, item_id, {
      pointSource: 'plaid_archived',
      metadata: { trigger: 'disconnect', item_id },
      forceArchive: true
    });

    const itemAccounts = await getAccountsByUserAndItemId(userId, item_id);
    for (const acc of itemAccounts) {
      try {
        await deleteTransactionsByAccount(acc.id);
      } catch (e) {
        console.warn(`[plaid] delete transactions for account ${acc.id} failed:`, e?.message || e);
      }
    }
    await deleteAccountsByUserAndItemId(userId, item_id);

    await removeToken(item_id, userId);
    await upsertPlaidItemStatus({
      userId,
      itemId: item_id,
      status: 'disconnected',
      needsUpdateMode: false,
      webhookType: 'MANUAL',
      webhookCode: 'DISCONNECT',
      metadata: { trigger: 'disconnect' }
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Apply error handling middleware
app.use(errorHandler);

// Initialize storage and start server
async function startServer() {
  try {
    // Initialize Supabase token storage
    await initializeTokenStorage({
      supabase: config.supabase
    });

    // Start server
    app.listen(PORT, () => {
      console.log(`🚀 TMM Plaid Backend API running on port ${PORT}`);
      console.log(`📡 Environment: ${config.env}`);
      console.log(`🌐 CORS origins: ${config.corsOrigins.join(', ')}`);
      console.log(`💾 Database: Supabase PostgreSQL`);
      console.log(`🔐 Plaid environment: ${config.plaid.environment}`);

      const syncIntervalMinutes = Number(process.env.PLAID_TRANSACTIONS_SYNC_INTERVAL_MINUTES || 1440);
      if (Number.isFinite(syncIntervalMinutes) && syncIntervalMinutes > 0) {
        const intervalMs = syncIntervalMinutes * 60 * 1000;
        setInterval(() => {
          runScheduledTransactionsSync().catch((err) => {
            console.error('Scheduled Plaid transactions sync run failed:', err.message);
          });
        }, intervalMs);
        console.log(`🕒 Plaid transactions sync schedule: every ${syncIntervalMinutes} minute(s)`);
      } else {
        console.log('🕒 Plaid transactions sync schedule: disabled');
      }

      if (PLAID_SYNC_USE_QUEUE && PLAID_SYNC_WORKER_ENABLED) {
        const pollMs = Number(process.env.PLAID_SYNC_WORKER_POLL_MS || 2000);
        startPlaidSyncWorker({
          runJob: processPlaidSyncJob,
          pollIntervalMs: pollMs,
          lockSeconds: Number(process.env.PLAID_SYNC_JOB_LOCK_SECONDS || 120),
          enabled: true
        });
        console.log(`🧵 Plaid sync worker: enabled (poll ${pollMs}ms)`);
      } else {
        console.log('🧵 Plaid sync worker: disabled');
      }

      const snapshotIntervalMinutes = Number(process.env.HISTORY_SNAPSHOT_INTERVAL_MINUTES || 10080);
      if (Number.isFinite(snapshotIntervalMinutes) && snapshotIntervalMinutes > 0) {
        const intervalMs = snapshotIntervalMinutes * 60 * 1000;
        setInterval(() => {
          runScheduledHistorySnapshots().catch((err) => {
            console.error('Scheduled history snapshot run failed:', err.message);
          });
        }, intervalMs);
        console.log(`🕒 History snapshot schedule: every ${snapshotIntervalMinutes} minute(s)`);
      } else {
        console.log('🕒 History snapshot schedule: disabled');
      }
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

