import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'crypto';
import {
  createGetPlanHandler,
  createPutPlanHandler,
  createListPlanRevisionsHandler,
  createGetPlanRevisionHandler,
  PLAN_REVISION_KEEP
} from '../lib/planHandlers.js';

// ---------------------------------------------------------------------------
// In-memory fake for the two tables the plan handlers touch. Supports the
// exact query chains used by the handlers; anything else throws loudly.
// ---------------------------------------------------------------------------

function createFakeSupabase() {
  const plans = new Map(); // user_id -> row
  const revisions = []; // rows

  function planRow(userId) {
    return plans.get(userId) || null;
  }

  const client = {
    from(table) {
      if (table === 'plans') {
        return {
          select() {
            return {
              eq: (_col, userId) => ({
                maybeSingle: async () => ({ data: planRow(userId), error: null })
              })
            };
          },
          upsert(values) {
            const existing = plans.get(values.user_id) || {};
            const row = {
              ...existing,
              ...values,
              updated_at: new Date().toISOString()
            };
            plans.set(values.user_id, row);
            return {
              select: () => ({
                single: async () => ({ data: row, error: null })
              })
            };
          }
        };
      }
      if (table === 'plan_revisions') {
        return {
          insert: async (values) => {
            revisions.push({
              id: randomUUID(),
              created_at: new Date(Date.now() + revisions.length).toISOString(),
              ...values
            });
            return { error: null };
          },
          select(_cols) {
            const chain = {
              _userId: null,
              _revisionId: null,
              eq(col, value) {
                if (col === 'user_id') chain._userId = value;
                if (col === 'id') chain._revisionId = value;
                return chain;
              },
              order() {
                return chain;
              },
              range: async (from, to) => {
                const rows = revisions
                  .filter((r) => r.user_id === chain._userId)
                  .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
                  .slice(from, to + 1);
                return { data: rows, error: null };
              },
              limit: async (n) => {
                const rows = revisions
                  .filter((r) => r.user_id === chain._userId)
                  .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
                  .slice(0, n);
                return { data: rows, error: null };
              },
              maybeSingle: async () => {
                const row = revisions.find(
                  (r) => r.user_id === chain._userId && r.id === chain._revisionId
                );
                return { data: row || null, error: null };
              }
            };
            return chain;
          },
          delete() {
            return {
              in: async (_col, ids) => {
                for (const id of ids) {
                  const idx = revisions.findIndex((r) => r.id === id);
                  if (idx >= 0) revisions.splice(idx, 1);
                }
                return { error: null };
              }
            };
          }
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }
  };

  return { client, plans, revisions };
}

function createApp(fake, { userId = 'user-1' } = {}) {
  const app = express();
  app.use(express.json({ limit: '6mb' }));
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  const quietLogger = { warn: () => {} };
  app.get('/api/plan', createGetPlanHandler({ supabaseAdmin: fake.client }));
  app.put('/api/plan', createPutPlanHandler({ supabaseAdmin: fake.client, logger: quietLogger }));
  app.get('/api/plan/revisions', createListPlanRevisionsHandler({ supabaseAdmin: fake.client }));
  app.get('/api/plan/revisions/:revisionId', createGetPlanRevisionHandler({ supabaseAdmin: fake.client }));
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const SAMPLE_PLAN = { schemaVersion: '2.0', alternatives: { Base: { income: [], expense: [] } } };

function putBody(overrides = {}) {
  return {
    plan: SAMPLE_PLAN,
    schema_version: '2.0',
    client_saved_at: '2026-07-06T12:00:00.000Z',
    ...overrides
  };
}

test('GET /api/plan returns { plan: null } when nothing is saved', async () => {
  const fake = createFakeSupabase();
  await withServer(createApp(fake), async (base) => {
    const res = await fetch(`${base}/api/plan`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { plan: null });
  });
});

test('PUT then GET round-trips the plan document', async () => {
  const fake = createFakeSupabase();
  await withServer(createApp(fake), async (base) => {
    const put = await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(putBody())
    });
    assert.equal(put.status, 200);
    const putJson = await put.json();
    assert.equal(putJson.ok, true);
    assert.equal(putJson.size_warning, false);
    assert.equal(putJson.client_saved_at, '2026-07-06T12:00:00.000Z');

    const get = await fetch(`${base}/api/plan`);
    assert.equal(get.status, 200);
    const getJson = await get.json();
    assert.deepEqual(getJson.plan, SAMPLE_PLAN);
    assert.equal(getJson.schema_version, '2.0');
    assert.equal(getJson.client_saved_at, '2026-07-06T12:00:00.000Z');
  });
});

test('PUT rejects a missing plan object and unsupported schema versions', async () => {
  const fake = createFakeSupabase();
  await withServer(createApp(fake), async (base) => {
    const noPlan = await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema_version: '2.0' })
    });
    assert.equal(noPlan.status, 400);
    assert.equal((await noPlan.json()).code, 'invalid_plan');

    const badVersion = await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(putBody({ schema_version: '9.9' }))
    });
    assert.equal(badVersion.status, 400);
    assert.equal((await badVersion.json()).code, 'unsupported_schema_version');

    // Schema v3 (Phase 3.1) is accepted alongside 2.0 for pre-v3 clients.
    const v3 = await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(putBody({ schema_version: '3.0' }))
    });
    assert.equal(v3.status, 200);
  });
});

