// Stripe webhook processor scenarios (Phase 4.14 — the money-path matrix
// from the billing runbook §9): subscribe, cancel, payment-failure grace,
// resubscribe, unknown price, replayed event, checkout linking.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStripeWebhookProcessor } from '../lib/stripeWebhookHandlers.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const NOW = new Date('2026-07-15T12:00:00Z');
const silentLogger = { error: () => {}, warn: () => {} };

const CATALOG_ROWS = [
  { stripe_price_id: 'price_plus_m', lookup_key: 'tmm_plus_monthly', tier: 'tmm_plus', billing_interval: 'month', active: true },
  { stripe_price_id: 'price_pro_m', lookup_key: 'tmm_pro_monthly', tier: 'tmm_pro', billing_interval: 'month', active: true }
];

function setup({ profile } = {}) {
  const db = createFakeSupabase({
    profiles: {
      rows: [profile || {
        id: 'u1', plan_tier: 'free', subscription_status: null,
        stripe_price_id: null, stripe_subscription_id: null,
        stripe_customer_id: 'cus_1', current_period_end: null,
        grace_expires_at: null, is_admin: false
      }]
    },
    plan_catalog: { rows: CATALOG_ROWS },
    stripe_events: { rows: [], unique: ['event_id'] }
  });
  const calls = { suspend: [], restore: [], archive: [] };
  const process_ = createStripeWebhookProcessor({
    supabaseAdmin: db,
    logger: silentLogger,
    archiveSnapshot: async (userId, meta) => calls.archive.push({ userId, meta }),
    suspendPlaid: async (userId, opts) => calls.suspend.push({ userId, ...opts }),
    restorePlaid: async (userId) => calls.restore.push({ userId }),
    now: () => NOW
  });
  return { db, calls, process: process_ };
}

function subscriptionEvent(type, { id = 'evt_1', status = 'active', priceId = 'price_plus_m', subId = 'sub_1', customer = 'cus_1', periodEnd = 1784000000 } = {}) {
  return {
    id,
    type,
    data: {
      object: {
        id: subId,
        customer,
        status,
        current_period_end: periodEnd,
        items: { data: [{ price: { id: priceId, lookup_key: null } }] },
        metadata: {}
      }
    }
  };
}

function profileOf(db) {
  return db.rows('profiles')[0];
}

test('subscribe: active subscription with known price grants the tier and persists state (PAY-3)', async () => {
  const { db, process: run } = setup();
  const result = await run(subscriptionEvent('customer.subscription.created'));
  assert.equal(result.outcome, 'processed');
  const p = profileOf(db);
  assert.equal(p.plan_tier, 'tmm_plus');
  assert.equal(p.subscription_status, 'active');
  assert.equal(p.stripe_subscription_id, 'sub_1');
  assert.equal(p.stripe_price_id, 'price_plus_m');
  assert.ok(p.current_period_end);
});

test('incomplete subscription does NOT entitle (pre-payment status)', async () => {
  const { db, process: run } = setup();
  await run(subscriptionEvent('customer.subscription.created', { status: 'incomplete' }));
  assert.equal(profileOf(db).plan_tier, 'free');
});

test('unknown price is ignored for entitlement (PAY-2): tier stays free', async () => {
  const { db, process: run } = setup();
  await run(subscriptionEvent('customer.subscription.created', { priceId: 'price_someone_elses' }));
  const p = profileOf(db);
  assert.equal(p.plan_tier, 'free');
  assert.equal(p.subscription_status, 'active'); // state recorded, tier not granted
});

test('replayed event id is a no-op (PAY-5 idempotency)', async () => {
  const { db, process: run } = setup();
  const first = await run(subscriptionEvent('customer.subscription.created', { id: 'evt_dup' }));
  assert.equal(first.outcome, 'processed');
  // Manually flip tier to prove the replay does not re-apply anything.
  profileOf(db).plan_tier = 'free';
  const replay = await run(subscriptionEvent('customer.subscription.created', { id: 'evt_dup' }));
  assert.equal(replay.outcome, 'replay');
  assert.equal(profileOf(db).plan_tier, 'free');
});

test('cancel: subscription.deleted downgrades, archives, and suspends Plaid (ADR-6)', async () => {
  const { db, calls, process: run } = setup({
    profile: {
      id: 'u1', plan_tier: 'tmm_plus', subscription_status: 'active',
      stripe_price_id: 'price_plus_m', stripe_subscription_id: 'sub_1',
      stripe_customer_id: 'cus_1', current_period_end: null,
      grace_expires_at: null, is_admin: false
    }
  });
  await run(subscriptionEvent('customer.subscription.deleted', { status: 'canceled' }));
  const p = profileOf(db);
  assert.equal(p.plan_tier, 'free');
  assert.equal(p.subscription_status, 'canceled');
  assert.equal(calls.suspend.length, 1);
  assert.equal(calls.archive.length, 1);
});

