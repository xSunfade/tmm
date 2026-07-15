// Grace-expiry sweep (Phase 4.4 — D11): day-7 enforcement is ours, not
// Stripe's. Profiles still past_due when grace lapses are downgraded,
// archived, and Plaid-suspended.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraceExpirySweep } from '../lib/entitlementSweeps.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const NOW = new Date('2026-07-15T12:00:00Z');

function makeDb(profiles) {
  return createFakeSupabase({
    profiles: { rows: profiles },
    plaid_tokens: {
      rows: [{ item_id: 'item-1', user_id: 'u-expired', suspended_at: null, retention_expires_at: null }]
    },
    plaid_item_status: { rows: [{ user_id: 'u-expired', item_id: 'item-1', status: 'healthy' }] },
    plaid_connection_events: { rows: [] },
    audit_log: { rows: [] }
  });
}

test('sweep downgrades only past_due profiles whose grace has lapsed', async () => {
  const db = makeDb([
    { id: 'u-expired', plan_tier: 'tmm_plus', subscription_status: 'past_due', grace_expires_at: '2026-07-14T00:00:00Z' },
    { id: 'u-in-grace', plan_tier: 'tmm_plus', subscription_status: 'past_due', grace_expires_at: '2026-07-20T00:00:00Z' },
    { id: 'u-active', plan_tier: 'tmm_plus', subscription_status: 'active', grace_expires_at: null },
    { id: 'u-already-free', plan_tier: 'free', subscription_status: 'past_due', grace_expires_at: '2026-07-01T00:00:00Z' }
  ]);
  const archived = [];
  const result = await runGraceExpirySweep({ now: NOW, db, archiveSnapshot: async (userId) => archived.push(userId) });

  assert.equal(result.downgraded, 1);
  const rows = Object.fromEntries(db.rows('profiles').map((p) => [p.id, p]));
  assert.equal(rows['u-expired'].plan_tier, 'free');
  assert.equal(rows['u-in-grace'].plan_tier, 'tmm_plus');
  assert.equal(rows['u-active'].plan_tier, 'tmm_plus');
  assert.deepEqual(archived, ['u-expired']);

  // Plaid suspension landed for the downgraded user (ADR-6).
  const token = db.rows('plaid_tokens')[0];
  assert.ok(token.suspended_at);
  assert.ok(token.retention_expires_at);
});

test('sweep is idempotent: a second run downgrades nothing new', async () => {
  const db = makeDb([
    { id: 'u-expired', plan_tier: 'tmm_plus', subscription_status: 'past_due', grace_expires_at: '2026-07-14T00:00:00Z' }
  ]);
  const noop = async () => {};
  const first = await runGraceExpirySweep({ now: NOW, db, archiveSnapshot: noop });
  assert.equal(first.downgraded, 1);
  const second = await runGraceExpirySweep({ now: NOW, db, archiveSnapshot: noop });
  assert.equal(second.downgraded, 0);
});
