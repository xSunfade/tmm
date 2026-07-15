// Plaid webhook verification (Phase 4.9 — SEC-1 / WH-P1).
//
// Every production Plaid webhook carries a `Plaid-Verification` header: an
// ES256 JWT whose payload binds the exact raw request body via
// request_body_sha256. Verification MUST precede any processing —
// USER_PERMISSION_REVOKED triggers token/account cleanup, so an unverified
// webhook is an unauthenticated deletion vector.
//
// Keys come from /webhook_verification_key/get, cached by `kid` and
// rotation-safe (unknown kid -> fetch; expired keys rejected). Implemented on
// Node's crypto (JWK import + ieee-p1363 ECDSA) — no extra dependency.

import crypto from 'crypto';
import { plaidClient } from '../plaidClient.js';

const MAX_TOKEN_AGE_SECONDS = 5 * 60;
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const keyCache = new Map(); // kid -> { jwk, cachedAt }

function base64UrlDecode(segment) {
  return Buffer.from(segment, 'base64url');
}

function parseJwtSegments(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
    const signature = base64UrlDecode(parts[2]);
    return { header, payload, signature, signingInput: `${parts[0]}.${parts[1]}` };
  } catch {
    return null;
  }
}

async function defaultGetKey(kid) {
  const cached = keyCache.get(kid);
  if (cached && Date.now() - cached.cachedAt < KEY_CACHE_TTL_MS) {
    return cached.jwk;
  }
  const response = await plaidClient.webhookVerificationKeyGet({ key_id: kid });
  const jwk = response?.data?.key || null;
  if (jwk) {
    keyCache.set(kid, { jwk, cachedAt: Date.now() });
  }
  return jwk;
}

/** Test hook: clear the module-level key cache. */
export function clearPlaidWebhookKeyCache() {
  keyCache.clear();
}

/**
 * Verify a Plaid webhook. Returns { ok: true } or { ok: false, reason }.
 *
 * @param {object} params
 * @param {string} params.token     The Plaid-Verification header value (JWT).
 * @param {Buffer|string} params.rawBody  The EXACT raw request body bytes.
 * @param {(kid: string) => Promise<object|null>} [params.getKey]  JWK fetcher (injected in tests).
 * @param {number} [params.nowSeconds]    Unix seconds, for iat freshness.
 */
export async function verifyPlaidWebhook({ token, rawBody, getKey = defaultGetKey, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!token) return { ok: false, reason: 'missing_verification_header' };

  const parsed = parseJwtSegments(token);
  if (!parsed) return { ok: false, reason: 'malformed_jwt' };
  const { header, payload, signature, signingInput } = parsed;

  if (header.alg !== 'ES256') return { ok: false, reason: 'unexpected_algorithm' };
  if (!header.kid || typeof header.kid !== 'string') return { ok: false, reason: 'missing_kid' };

  let jwk;
  try {
    jwk = await getKey(header.kid);
  } catch (err) {
    return { ok: false, reason: `key_fetch_failed:${err?.message || 'unknown'}` };
  }
  if (!jwk) return { ok: false, reason: 'unknown_kid' };
  if (jwk.expired_at != null) return { ok: false, reason: 'expired_key' };

  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'invalid_key' };
  }

  const valid = crypto.verify(
    'sha256',
    Buffer.from(signingInput, 'utf8'),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    signature
  );
  if (!valid) return { ok: false, reason: 'invalid_signature' };

  const iat = Number(payload.iat);
  if (!Number.isFinite(iat)) return { ok: false, reason: 'missing_iat' };
  if (nowSeconds - iat > MAX_TOKEN_AGE_SECONDS) return { ok: false, reason: 'stale_token' };

  const expectedHash = String(payload.request_body_sha256 || '');
  if (!expectedHash) return { ok: false, reason: 'missing_body_hash' };
  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  const actualHash = crypto.createHash('sha256').update(bodyBuffer).digest('hex');
  const expected = Buffer.from(expectedHash, 'utf8');
  const actual = Buffer.from(actualHash, 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'body_hash_mismatch' };
  }

  return { ok: true };
}
