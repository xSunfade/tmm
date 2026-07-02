import crypto from 'crypto';
import { supabaseAdmin } from '../supabaseClient.js';

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeWebhookEventHash(payload) {
  const serialized = stableStringify(payload || {});
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

export async function recordPlaidWebhookEvent({
  payload,
  requestId = null,
  userId = null,
  status = 'received'
}) {
  const eventHash = computeWebhookEventHash(payload);
  const itemId = payload?.item_id || null;
  const webhookType = payload?.webhook_type || null;
  const webhookCode = payload?.webhook_code || null;
  const insertPayload = {
    event_hash: eventHash,
    user_id: userId,
    item_id: itemId,
    webhook_type: webhookType,
    webhook_code: webhookCode,
    request_id: requestId,
    status,
    payload: payload || {},
    processed_at: status === 'processed' ? new Date().toISOString() : null
  };

  const { data, error } = await supabaseAdmin
    .from('plaid_webhook_events')
    .upsert(insertPayload, {
      onConflict: 'event_hash',
      ignoreDuplicates: true
    })
    .select('id,event_hash,status,created_at')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to persist Plaid webhook event: ${error.message}`);
  }

  if (!data) {
    return { duplicate: true, eventHash };
  }

  return { duplicate: false, eventHash, eventId: data.id };
}

export async function markPlaidWebhookEventProcessed(eventHash, status = 'processed') {
  if (!eventHash) return;
  const { error } = await supabaseAdmin
    .from('plaid_webhook_events')
    .update({
      status,
      processed_at: new Date().toISOString()
    })
    .eq('event_hash', eventHash);

  if (error) {
    throw new Error(`Failed to update Plaid webhook event status: ${error.message}`);
  }
}

export async function upsertPlaidItemStatus({
  userId,
  itemId,
  status,
  needsUpdateMode,
  lastErrorCode = null,
  webhookType = null,
  webhookCode = null,
  metadata = {}
}) {
  if (!userId || !itemId) return null;
  const payload = {
    user_id: userId,
    item_id: itemId,
    status,
    needs_update_mode: !!needsUpdateMode,
    last_error_code: lastErrorCode,
    last_webhook_type: webhookType,
    last_webhook_code: webhookCode,
    metadata: metadata || {},
    last_webhook_at: new Date().toISOString()
  };
  const { data, error } = await supabaseAdmin
    .from('plaid_item_status')
    .upsert(payload, { onConflict: 'user_id,item_id', ignoreDuplicates: false })
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to upsert Plaid item status: ${error.message}`);
  }
  return data;
}

export async function getPlaidItemStatusesForUser(userId) {
  if (!userId) return [];
  const { data, error } = await supabaseAdmin
    .from('plaid_item_status')
    .select('*')
    .eq('user_id', userId);
  if (error) {
    throw new Error(`Failed to load Plaid item statuses: ${error.message}`);
  }
  return data || [];
}

export async function setPlaidItemHealthy(userId, itemId, metadata = {}) {
  return upsertPlaidItemStatus({
    userId,
    itemId,
    status: 'healthy',
    needsUpdateMode: false,
    lastErrorCode: null,
    webhookType: 'MANUAL',
    webhookCode: 'HEALTHY',
    metadata
  });
}

export async function removePlaidItemStatus(userId, itemId) {
  if (!userId || !itemId) return;
  const { error } = await supabaseAdmin
    .from('plaid_item_status')
    .delete()
    .eq('user_id', userId)
    .eq('item_id', itemId);
  if (error) {
    throw new Error(`Failed to remove Plaid item status: ${error.message}`);
  }
}

export async function getRecentPlaidWebhookEvents(userId, sinceIso, limit = 100) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 100;
  let query = supabaseAdmin
    .from('plaid_webhook_events')
    .select('id,item_id,webhook_type,webhook_code,status,created_at,processed_at')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (userId) {
    query = query.eq('user_id', userId);
  }
  if (sinceIso) {
    query = query.gte('created_at', sinceIso);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load Plaid webhook events: ${error.message}`);
  }
  return data || [];
}

export async function acquirePlaidItemSyncLock({
  userId,
  itemId,
  workerId,
  lockSeconds = 120
}) {
  if (!userId || !itemId) return { acquired: false, reason: 'missing_identifiers' };
  const now = new Date();
  const lockUntil = new Date(now.getTime() + Math.max(1, Number(lockSeconds) || 120) * 1000).toISOString();

  const { data: current, error: currentError } = await supabaseAdmin
    .from('plaid_item_status')
    .select('sync_locked_until,cooldown_until,sync_lock_owner')
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .maybeSingle();
  if (currentError) {
    throw new Error(`Failed to read sync lock state: ${currentError.message}`);
  }

  const cooldownUntil = current?.cooldown_until ? new Date(current.cooldown_until) : null;
  if (cooldownUntil && cooldownUntil > now) {
    return { acquired: false, reason: 'cooldown', cooldownUntil: cooldownUntil.toISOString() };
  }

  const lockedUntil = current?.sync_locked_until ? new Date(current.sync_locked_until) : null;
  if (lockedUntil && lockedUntil > now) {
    return { acquired: false, reason: 'locked', lockedUntil: lockedUntil.toISOString() };
  }

  let data;
  let error;
  if (current) {
    const updateRes = await supabaseAdmin
      .from('plaid_item_status')
      .update({
        sync_lock_owner: workerId || null,
        sync_locked_until: lockUntil,
        last_sync_started_at: now.toISOString(),
        updated_at: now.toISOString()
      })
      .eq('user_id', userId)
      .eq('item_id', itemId)
      .select('*')
      .single();
    data = updateRes.data;
    error = updateRes.error;
  } else {
    const insertRes = await supabaseAdmin
      .from('plaid_item_status')
      .insert({
        user_id: userId,
        item_id: itemId,
        status: 'healthy',
        needs_update_mode: false,
        metadata: {},
        sync_lock_owner: workerId || null,
        sync_locked_until: lockUntil,
        last_sync_started_at: now.toISOString()
      })
      .select('*')
      .single();
    data = insertRes.data;
    error = insertRes.error;
  }
  if (error) {
    throw new Error(`Failed to acquire sync lock: ${error.message}`);
  }
  return { acquired: true, row: data };
}

export async function releasePlaidItemSyncLock({
  userId,
  itemId,
  success = true,
  cooldownSeconds = 0
}) {
  if (!userId || !itemId) return;
  const now = new Date();
  const nextCooldown = new Date(now.getTime() + Math.max(0, Number(cooldownSeconds) || 0) * 1000).toISOString();
  const { data: current, error: currentError } = await supabaseAdmin
    .from('plaid_item_status')
    .select('consecutive_failures')
    .eq('user_id', userId)
    .eq('item_id', itemId)
    .maybeSingle();
  if (currentError) {
    throw new Error(`Failed to load sync lock release row: ${currentError.message}`);
  }
  const failures = Number(current?.consecutive_failures || 0);
  const nextFailures = success ? 0 : failures + 1;

  const { error } = await supabaseAdmin
    .from('plaid_item_status')
    .update({
      sync_lock_owner: null,
      sync_locked_until: null,
      cooldown_until: cooldownSeconds > 0 ? nextCooldown : null,
      consecutive_failures: nextFailures,
      last_sync_finished_at: now.toISOString(),
      updated_at: now.toISOString()
    })
    .eq('user_id', userId)
    .eq('item_id', itemId);
  if (error) {
    throw new Error(`Failed to release sync lock: ${error.message}`);
  }
}
