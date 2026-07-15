// Plaid item lifecycle transitions (ADR-6 / D12, Phase 4.8).
//
// State machine (normative spec: project-roadmap/05-plaid-lifecycle-policy.md):
//   ACTIVE -> (downgrade) SUSPENDED: sync stops immediately, tokens kept
//   encrypted 30 days (retention_expires_at) -> resubscribe = ACTIVE with no
//   re-link + catch-up sync, or expiry = REVOKED: itemRemove + token deleted.
//
// Suspension is user-level: stamped on every plaid_tokens row for the user.
// Historical imported data (accounts, transactions, history) survives every
// transition except user-initiated deletion.
//
// Core functions accept injected deps so they unit-test without live services
// (same pattern as plaidItemHandlers).

import { supabaseAdmin } from '../supabaseClient.js';
import { plaidClient } from '../plaidClient.js';
import { getToken, removeToken } from '../tokenStore.js';
import { writeAuditLog } from './auditLog.js';

export const PLAID_TOKEN_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.PLAID_TOKEN_RETENTION_DAYS || 30)
);

function log(payload) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...payload }));
}

async function recordLifecycleEvent(db, { userId, itemId, eventType, metadata = {} }) {
  const { error } = await db.from('plaid_connection_events').insert({
    user_id: userId,
    item_id: itemId,
    event_type: eventType,
    connection_type: 'lifecycle',
    metadata
  });
  if (error) {
    console.warn(JSON.stringify({
      type: 'plaid_lifecycle_event_record_failed',
      eventType,
      itemId,
      message: error.message,
      timestamp: new Date().toISOString()
    }));
  }
}

/**
 * True when the user's Plaid connectivity is suspended (any token row stamped).
 * Suspension always applies to all of a user's items together (D12).
 */
export async function isPlaidSuspendedForUser(userId, db = supabaseAdmin) {
  if (!userId || !db) return false;
  const { data, error } = await db
    .from('plaid_tokens')
    .select('item_id')
    .eq('user_id', userId)
    .not('suspended_at', 'is', null)
    .limit(1);
  if (error) {
    throw new Error(`Failed to check Plaid suspension: ${error.message}`);
  }
  return (data || []).length > 0;
}

/**
 * ACTIVE -> SUSPENDED (downgrade landed): stamp suspension + 30-day retention
 * on every item; stop future sync (enqueue/worker/scheduler all check the
 * stamp); freeze item status. Idempotent — already-suspended rows keep their
 * original retention deadline.
 */
