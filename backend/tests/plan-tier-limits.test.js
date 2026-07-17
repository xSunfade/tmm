// Free-tier plan-save limits (Phase 4.5 — D8/D9): free plans cap scenario
// alternatives at save time; over-limit content after a downgrade is
// trimmable but cannot grow; entitlement-service failures never block saves.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createPutPlanHandler, countPlanAlternatives } from '../lib/planHandlers.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

function makeFakePlansDb(existingPlan = null) {
  return createFakeSupabase({
    plans: {
      rows: existingPlan
        ? [{ user_id: 'user-1', plan: existingPlan, schema_version: '3.0', client_saved_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z' }]
        : []
    },
    plan_revisions: { rows: [] }
  });
}

// The generic fake lacks the plans upsert chain shape; patch a minimal one on.
function patchUpsert(db) {
  const rows = db.rows('plans');
  const origFrom = db.from.bind(db);
  db.from = (table) => {
    const base = origFrom(table);
    if (table !== 'plans') return base;
    return {
      ...base,
      upsert(values) {
        let row = rows.find((r) => r.user_id === values.user_id);
        if (row) Object.assign(row, values);
        else { row = { ...values }; rows.push(row); }
        row.updated_at = new Date().toISOString();
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
      }
    };
  };
  return db;
}

function planWithAlternatives(n) {
  const alternatives = {};
  for (let i = 0; i < n; i += 1) alternatives[`Alt${i}`] = { income: [], expense: [] };
  return { schemaVersion: '3.0', alternatives };
}

function makeApp(db, entitlements) {
  const app = express();
  app.use(express.json({ limit: '6mb' }));
  app.use((req, _res, next) => { req.userId = 'user-1'; next(); });
  app.put('/api/plan', createPutPlanHandler({
    supabaseAdmin: db,
    resolveEntitlements: entitlements,
    logger: { warn: () => {} }
  }));
  return app;
}

async function putPlan(app, plan) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan, schema_version: '3.0', client_saved_at: new Date().toISOString() })
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const freeEntitlements = async () => ({ tier: 'free', entitlements: { maxAlternatives: 3, maxHorizonYears: 5, plaidEnabled: false, maxPlaidItems: 0, extras: {} } });
const paidEntitlements = async () => ({ tier: 'tmm_plus', entitlements: { maxAlternatives: null, maxHorizonYears: null, plaidEnabled: true, maxPlaidItems: 3, extras: {} } });

test('countPlanAlternatives counts scenario keys', () => {
  assert.equal(countPlanAlternatives(planWithAlternatives(4)), 4);
  assert.equal(countPlanAlternatives({}), 0);
  assert.equal(countPlanAlternatives(null), 0);
});

test('free tier: saving within the limit succeeds', async () => {
  const app = makeApp(patchUpsert(makeFakePlansDb()), freeEntitlements);
  const result = await putPlan(app, planWithAlternatives(3));
  assert.equal(result.status, 200);
});

test('free tier: adding a 4th scenario is rejected with tier_limit_exceeded', async () => {
  const app = makeApp(patchUpsert(makeFakePlansDb(planWithAlternatives(3))), freeEntitlements);
  const result = await putPlan(app, planWithAlternatives(4));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'tier_limit_exceeded');
  assert.equal(result.body.max, 3);
  assert.equal(result.body.count, 4);
});

test('downgrade read-only rule (D9): over-limit plans can be saved when trimming, not growing', async () => {
  // Existing server plan has 5 alternatives (saved while on TMM+).
  const db = patchUpsert(makeFakePlansDb(planWithAlternatives(5)));
  const app = makeApp(db, freeEntitlements);

  // Same count (edit without adding): allowed.
  const same = await putPlan(app, planWithAlternatives(5));
  assert.equal(same.status, 200);

  // Trimming toward the limit: allowed.
  const trim = await putPlan(app, planWithAlternatives(4));
  assert.equal(trim.status, 200);

  // Growing while over the limit: rejected.
  const grow = await putPlan(app, planWithAlternatives(6));
  assert.equal(grow.status, 403);
});

test('paid tier: unlimited alternatives', async () => {
  const app = makeApp(patchUpsert(makeFakePlansDb()), paidEntitlements);
  const result = await putPlan(app, planWithAlternatives(12));
  assert.equal(result.status, 200);
});

test('entitlement resolution failure fails open on the save path (availability over enforcement)', async () => {
  const failing = async () => { throw new Error('resolver down'); };
  const app = makeApp(patchUpsert(makeFakePlansDb()), failing);
  const result = await putPlan(app, planWithAlternatives(10));
  assert.equal(result.status, 200);
});
