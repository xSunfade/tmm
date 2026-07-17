// OAuth state nonce tests (Phase 4.10 — SEC-3): signed, single-use,
// TTL-bound, user-bound.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthState, consumeOAuthState } from '../lib/oauthState.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

function makeDb() {
  return createFakeSupabase({ oauth_states: { rows: [], unique: ['nonce'] } });
}

test('round trip: created state consumes exactly once and returns the initiating user', async () => {
  const db = makeDb();
  const state = await createOAuthState('user-abc', { db });

  // The user id must never appear in the state parameter (URL/log leakage).
  assert.ok(!state.includes('user-abc'));

  const first = await consumeOAuthState(state, { db });
  assert.equal(first.ok, true);
  assert.equal(first.userId, 'user-abc');

  // Single-use: the same state a second time is rejected (CSRF replay).
  const second = await consumeOAuthState(state, { db });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'unknown_or_consumed');
});

test('a raw user UUID (the old scheme / the attack) is rejected', async () => {
  const db = makeDb();
  const result = await consumeOAuthState('2b0e9c1a-9f75-4c11-b3a1-6a2f9d4e8c01', { db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'malformed_state');
});

test('tampered signature is rejected', async () => {
  const db = makeDb();
  const state = await createOAuthState('user-abc', { db });
  const parts = state.split('.');
  parts[3] = parts[3].slice(0, -2) + 'xx';
  const result = await consumeOAuthState(parts.join('.'), { db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_signature');
});

test('tampered expiry is rejected (signature covers the TTL)', async () => {
  const db = makeDb();
  const state = await createOAuthState('user-abc', { db });
  const parts = state.split('.');
  parts[2] = String(Number(parts[2]) + 999999);
  const result = await consumeOAuthState(parts.join('.'), { db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_signature');
});

test('expired state is rejected', async () => {
  const db = makeDb();
  const state = await createOAuthState('user-abc', { db, ttlMs: 1000 });
  const later = new Date(Date.now() + 60_000);
  const result = await consumeOAuthState(state, { db, now: later });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('state for a different purpose is rejected', async () => {
  const db = makeDb();
  const state = await createOAuthState('user-abc', { db, purpose: 'google_sheets' });
  const result = await consumeOAuthState(state, { db, purpose: 'something_else' });
  assert.equal(result.ok, false);
});

test('unknown nonce with a valid shape is rejected', async () => {
  const db = makeDb();
  // Create in one store, consume against another (row absent).
  const state = await createOAuthState('user-abc', { db: makeDb() });
  const result = await consumeOAuthState(state, { db });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_or_consumed');
});