export async function suspendPlaidForUser(userId, { reason = 'downgrade', db = supabaseAdmin, actor = 'system' } = {}) {
  if (!userId || !db) return { suspended: 0 };
  const nowIso = new Date().toISOString();
  const retentionIso = new Date(Date.now() + PLAID_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await db
    .from('plaid_tokens')
    .select('item_id, suspended_at')
    .eq('user_id', userId);
  if (error) {
    throw new Error(`Failed to load Plaid items for suspension: ${error.message}`);
  }

  const toSuspend = (rows || []).filter((r) => !r.suspended_at);
  for (const row of toSuspend) {
    const { error: updateError } = await db
      .from('plaid_tokens')
      .update({ suspended_at: nowIso, retention_expires_at: retentionIso })
      .eq('user_id', userId)
      .eq('item_id', row.item_id);
    if (updateError) {
      throw new Error(`Failed to suspend Plaid item ${row.item_id}: ${updateError.message}`);
    }
    await db
      .from('plaid_item_status')
      .update({ status: 'suspended' })
      .eq('user_id', userId)
      .eq('item_id', row.item_id);
    await recordLifecycleEvent(db, {
      userId,
      itemId: row.item_id,
      eventType: 'suspend',
      metadata: { reason, retention_expires_at: retentionIso }
    });
  }

  if (toSuspend.length > 0) {
    await writeAuditLog({ db,
      userId,
      actor,
      action: 'plaid.suspend',
      metadata: { reason, item_count: toSuspend.length, retention_expires_at: retentionIso }
    });
    log({ type: 'plaid_lifecycle_suspend', userId, itemCount: toSuspend.length, reason });
  }
  return { suspended: toSuspend.length };
}

/**
 * SUSPENDED -> ACTIVE (restore within the retention window): clear suspension,
 * resume item status, and trigger an immediate catch-up sync per item. No
 * Plaid Link re-authentication — that is the entire reason tokens are retained.
 *
 * enqueueCatchUpSync is injected to avoid a circular import with
 * plaidSyncService (which itself checks suspension).
 */
export async function restorePlaidForUser(userId, { db = supabaseAdmin, actor = 'system', enqueueCatchUpSync = null } = {}) {
  if (!userId || !db) return { restored: 0 };

  const { data: rows, error } = await db
    .from('plaid_tokens')
    .select('item_id, suspended_at')
    .eq('user_id', userId)
    .not('suspended_at', 'is', null);
  if (error) {
    throw new Error(`Failed to load suspended Plaid items: ${error.message}`);
  }

  const items = rows || [];
  for (const row of items) {
    const { error: updateError } = await db
      .from('plaid_tokens')
      .update({ suspended_at: null, retention_expires_at: null })
      .eq('user_id', userId)
      .eq('item_id', row.item_id);
    if (updateError) {
      throw new Error(`Failed to restore Plaid item ${row.item_id}: ${updateError.message}`);
    }
    await db
      .from('plaid_item_status')
      .update({ status: 'healthy' })
      .eq('user_id', userId)
      .eq('item_id', row.item_id)
      .eq('status', 'suspended');
    await recordLifecycleEvent(db, {
      userId,
      itemId: row.item_id,
      eventType: 'restore',
      metadata: {}
    });
    if (enqueueCatchUpSync) {
      try {
        await enqueueCatchUpSync({ userId, itemId: row.item_id, trigger: 'manual' });
      } catch (err) {
        console.warn(JSON.stringify({
          type: 'plaid_restore_catchup_enqueue_failed',
          userId,
          itemId: row.item_id,
          message: err?.message || String(err),
          timestamp: new Date().toISOString()
        }));
      }
    }
  }

  if (items.length > 0) {
    await writeAuditLog({ db,
      userId,
      actor,
      action: 'plaid.restore',
      metadata: { item_count: items.length }
    });
    log({ type: 'plaid_lifecycle_restore', userId, itemCount: items.length });
  }
  return { restored: items.length };
}

/**
 * SUSPENDED -> REVOKED (retention expiry sweep): for every token past
 * retention_expires_at, call itemRemove at Plaid (best-effort: if the item is
 * already gone at Plaid, proceed), delete the token row, mark the item
 * revoked, and log. Historical imported data stays (D12). Idempotent and
 * retried: failures keep the row for the next sweep run and alert.
 */
export async function revokeExpiredPlaidTokens({
  now = new Date(),
  db = supabaseAdmin,
  plaid = plaidClient,
  getAccessToken = getToken,
  deleteToken = removeToken
} = {}) {
  if (!db) return { revoked: 0, failed: 0 };

  const { data: rows, error } = await db
    .from('plaid_tokens')
    .select('item_id, user_id, retention_expires_at')
    .not('retention_expires_at', 'is', null)
    .lt('retention_expires_at', now.toISOString());
  if (error) {
    throw new Error(`Failed to load expired Plaid tokens: ${error.message}`);
  }

  let revoked = 0;
  let failed = 0;
  for (const row of rows || []) {
    try {
      let accessToken = null;
      try {
        accessToken = await getAccessToken(row.item_id, row.user_id);
      } catch {
        accessToken = null; // token unreadable -> still delete the row below
      }
      if (accessToken) {
        try {
          await plaid.itemRemove({ access_token: accessToken });
        } catch (err) {
          const code = err?.response?.data?.error_code || null;
          // Item already gone at Plaid: proceed with local deletion.
          if (code !== 'ITEM_NOT_FOUND' && code !== 'INVALID_ACCESS_TOKEN') {
            throw err;
          }
        }
      }
      await deleteToken(row.item_id, row.user_id);
      await db
        .from('plaid_item_status')
        .update({ status: 'revoked' })
        .eq('user_id', row.user_id)
        .eq('item_id', row.item_id);
      await recordLifecycleEvent(db, {
        userId: row.user_id,
        itemId: row.item_id,
        eventType: 'revoke',
        metadata: { reason: 'retention_expired' }
      });
      await writeAuditLog({ db,
        userId: row.user_id,
        actor: 'system',
        action: 'plaid.revoke',
        resource: row.item_id,
        metadata: { reason: 'retention_expired' }
      });
      revoked += 1;
    } catch (err) {
      failed += 1;
      console.error(JSON.stringify({
        type: 'plaid_revocation_sweep_item_failed',
        userId: row.user_id,
        itemId: row.item_id,
        message: err?.message || String(err),
        timestamp: new Date().toISOString()
      }));
    }
  }

  if (revoked > 0 || failed > 0) {
    log({ type: 'plaid_revocation_sweep', revoked, failed });
  }
  return { revoked, failed };
}
