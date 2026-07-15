// Plaid routes: webhook intake, Link token/telemetry, item lifecycle
// (exchange/reconnect/remove/disconnect per ADR-6), ops endpoints, and the
// gated transactions sync. Moved verbatim from server.js (Phase 2.9 router
// split). See the tmm-plaid-lifecycle skill before changing behavior here.

import express from 'express';
import config from '../config.js';
import { plaidClient } from '../plaidClient.js';
import { requireAuth, requireTmmPlus, requireAdmin } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { validateBody, schemas } from '../middleware/validation.js';
import { supabaseAdmin } from '../supabaseClient.js';
import {
  storeToken,
  getToken,
  removeToken,
  listItemIdsForUser
} from '../tokenStore.js';
import {
  upsertAccountsForItem,
  getItemIdsWithAccounts,
  updateAccountFromPlaidData,
  getAccountById,
  getAccountsByUserAndItemId,
  deleteAccountsByUserAndItemId
} from '../models/account.js';
import {
  getTransactionsByAccount,
  getTransactionsByUserId,
  deleteTransactionsByAccount
} from '../models/transaction.js';
import {
  getHistoryTimezoneForUser,
  getRecentPlaidSyncRuns
} from '../models/history.js';
import {
  getPlaidItemStatusesForUser,
  getRecentPlaidWebhookEvents,
  markPlaidWebhookEventProcessed,
  recordPlaidWebhookEvent,
  removePlaidItemStatus,
  setPlaidItemHealthy,
  upsertPlaidItemStatus
} from '../models/plaidWebhook.js';
import { getValidationResponse } from '../lib/validationMode.js';
import {
  completePlaidLinkIntent,
  failPlaidLinkIntent,
  getPlaidLinkIntent,
  startPlaidLinkIntent
} from '../models/plaidLinkIntent.js';
import {
  buildSyncJobDedupeKey,
  enqueuePlaidSyncJob,
  getRecentPlaidSyncJobs
} from '../models/plaidSyncJobs.js';
import {
  ensurePlaidCircuitAllowsRequest,
  getPlaidCircuitBreaker,
  recordPlaidCircuitFailure,
  recordPlaidCircuitSuccess
} from '../models/plaidCircuitBreaker.js';
import { createListPlaidItemsHandler, removePlaidItemForUser } from '../lib/plaidItemHandlers.js';
import { createArchiveSnapshotForItem } from '../lib/historyService.js';
import {
  getPlaidErrorCode,
  getPlaidErrorRequestId,
  getPlaidResponseRequestId,
  isPlaidFailureForBreaker
} from '../lib/plaidErrorUtils.js';
import { getLocalDateString, isFutureIso, parseBooleanFlag } from '../lib/serverUtils.js';
import { verifyPlaidWebhook } from '../lib/plaidWebhookVerify.js';
import {
  PLAID_ALLOW_FORCE_REFRESH,
  PLAID_EXCHANGE_REQUIRE_LINK_INTENT,
  PLAID_ITEM_CAP,
  PLAID_ITEM_SAFETY_CEILING,
  PLAID_NEW_CONNECTIONS_PER_7_DAYS,
  PLAID_SYNC_DEDUPE_BUCKET_MINUTES,
  PLAID_SYNC_OUTER_GATE_MINUTES,
  PLAID_SYNC_USE_QUEUE,
  PLAID_SYNC_WEBHOOK_DELAY_MS,
  computeConnectionRetryAfterDate,
  computeNextEligibleSyncAt,
  enforceSyncQuotas,
  enqueueSyncForItem,
  findDuplicateConnectedItem,
  getMostRecentItemSyncAt,
  getRecentNewConnections,
  getUserActiveSyncJobs,
  deriveAccountFreshness,
  isItemFresh,
  recordPlaidConnectionEvent,
  refreshAccountsForItem,
  refreshAccountsForItemWithResult,
  syncTransactionsForItem,
  updatePlaidTokenInstitution
} from '../lib/plaidSyncService.js';

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

const router = express.Router();

// SEC-1 / WH-P1: Plaid-Verification JWT check. Default ON in production;
// disabling there requires an explicit env override (logged loudly at boot).
const PLAID_WEBHOOK_VERIFY = parseBooleanFlag(process.env.PLAID_WEBHOOK_VERIFY, config.isProduction);
if (config.isProduction && !PLAID_WEBHOOK_VERIFY) {
  console.warn('⚠️  PLAID_WEBHOOK_VERIFY is disabled in production — Plaid webhooks are NOT authenticated. This must be a deliberate, temporary override.');
}