test('PUT rejects oversized plans with 413 and flags size warnings', async () => {
  const fake = createFakeSupabase();
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use((req, _res, next) => {
    req.userId = 'user-1';
    next();
  });
  // Tiny thresholds so the test does not shuffle megabytes around.
  app.put(
    '/api/plan',
    createPutPlanHandler({
      supabaseAdmin: fake.client,
      warnBytes: 50,
      maxBytes: 200,
      logger: { warn: () => {} }
    })
  );
  await withServer(app, async (base) => {
    const warn = await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(putBody({ plan: { pad: 'x'.repeat(80) } }))
    });
    assert.equal(warn.status, 200);
    assert.equal((await warn.json()).size_warning, true);

    const reject = await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(putBody({ plan: { pad: 'x'.repeat(500) } }))
    });
    assert.equal(reject.status, 413);
    assert.equal((await reject.json()).code, 'plan_too_large');
  });
});

test('PUT returns 409 when the edit is based on a stale server state', async () => {
  const fake = createFakeSupabase();
  await withServer(createApp(fake), async (base) => {
    const first = await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(putBody({ client_saved_at: '2026-07-06T12:00:00.000Z' }))
    });
    assert.equal(first.status, 200);

    // Second device saved after our base state.
    const conflict = await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        putBody({
          client_saved_at: '2026-07-06T13:00:00.000Z',
          base_client_saved_at: '2026-07-06T11:00:00.000Z'
        })
      )
    });
    assert.equal(conflict.status, 409);
    const conflictJson = await conflict.json();
    assert.equal(conflictJson.code, 'plan_conflict');
    assert.equal(conflictJson.server_client_saved_at, '2026-07-06T12:00:00.000Z');

    // Matching base saves fine.
    const ok = await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        putBody({
          client_saved_at: '2026-07-06T13:00:00.000Z',
          base_client_saved_at: '2026-07-06T12:00:00.000Z'
        })
      )
    });
    assert.equal(ok.status, 200);
  });
});

test('revisions accumulate per save and prune to the newest 20', async () => {
  const fake = createFakeSupabase();
  await withServer(createApp(fake), async (base) => {
    for (let i = 0; i < PLAN_REVISION_KEEP + 5; i += 1) {
      const res = await fetch(`${base}/api/plan`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(putBody({ client_saved_at: null, base_client_saved_at: undefined }))
      });
      assert.equal(res.status, 200);
    }
    assert.equal(fake.revisions.length, PLAN_REVISION_KEEP);

    const list = await fetch(`${base}/api/plan/revisions`);
    assert.equal(list.status, 200);
    const { revisions } = await list.json();
    assert.equal(revisions.length, PLAN_REVISION_KEEP);
    assert.ok(revisions.every((r) => r.reason === 'save'));
  });
});

test('a single revision can be fetched for restore; missing ids 404', async () => {
  const fake = createFakeSupabase();
  await withServer(createApp(fake), async (base) => {
    await fetch(`${base}/api/plan`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(putBody({ reason: 'manual' }))
    });
    const list = await (await fetch(`${base}/api/plan/revisions`)).json();
    const id = list.revisions[0].id;

    const res = await fetch(`${base}/api/plan/revisions/${id}`);
    assert.equal(res.status, 200);
    const { revision } = await res.json();
    assert.deepEqual(revision.plan, SAMPLE_PLAN);
    assert.equal(revision.reason, 'manual');

    const missing = await fetch(`${base}/api/plan/revisions/${randomUUID()}`);
    assert.equal(missing.status, 404);
  });
});
