// OAuth state nonces (Phase 4.10 — SEC-3).
//
// The old scheme used the raw user UUID as `state`, which allowed
// account-linking CSRF: an attacker completing Google consent with
// state=<victimUserId> would store attacker-controlled tokens under the
// victim. The replacement is signed, single-use, TTL-bound, and user-bound:
//
//   state = v1.<nonce>.<expEpochSeconds>.<hmacSha256(nonce.exp.purpose)>
//
// The nonce maps to a DB row (oauth_states) binding it to the initiating
// user. The callback consumes the row exactly once (atomic conditional
// update); expired, consumed, unknown, or tampered states are all rejected.
// The user id never appears in the state parameter (it leaks via URLs/logs).

import crypto from 'crypto';
import config from '../config.js';
import { supabaseAdmin } from '../supabaseClient.js';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const STATE_VERSION = 'v1';

// Ephemeral fallback keeps dev working without config; prod requires
// TOKEN_ENCRYPTION_KEY at boot anyway (config validator), so the derived
// secret is stable there.
const ephemeralSecret = crypto.randomBytes(32).toString('hex');

function getStateSecret() {
  const base = process.env.OAUTH_STATE_SECRET || config.encryption.key || ephemeralSecret;
  return crypto.createHash('sha256').update(`tmm-oauth-state:${base}`).digest();
}

function signState(nonce, expEpochSeconds, purpose) {
  return crypto
    .createHmac('sha256', getStateSecret())
    .update(`${nonce}.${expEpochSeconds}.${purpose}`)
    .digest('base64url');
}

/**
 * Create a state value for an OAuth redirect and persist its nonce.
 * @returns {Promise<string>} the state parameter value
 */
export async function createOAuthState(userId, { purpose = 'google_sheets', db = supabaseAdmin, ttlMs = OAUTH_STATE_TTL_MS } = {}) {
  if (!db) throw new Error('OAuth state store unavailable');
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + ttlMs);
  const expEpochSeconds = Math.floor(expiresAt.getTime() / 1000);

  const { error } = await db.from('oauth_states').insert({
    nonce,
    user_id: userId,
    purpose,
    expires_at: expiresAt.toISOString()
  });
  if (error) throw new Error(`Failed to persist OAuth state: ${error.message}`);

  const sig = signState(nonce, expEpochSeconds, purpose);
  return `${STATE_VERSION}.${nonce}.${expEpochSeconds}.${sig}`;
}

/**
 * Validate and consume a state value (single-use). Returns
 * { ok: true, userId } or { ok: false, reason }.
 */
export async function consumeOAuthState(state, { purpose = 'google_sheets', db = supabaseAdmin, now = new Date() } = {}) {
  if (!db) return { ok: false, reason: 'state_store_unavailable' };
  const parts = String(state || '').split('.');
  if (parts.length !== 4 || parts[0] !== STATE_VERSION) {
    return { ok: false, reason: 'malformed_state' };
  }
  const [, nonce, expRaw, sig] = parts;
  const expEpochSeconds = Number(expRaw);
  if (!/^[0-9a-f]{32}$/.test(nonce) || !Number.isFinite(expEpochSeconds)) {
    return { ok: false, reason: 'malformed_state' };
  }

  const expectedSig = signState(nonce, expEpochSeconds, purpose);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (expEpochSeconds * 1000 < now.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  // Atomic single-use consume: only succeeds when not already consumed.
  const { data, error } = await db
    .from('oauth_states')
    .update({ consumed_at: now.toISOString() })
    .eq('nonce', nonce)
    .eq('purpose', purpose)
    .is('consumed_at', null)
    .gt('expires_at', now.toISOString())
    .select('user_id')
    .maybeSingle();
  if (error) return { ok: false, reason: `state_lookup_failed:${error.message}` };
  if (!data?.user_id) return { ok: false, reason: 'unknown_or_consumed' };

  return { ok: true, userId: data.user_id };
}