// Plaid webhook endpoint (server-only, no user JWT). Receives the RAW body
// (server.js registers express.raw for this path) so the Plaid-Verification
// JWT's request_body_sha256 can be checked against the exact bytes.
router.post('/api/webhooks/plaid', webhookRateLimit, async (req, res, next) => {
  try {
    const requestId = req.requestId || 'unknown';
    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      return res.status(403).json({ error: 'Webhook endpoint does not accept user authentication' });
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}), 'utf8');

    // Verification precedes ALL processing (USER_PERMISSION_REVOKED deletes
    // tokens/accounts; a forged webhook must never reach that code).
    if (PLAID_WEBHOOK_VERIFY) {
      const verification = await verifyPlaidWebhook({
        token: String(req.headers['plaid-verification'] || ''),
        rawBody
      });
      if (!verification.ok) {
        console.warn(JSON.stringify({
          type: 'webhook_plaid_rejected',
          requestId,
          reason: verification.reason,
          timestamp: new Date().toISOString()
        }));
        return res.status(401).json({ error: 'Webhook verification failed' });
      }
    }

    let payload = {};
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'Invalid webhook payload' });
      }
    } else {
      payload = req.body || {};
    }
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

// Create Plaid Link token (requires auth + TMM+)
router.post(
  '/api/plaid/create-link-token',
  requireAuth,
  requireTmmPlus,
  createLinkTokenRateLimit,
  validateBody(schemas.createLinkTokenBody),
  async (req, res, next) => {
  try {
    const userId = req.userId;

    if (!req.body?.update_item_id) {
      // Per-tier item cap (D8): from tier_entitlements via requireTmmPlus
      // (req.entitlements), bounded by the absolute anti-abuse ceiling. The
      // legacy PLAID_ITEM_CAP env is only a fallback if resolution failed.
      const tierCap = Number(req.entitlements?.entitlements?.maxPlaidItems);
      const itemCap = Math.min(
        Number.isFinite(tierCap) && tierCap > 0 ? tierCap : PLAID_ITEM_CAP,
        PLAID_ITEM_SAFETY_CEILING
      );
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
      if (currentCount >= itemCap) {
        console.warn(JSON.stringify({
          type: 'plaid_item_cap_hit',
          requestId: req.requestId || 'unknown',
          userId,
          hitType: 'tier_cap',
          tier: req.entitlements?.tier || null,
          currentCount,
          cap: itemCap,
          timestamp: new Date().toISOString()
        }));
        return res.status(403).json({
          error: `You've reached the ${itemCap} connection limit for your plan. Disconnect an institution or upgrade to add another.`,
          code: 'PLAID_ITEM_CAP_REACHED',
          current_count: currentCount,
          cap: itemCap
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

router.post(
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
router.get(
  '/api/plaid/items',
  requireAuth,
  requireTmmPlus,
  createListPlaidItemsHandler({ supabaseAdmin, itemCap: PLAID_ITEM_CAP })
);

router.get('/api/plaid/item-status', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const statuses = await getPlaidItemStatusesForUser(req.userId);
    res.json({ statuses });
  } catch (err) {
    next(err);
  }
});

router.get('/api/ops/plaid/health', requireAuth, requireAdmin, async (req, res, next) => {
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

router.get('/api/ops/plaid/jobs', requireAuth, requireAdmin, async (req, res, next) => {
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

router.post('/api/ops/plaid/dev/webhook-smoke', requireAuth, requireAdmin, async (req, res, next) => {
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

router.get('/api/plaid/sync/status', requireAuth, requireTmmPlus, async (req, res, next) => {
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

router.get('/api/ops/plaid/breaker', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const breaker = await getPlaidCircuitBreaker();
    res.json({ breaker });
  } catch (err) {
    next(err);
  }
});

// Get all stored accounts for the authenticated user (from DB; for listing and disconnected state)
router.get('/api/plaid/user-accounts', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const userId = req.userId;
    const { getAccountsByUserId } = await import('../models/account.js');
    const accounts = await getAccountsByUserId(userId);
    res.json({ accounts });
  } catch (err) {
    next(err);
  }
});

// Get items with nested accounts from DB only (no live Plaid API calls in this read endpoint).
router.get('/api/plaid/items-with-accounts', requireAuth, requireTmmPlus, async (req, res, next) => {
  try {
    const validation = await getValidationResponse('GET', '/api/plaid/items-with-accounts', req);
    if (validation) return res.json(validation);
    const userId = req.userId;
    const { getAccountsByUserId } = await import('../models/account.js');
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
router.post(
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

router.get('/api/plaid/link-intents/:link_intent_id', requireAuth, requireTmmPlus, async (req, res, next) => {
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

// Reconnect in place: move token and accounts from new_item_id to old_item_id so the same group is restored (no duplicate).
// Returns account_id_mapping (old_plaid_account_id -> new_plaid_account_id) so the frontend can remap plan.connectedAccountId.
router.post(
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
    } = await import('../models/account.js');

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
router.post(
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
router.post(
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
    const { deleteAccountByUserAndPlaidAccountId } = await import('../models/account.js');
    await deleteAccountByUserAndPlaidAccountId(userId, plaid_account_id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Fetch accounts for an item (requires auth + TMM+, token must belong to user)
router.post('/api/plaid/accounts', requireAuth, requireTmmPlus, async (req, res, next) => {
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
router.post('/api/plaid/balance', requireAuth, requireTmmPlus, async (req, res, next) => {
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
router.post(
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
router.post(
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
router.get('/api/plaid/transactions/db', requireAuth, requireTmmPlus, async (req, res, next) => {
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

// Disconnect an item (requires authentication)
router.post(
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

export default router;
