// Plaid webhook JWT verification (Phase 4.9 — SEC-1 / WH-P1). Accept and
// reject paths exercised with locally generated ES256 keys; no live Plaid.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { verifyPlaidWebhook } from '../lib/plaidWebhookVerify.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const KID = 'test-kid-1';
const NOW = 1_780_000_000;

function signJwt({ body, kid = KID, iat = NOW, alg = 'ES256', bodyHashOverride = null }) {
  const header = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
  const bodyHash = bodyHashOverride
    || crypto.createHash('sha256').update(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')).digest('hex');
  const payload = Buffer.from(JSON.stringify({ iat, request_body_sha256: bodyHash })).toString('base64url');
  const signature = crypto.sign(
    'sha256',
    Buffer.from(`${header}.${payload}`, 'utf8'),
    { key: privateKey, dsaEncoding: 'ieee-p1363' }
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

const getKey = async (kid) => (kid === KID ? { ...jwk, expired_at: null } : null);
const BODY = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-1' });

test('accepts a valid ES256 JWT bound to the exact body', async () => {
  const token = signJwt({ body: BODY });
  const result = await verifyPlaidWebhook({ token, rawBody: Buffer.from(BODY), getKey, nowSeconds: NOW + 10 });
  assert.deepEqual(result, { ok: true });
});

test('rejects a missing header', async () => {
  const result = await verifyPlaidWebhook({ token: '', rawBody: BODY, getKey, nowSeconds: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_verification_header');
});

test('rejects a tampered body (the forged-revocation attack)', async () => {
  const token = signJwt({ body: BODY });
  const forged = JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: 'victim-item' });
  const result = await verifyPlaidWebhook({ token, rawBody: Buffer.from(forged), getKey, nowSeconds: NOW + 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'body_hash_mismatch');
});

test('rejects a bad signature', async () => {
  const token = signJwt({ body: BODY });
  const [h, p] = token.split('.');
  const otherKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const badSig = crypto.sign('sha256', Buffer.from(`${h}.${p}`, 'utf8'), { key: otherKeys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const result = await verifyPlaidWebhook({ token: `${h}.${p}.${badSig}`, rawBody: Buffer.from(BODY), getKey, nowSeconds: NOW + 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('rejects non-ES256 algorithms (alg confusion)', async () => {
  const token = signJwt({ body: BODY, alg: 'HS256' });
  const result = await verifyPlaidWebhook({ token, rawBody: Buffer.from(BODY), getKey, nowSeconds: NOW + 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unexpected_algorithm');
});

test('rejects stale tokens (> 5 minutes old)', async () => {
  const token = signJwt({ body: BODY, iat: NOW - 600 });
  const result = await verifyPlaidWebhook({ token, rawBody: Buffer.from(BODY), getKey, nowSeconds: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_token');
});

test('rejects unknown key ids', async () => {
  const token = signJwt({ body: BODY, kid: 'rotated-away' });
  const result = await verifyPlaidWebhook({ token, rawBody: Buffer.from(BODY), getKey, nowSeconds: NOW + 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_kid');
});

test('rejects expired keys', async () => {
  const expiredGetKey = async () => ({ ...jwk, expired_at: NOW - 1000 });
  const token = signJwt({ body: BODY });
  const result = await verifyPlaidWebhook({ token, rawBody: Buffer.from(BODY), getKey: expiredGetKey, nowSeconds: NOW + 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired_key');
});

test('rejects malformed JWTs', async () => {
  for (const bad of ['not-a-jwt', 'a.b', 'a.b.c.d', '..']) {
    const result = await verifyPlaidWebhook({ token: bad, rawBody: BODY, getKey, nowSeconds: NOW });
    assert.equal(result.ok, false, `token=${bad}`);
  }
});
