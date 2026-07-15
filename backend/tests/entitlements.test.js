// Entitlement resolution matrix (ADR-3 / D7 / D10 / D11). Every subscription
// status Stripe can emit is pinned here — an unknown status failing open
// would be a money-path bug (paid features for free).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTierFromSubscription,
  createEntitlementResolver,
  PLAID_ITEM_ABSOLUTE_CEILING
} from '../lib/entitlements.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const silentLogger = { error: () => {} };
const NOW = new Date('2026-07-15T12:00:00Z');
const FUTURE = new Date('2026-07-20T12:00:00Z').toISOString();
const PAST = new Date('2026-07-10T12:00:00Z').toISOString();

test('status matrix: entitled statuses grant the catalog tier', () => {
  for (const status of ['active', 'trialing']) {
    const result = resolveTierFromSubscription({ status, catalogTier: 'tmm_plus', graceExpiresAt: null, now: NOW, logger: silentLogger });
    assert.equal(result.tier, 'tmm_plus', `status=${status}`);
  }
});

test('status matrix: pre-payment and terminal statuses resolve Free', () => {
  for (const status of ['incomplete', 'incomplete_expired', 'canceled', 'unpaid', 'paused']) {
    const result = resolveTierFromSubscription({ status, catalogTier: 'tmm_plus', graceExpiresAt: null, now: NOW, logger: silentLogger });
    assert.equal(result.tier, 'free', `status=${status}`);
  }
});

test('status matrix: past_due keeps the tier during grace, drops after', () => {
  const inGrace = resolveTierFromSubscription({ status: 'past_due', catalogTier: 'tmm_plus', graceExpiresAt: FUTURE, now: NOW, logger: silentLogger });
  assert.equal(inGrace.tier, 'tmm_plus');
  assert.equal(inGrace.reason, 'past_due_grace');

  const expired = resolveTierFromSubscription({ status: 'past_due', catalogTier: 'tmm_plus', graceExpiresAt: PAST, now: NOW, logger: silentLogger });
  assert.equal(expired.tier, 'free');
  assert.equal(expired.reason, 'grace_expired');

  const noGrace = resolveTierFromSubscription({ status: 'past_due', catalogTier: 'tmm_plus', graceExpiresAt: null, now: NOW, logger: silentLogger });
  assert.equal(noGrace.tier, 'free');
});

test('status matrix: unknown status fails closed to Free with an alert', () => {
  let alerted = false;
  const logger = { error: () => { alerted = true; } };
  const result = resolveTierFromSubscription({ status: 'some_future_status', catalogTier: 'tmm_pro', graceExpiresAt: null, now: NOW, logger });
  assert.equal(result.tier, 'free');
  assert.equal(result.reason, 'unknown_status');
  assert.equal(alerted, true);
});

test('status matrix: unknown price fails closed to Free with an alert (PAY-2)', () => {
  let alerted = false;
  const logger = { error: () => { alerted = true; } };
  const result = resolveTierFromSubscription({ status: 'active', catalogTier: null, graceExpiresAt: null, now: NOW, logger });
  assert.equal(result.tier, 'free');
  assert.equal(result.reason, 'unknown_price');
  assert.equal(alerted, true);
});

test('status matrix: no subscription resolves Free without alerting', () => {
  const result = resolveTierFromSubscription({ status: '', catalogTier: null, graceExpiresAt: null, now: NOW, logger: silentLogger });
  assert.equal(result.tier, 'free');
  assert.equal(result.reason, 'no_subscription');
});

// ---------------------------------------------------------------------------
// Full resolver against a fake DB
// ---------------------------------------------------------------------------

const ENTITLEMENT_ROWS = [
  { tier: 'free', max_alternatives: 3, max_horizon_years: 5, plaid_enabled: false, max_plaid_items: 0, extras: {} },
  { tier: 'tmm_plus', max_alternatives: null, max_horizon_years: null, plaid_enabled: true, max_plaid_items: 3, extras: { advanced_analysis: false } },
  { tier: 'tmm_pro', max_alternatives: null, max_horizon_years: null, plaid_enabled: true, max_plaid_items: 6, extras: { advanced_analysis: true } }
];
const CATALOG_ROWS = [
  { stripe_price_id: 'price_plus_m', lookup_key: 'tmm_plus_monthly', tier: 'tmm_plus', billing_interval: 'month', active: true },
  { stripe_price_id: 'price_pro_m', lookup_key: 'tmm_pro_monthly', tier: 'tmm_pro', billing_interval: 'month', active: true },
  { stripe_price_id: 'price_retired', lookup_key: 'old', tier: 'tmm_plus', billing_interval: 'month', active: false }
];

