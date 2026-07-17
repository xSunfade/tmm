// Plaid lifecycle state machine (Phase 4.8 — ADR-6 / D12):
// suspend -> retention -> restore-or-revoke, with the fake DB standing in for
// plaid_tokens / plaid_item_status / plaid_connection_events / audit_log.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suspendPlaidForUser,
  restorePlaidForUser,
  revokeExpiredPlaidTokens,
  isPlaidSuspendedForUser,
  PLAID_TOKEN_RETENTION_DAYS
} from '../lib/plaidLifecycle.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

function makeDb({ tokens = [], statuses = [] } = {}) {
  return createFakeSupabase({
    plaid_tokens: { rows: tokens },
    plaid_item_status: { rows: statuses },
    plaid_connection_events: { rows: [] },
    audit_log: { rows: [] }
  });
}

const TWO_TOKENS = [
  { item_id: 'item-1', user_id: 'u1', suspended_at: null, retention_expires_at: null },
  { item_id: 'item-2', user_id: 'u1', suspended_at: null, retention_expires_at: null }
];

test('suspend stamps every item with suspension + 30-day retention and logs events', async () => {
  const db = makeDb({
    tokens: TWO_TOKENS,
    statuses: [
      { user_id: 'u1', item_id: 'item-1', status: 'healthy' },
      { user_id: 'u1', item_id: 'item-2', status: 'healthy' }
    ]
  });
  const result = await suspendPlaidForUser('u1', { reason: 'downgrade', db });
  assert.equal(result.suspended, 2);

  for (const row of db.rows('plaid_tokens')) {
    assert.ok(row.suspended_at, `${row.item_id} suspended_at`);
    assert.ok(row.retention_expires_at, `${row.item_id} retention`);
    const days = (new Date(row.retention_expires_at) - new Date(row.suspended_at)) / 86400_000;
    assert.equal(Math.round(days), PLAID_TOKEN_RETENTION_DAYS);
  }
  for (const s of db.rows('plaid_item_status')) {
    assert.equal(s.status, 'suspended');
  }
  const events = db.rows('plaid_connection_events');
  assert.equal(events.filter((e) => e.event_type === 'suspend').length, 2);
  assert.equal(await isPlaidSuspendedForUser('u1', db), true);
});

test('suspend is idempotent: an already-suspended item keeps its original deadline', async () => {
  const original = '2026-08-01T00:00:00.000Z';
  const db = makeDb({
    tokens: [{ item_id: 'item-1', user_id: 'u1', suspended_at: '2026-07-02T00:00:00.000Z', retention_expires_at: original }]
  });
  const result = await suspendPlaidForUser('u1', { reason: 'downgrade', db });
  assert.equal(result.suspended, 0);
  assert.equal(db.rows('plaid_tokens')[0].retention_expires_at, original);
});

test('restore clears suspension, resumes status, and enqueues catch-up syncs', async () => {
  const db = makeDb({
    tokens: [
      { item_id: 'item-1', user_id: 'u1', suspended_at: '2026-07-02T00:00:00.000Z', retention_expires_at: '2026-08-01T00:00:00.000Z' }
    ],
    statuses: [{ user_id: 'u1', item_id: 'item-1', status: 'suspended' }]
  });
  const enqueued = [];
  const result = await restorePlaidForUser('u1', {
    db,
    enqueueCatchUpSync: async (args) => enqueued.push(args)
  });
  assert.equal(result.restored, 1);
  const token = db.rows('plaid_tokens')[0];
  assert.equal(token.suspended_at, null);
  assert.equal(token.retention_expires_at, null);
  assert.equal(db.rows('plaid_item_status')[0].status, 'healthy');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].itemId, 'item-1');
  assert.equal(await isPlaidSuspendedForUser('u1', db), false);
});

test('revocation sweep removes only expired tokens, calls itemRemove, marks status revoked', async () => {
  const db = makeDb({
    tokens: [
      { item_id: 'expired-item', user_id: 'u1', access_token: 'enc', suspended_at: '2026-06-01T00:00:00.000Z', retention_expires_at: '2026-07-01T00:00:00.000Z' },
      { item_id: 'still-waiting', user_id: 'u1', access_token: 'enc', suspended_at: '2026-07-10T00:00:00.000Z', retention_expires_at: '2026-08-09T00:00:00.000Z' }
    ],
    statuses: [
      { user_id: 'u1', item_id: 'expired-item', status: 'suspended' },
      { user_id: 'u1', item_id: 'still-waiting', status: 'suspended' }
    ]
  });
  const removed = [];
  const deleted = [];
  const result = await revokeExpiredPlaidTokens({
    now: new Date('2026-07-15T00:00:00Z'),
    db,
    plaid: { itemRemove: async ({ access_token }) => removed.push(access_token) },
    getAccessToken: async (itemId) => `token-${itemId}`,
    deleteToken: async (itemId) => {
      deleted.push(itemId);
      const table = db.rows('plaid_tokens');
      const idx = table.findIndex((r) => r.item_id === itemId);
      if (idx >= 0) table.splice(idx, 1);
    }
  });
  assert.deepEqual(result, { revoked: 1, failed: 0 });
  assert.deepEqual(removed, ['token-expired-item']);
  assert.deepEqual(deleted, ['expired-item']);
  assert.equal(db.rows('plaid_tokens').length, 1);
  assert.equal(db.rows('plaid_tokens')[0].item_id, 'still-waiting');
  const statusRow = db.rows('plaid_item_status').find((s) => s.item_id === 'expired-item');
  assert.equal(statusRow.status, 'revoked');
  const events = db.rows('plaid_connection_events');
  assert.equal(events.filter((e) => e.event_type === 'revoke').length, 1);
});

test('revocation proceeds locally when the item is already gone at Plaid', async () => {
  const db = makeDb({
    tokens: [{ item_id: 'expired-item', user_id: 'u1', suspended_at: '2026-06-01T00:00:00.000Z', retention_expires_at: '2026-07-01T00:00:00.000Z' }]
  });
  const err = new Error('item not found');
  err.response = { data: { error_code: 'ITEM_NOT_FOUND' } };
  const deleted = [];
  const result = await revokeExpiredPlaidTokens({
    now: new Date('2026-07-15T00:00:00Z'),
    db,
    plaid: { itemRemove: async () => { throw err; } },
    getAccessToken: async () => 'tok',
    deleteToken: async (itemId) => deleted.push(itemId)
  });
  assert.equal(result.revoked, 1);
  assert.deepEqual(deleted, ['expired-item']);
});

test('transient Plaid failure keeps the token for the next sweep (retry, alert)', async () => {
  const db = makeDb({
    tokens: [{ item_id: 'expired-item', user_id: 'u1', suspended_at: '2026-06-01T00:00:00.000Z', retention_expires_at: '2026-07-01T00:00:00.000Z' }]
  });
  const err = new Error('rate limited');
  err.response = { data: { error_code: 'RATE_LIMIT_EXCEEDED' } };
  const deleted = [];
  const result = await revokeExpiredPlaidTokens({
    now: new Date('2026-07-15T00:00:00Z'),
    db,
    plaid: { itemRemove: async () => { throw err; } },
    getAccessToken: async () => 'tok',
    deleteToken: async (itemId) => deleted.push(itemId)
  });
  assert.deepEqual(result, { revoked: 0, failed: 1 });
  assert.equal(deleted.length, 0);
  assert.equal(db.rows('plaid_tokens').length, 1);
});
