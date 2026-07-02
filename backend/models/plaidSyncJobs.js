import { randomUUID } from 'crypto';
import { supabaseAdmin } from '../supabaseClient.js';

function nowIso() {
  return new Date().toISOString();
}

function futureIso(delayMs = 0) {
  const d = new Date();
  d.setTime(d.getTime() + Math.max(0, Number(delayMs) || 0));
  return d.toISOString();
}

function dedupeBucketId(bucketMinutes = 15, now = new Date()) {
  const minutes = Math.max(1, Number(bucketMinutes) || 15);
  const bucketMs = minutes * 60 * 1000;
  const bucketStart = Math.floor(now.getTime() / bucketMs) * bucketMs;
  return String(Math.floor(bucketStart / 1000));
}

export function buildSyncJobDedupeKey({ userId, itemId, bucketMinutes = 15 }) {
  const bucket = dedupeBucketId(bucketMinutes);
  if (itemId) return `sync_item:${userId}:${itemId}:${bucket}`;
  return `sync_all:${userId}:${bucket}`;
}

export async function enqueuePlaidSyncJob({
  userId,
  itemId = null,
  trigger = 'manual',
  payload = {},
  delayMs = 0,
  dedupeKey = null,
  jobType = null,
  maxAttempts = 5
}) {
  const safeJobType = jobType || (itemId ? 'sync_item' : 'sync_all');
  const insertPayload = {
    job_id: randomUUID(),
    user_id: userId,
    item_id: itemId,
    trigger,
    job_type: safeJobType,
    status: 'queued',
    attempts: 0,
    max_attempts: Math.max(1, Number(maxAttempts) || 5),
    run_after: futureIso(delayMs),
    payload: payload || {},
    dedupe_key: dedupeKey
  };
  const { data, error } = await supabaseAdmin
    .from('plaid_sync_jobs')
    .insert(insertPayload)
    .select('*')
    .single();

  if (!error) {
    return { created: true, job: data };
  }

  // Partial unique index collision on active dedupe key: return existing active job.
  if (error.code === '23505' && dedupeKey) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('plaid_sync_jobs')
      .select('*')
      .eq('dedupe_key', dedupeKey)
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) {
      throw new Error(`Failed to fetch existing deduped sync job: ${existingError.message}`);
    }
    if (existing) {
      return { created: false, job: existing };
    }
  }

  throw new Error(`Failed to enqueue Plaid sync job: ${error.message}`);
}

export async function claimNextPlaidSyncJob({ workerId, lockSeconds = 60 }) {
  const now = nowIso();
  const lockUntil = futureIso(lockSeconds * 1000);

  const { data: candidate, error: candidateError } = await supabaseAdmin
    .from('plaid_sync_jobs')
    .select('*')
    .eq('status', 'queued')
    .lte('run_after', now)
    .order('run_after', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (candidateError) {
    throw new Error(`Failed to select Plaid sync job candidate: ${candidateError.message}`);
  }
  if (!candidate) return null;

  const { data: claimed, error: claimError } = await supabaseAdmin
    .from('plaid_sync_jobs')
    .update({
      status: 'running',
      started_at: now,
      lock_owner: workerId,
      locked_until: lockUntil,
      attempts: Number(candidate.attempts || 0) + 1,
      updated_at: now
    })
    .eq('id', candidate.id)
    .eq('status', 'queued')
    .select('*')
    .maybeSingle();
  if (claimError) {
    throw new Error(`Failed to claim Plaid sync job: ${claimError.message}`);
  }
  return claimed || null;
}

export async function completePlaidSyncJob({ jobId, result }) {
  const { error } = await supabaseAdmin
    .from('plaid_sync_jobs')
    .update({
      status: 'completed',
      result: result || {},
      error_code: null,
      error_message: null,
      lock_owner: null,
      locked_until: null,
      finished_at: nowIso(),
      updated_at: nowIso()
    })
    .eq('job_id', jobId);
  if (error) {
    throw new Error(`Failed to complete Plaid sync job: ${error.message}`);
  }
}

export async function failPlaidSyncJob({
  jobId,
  errorCode = null,
  errorMessage = 'Sync failed',
  runAfterDelayMs = 0,
  noRetry = false
}) {
  const { data: row, error: rowError } = await supabaseAdmin
    .from('plaid_sync_jobs')
    .select('attempts,max_attempts')
    .eq('job_id', jobId)
    .maybeSingle();
  if (rowError) {
    throw new Error(`Failed to load Plaid sync job failure state: ${rowError.message}`);
  }
  const maxAttempts = Number(row?.max_attempts || 1);
  const attempts = Number(row?.attempts || 0);
  const retryAllowed = !noRetry && attempts < maxAttempts;
  const nextStatus = retryAllowed ? 'queued' : 'failed';
  const payload = {
    status: nextStatus,
    error_code: errorCode,
    error_message: errorMessage,
    lock_owner: null,
    locked_until: null,
    updated_at: nowIso()
  };
  if (retryAllowed) {
    payload.run_after = futureIso(runAfterDelayMs);
  } else {
    payload.finished_at = nowIso();
  }
  const { error } = await supabaseAdmin
    .from('plaid_sync_jobs')
    .update(payload)
    .eq('job_id', jobId);
  if (error) {
    throw new Error(`Failed to fail Plaid sync job: ${error.message}`);
  }
}

export async function getRecentPlaidSyncJobs({ status = null, limit = 100 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(500, Number(limit))) : 100;
  let query = supabaseAdmin
    .from('plaid_sync_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to load Plaid sync jobs: ${error.message}`);
  }
  return data || [];
}