test('past_due: grace stamped once, tier retained during the 7-day window (D11)', async () => {
  const { db, calls, process: run } = setup({
    profile: {
      id: 'u1', plan_tier: 'tmm_plus', subscription_status: 'active',
      stripe_price_id: 'price_plus_m', stripe_subscription_id: 'sub_1',
      stripe_customer_id: 'cus_1', current_period_end: null,
      grace_expires_at: null, is_admin: false
    }
  });
  await run(subscriptionEvent('customer.subscription.updated', { id: 'evt_pd1', status: 'past_due' }));
  const p = profileOf(db);
  assert.equal(p.plan_tier, 'tmm_plus'); // still entitled during grace
  assert.equal(p.subscription_status, 'past_due');
  assert.equal(p.grace_expires_at, new Date(NOW.getTime() + 7 * 86400_000).toISOString());
  assert.equal(calls.suspend.length, 0);

  // A second past_due update must NOT extend the original deadline.
  const originalGrace = p.grace_expires_at;
  await run(subscriptionEvent('customer.subscription.updated', { id: 'evt_pd2', status: 'past_due' }));
  assert.equal(profileOf(db).grace_expires_at, originalGrace);
});

test('invoice.payment_failed stamps grace without touching the tier', async () => {
  const { db, process: run } = setup({
    profile: {
      id: 'u1', plan_tier: 'tmm_plus', subscription_status: 'active',
      stripe_price_id: 'price_plus_m', stripe_subscription_id: 'sub_1',
      stripe_customer_id: 'cus_1', current_period_end: null,
      grace_expires_at: null, is_admin: false
    }
  });
  const result = await run({
    id: 'evt_if',
    type: 'invoice.payment_failed',
    data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: {} } }
  });
  assert.equal(result.outcome, 'processed');
  const p = profileOf(db);
  assert.equal(p.plan_tier, 'tmm_plus');
  assert.equal(p.subscription_status, 'past_due');
  assert.ok(p.grace_expires_at);
});

test('invoice.paid clears the grace clock', async () => {
  const { db, process: run } = setup({
    profile: {
      id: 'u1', plan_tier: 'tmm_plus', subscription_status: 'past_due',
      stripe_price_id: 'price_plus_m', stripe_subscription_id: 'sub_1',
      stripe_customer_id: 'cus_1', current_period_end: null,
      grace_expires_at: '2026-07-20T00:00:00Z', is_admin: false
    }
  });
  await run({ id: 'evt_ip', type: 'invoice.paid', data: { object: { customer: 'cus_1', metadata: {} } } });
  assert.equal(profileOf(db).grace_expires_at, null);
});

test('resubscribe: free -> paid transition restores Plaid (ADR-6)', async () => {
  const { db, calls, process: run } = setup({
    profile: {
      id: 'u1', plan_tier: 'free', subscription_status: 'canceled',
      stripe_price_id: 'price_plus_m', stripe_subscription_id: 'sub_old',
      stripe_customer_id: 'cus_1', current_period_end: null,
      grace_expires_at: null, is_admin: false
    }
  });
  await run(subscriptionEvent('customer.subscription.created', { subId: 'sub_new' }));
  const p = profileOf(db);
  assert.equal(p.plan_tier, 'tmm_plus');
  assert.equal(p.stripe_subscription_id, 'sub_new');
  assert.equal(calls.restore.length, 1);
});

test('checkout.session.completed links customer and subscription to the paying user (PAY-4)', async () => {
  const { db, process: run } = setup({
    profile: {
      id: 'u1', plan_tier: 'free', subscription_status: null,
      stripe_price_id: null, stripe_subscription_id: null,
      stripe_customer_id: null, current_period_end: null,
      grace_expires_at: null, is_admin: false
    }
  });
  const result = await run({
    id: 'evt_cs',
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'u1', customer: 'cus_new', subscription: 'sub_new', metadata: {} } }
  });
  assert.equal(result.outcome, 'processed');
  const p = profileOf(db);
  assert.equal(p.stripe_customer_id, 'cus_new');
  assert.equal(p.stripe_subscription_id, 'sub_new');
});

test('events for unknown customers are recorded and ignored, never a crash', async () => {
  const { db, process: run } = setup();
  const result = await run(subscriptionEvent('customer.subscription.updated', { customer: 'cus_stranger' }));
  assert.equal(result.outcome, 'ignored');
  const events = db.rows('stripe_events');
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'ignored');
});

test('unhandled event types are recorded as ignored', async () => {
  const { db, process: run } = setup();
  const result = await run({ id: 'evt_x', type: 'customer.updated', data: { object: {} } });
  assert.equal(result.outcome, 'ignored');
  assert.equal(db.rows('stripe_events')[0].outcome, 'ignored');
});