function makeResolver(profileRow) {
  const db = createFakeSupabase({
    profiles: { rows: profileRow ? [profileRow] : [] },
    plan_catalog: { rows: CATALOG_ROWS },
    tier_entitlements: { rows: ENTITLEMENT_ROWS }
  });
  return createEntitlementResolver({ supabaseAdmin: db, logger: silentLogger, now: () => NOW });
}

test('resolver: active subscription with known price gets paid entitlements', async () => {
  const resolve = makeResolver({
    id: 'u1', plan_tier: 'tmm_plus', subscription_status: 'active',
    stripe_price_id: 'price_plus_m', stripe_subscription_id: 'sub_1',
    current_period_end: FUTURE, grace_expires_at: null, is_admin: false
  });
  const result = await resolve('u1');
  assert.equal(result.tier, 'tmm_plus');
  assert.equal(result.entitlements.plaidEnabled, true);
  assert.equal(result.entitlements.maxPlaidItems, 3);
  assert.equal(result.entitlements.maxAlternatives, null);
});

test('resolver: inactive catalog price resolves Free (retired price grants nothing)', async () => {
  const resolve = makeResolver({
    id: 'u1', plan_tier: 'tmm_plus', subscription_status: 'active',
    stripe_price_id: 'price_retired', stripe_subscription_id: 'sub_1',
    current_period_end: FUTURE, grace_expires_at: null, is_admin: false
  });
  const result = await resolve('u1');
  assert.equal(result.tier, 'free');
  assert.equal(result.entitlements.plaidEnabled, false);
});

test('resolver: past_due with lapsed grace resolves Free even before the sweep runs', async () => {
  const resolve = makeResolver({
    id: 'u1', plan_tier: 'tmm_plus', subscription_status: 'past_due',
    stripe_price_id: 'price_plus_m', stripe_subscription_id: 'sub_1',
    current_period_end: PAST, grace_expires_at: PAST, is_admin: false
  });
  const result = await resolve('u1');
  assert.equal(result.tier, 'free');
});

test('resolver: manual grant (no subscription on record) honors stored plan_tier', async () => {
  const resolve = makeResolver({
    id: 'u1', plan_tier: 'tmm_plus', subscription_status: null,
    stripe_price_id: null, stripe_subscription_id: null,
    current_period_end: null, grace_expires_at: null, is_admin: true
  });
  const result = await resolve('u1');
  assert.equal(result.tier, 'tmm_plus');
  assert.equal(result.reason, 'manual_grant');
  assert.equal(result.isAdmin, true);
});

test('resolver: missing profile fails closed to Free limits', async () => {
  const resolve = makeResolver(null);
  const result = await resolve('u-missing');
  assert.equal(result.tier, 'free');
  assert.equal(result.entitlements.plaidEnabled, false);
});

test('resolver: item cap is bounded by the absolute ceiling', async () => {
  const db = createFakeSupabase({
    profiles: {
      rows: [{
        id: 'u1', plan_tier: 'tmm_pro', subscription_status: null,
        stripe_price_id: null, stripe_subscription_id: null,
        current_period_end: null, grace_expires_at: null, is_admin: false
      }]
    },
    plan_catalog: { rows: CATALOG_ROWS },
    tier_entitlements: {
      rows: [{ tier: 'tmm_pro', max_alternatives: null, max_horizon_years: null, plaid_enabled: true, max_plaid_items: 999, extras: {} }]
    }
  });
  const resolve = createEntitlementResolver({ supabaseAdmin: db, logger: silentLogger, now: () => NOW });
  const result = await resolve('u1');
  assert.equal(result.entitlements.maxPlaidItems, PLAID_ITEM_ABSOLUTE_CEILING);
});
