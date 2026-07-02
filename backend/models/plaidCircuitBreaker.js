import { supabaseAdmin } from '../supabaseClient.js';

const DEFAULT_SCOPE = 'global';
const DEFAULT_WINDOW_SECONDS = Number(process.env.PLAID_BREAKER_WINDOW_SECONDS || 120);
const DEFAULT_FAILURE_THRESHOLD = Number(process.env.PLAID_BREAKER_FAILURE_THRESHOLD || 5);
const DEFAULT_OPEN_SECONDS = Number(process.env.PLAID_BREAKER_OPEN_SECONDS || 60);
const HALF_OPEN_PROBE_SECONDS = Number(process.env.PLAID_BREAKER_HALF_OPEN_PROBE_SECONDS || 20);

function nowIso() {
  return new Date().toISOString();
}

function addSeconds(iso, seconds) {
  const d = iso ? new Date(iso) : new Date();
  d.setUTCSeconds(d.getUTCSeconds() + seconds);
  return d.toISOString();
}

function diffSeconds(aIso, bIso) {
  return Math.floor((new Date(aIso).getTime() - new Date(bIso).getTime()) / 1000);
}

export async function getPlaidCircuitBreaker(scope = DEFAULT_SCOPE) {
  const { data, error } = await supabaseAdmin
    .from('plaid_circuit_breaker')
    .select('*')
    .eq('scope', scope)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read Plaid circuit breaker: ${error.message}`);
  }
  if (data) return data;
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('plaid_circuit_breaker')
    .insert({ scope, state: 'closed' })
    .select('*')
    .single();
  if (insertError) {
    throw new Error(`Failed to initialize Plaid circuit breaker: ${insertError.message}`);
  }
  return inserted;
}

export async function ensurePlaidCircuitAllowsRequest(scope = DEFAULT_SCOPE) {
  const breaker = await getPlaidCircuitBreaker(scope);
  const now = new Date();
  if (breaker.state === 'open' && breaker.next_try_at && new Date(breaker.next_try_at) > now) {
    return { allowed: false, breaker };
  }
  if (breaker.state === 'open') {
    const { data, error } = await supabaseAdmin
      .from('plaid_circuit_breaker')
      .update({
        state: 'half_open',
        next_try_at: addSeconds(nowIso(), HALF_OPEN_PROBE_SECONDS),
        updated_at: nowIso()
      })
      .eq('scope', scope)
      .select('*')
      .single();
    if (error) {
      throw new Error(`Failed transitioning circuit breaker to half_open: ${error.message}`);
    }
    return { allowed: true, breaker: data };
  }
  return { allowed: true, breaker };
}

export async function recordPlaidCircuitSuccess(scope = DEFAULT_SCOPE) {
  const { error } = await supabaseAdmin
    .from('plaid_circuit_breaker')
    .update({
      state: 'closed',
      opened_at: null,
      next_try_at: null,
      failure_count_window: 0,
      window_started_at: nowIso(),
      reason: null,
      last_failure_at: null,
      updated_at: nowIso()
    })
    .eq('scope', scope);
  if (error) {
    throw new Error(`Failed to record circuit breaker success: ${error.message}`);
  }
}

export async function recordPlaidCircuitFailure({
  scope = DEFAULT_SCOPE,
  reason = 'plaid_failure',
  openSeconds = DEFAULT_OPEN_SECONDS,
  threshold = DEFAULT_FAILURE_THRESHOLD,
  windowSeconds = DEFAULT_WINDOW_SECONDS
}) {
  const breaker = await getPlaidCircuitBreaker(scope);
  const now = nowIso();
  const windowStartedAt = breaker.window_started_at || now;
  const inWindow = diffSeconds(now, windowStartedAt) <= windowSeconds;
  const nextCount = inWindow ? (Number(breaker.failure_count_window || 0) + 1) : 1;
  const shouldOpen = nextCount >= threshold;
  const payload = {
    state: shouldOpen ? 'open' : (breaker.state === 'half_open' ? 'open' : breaker.state),
    opened_at: shouldOpen ? now : breaker.opened_at,
    next_try_at: shouldOpen ? addSeconds(now, openSeconds) : breaker.next_try_at,
    last_failure_at: now,
    failure_count_window: nextCount,
    window_started_at: inWindow ? windowStartedAt : now,
    reason,
    updated_at: now
  };
  const { data, error } = await supabaseAdmin
    .from('plaid_circuit_breaker')
    .update(payload)
    .eq('scope', scope)
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to record circuit breaker failure: ${error.message}`);
  }
  return data;
}

