// History Net Worth E2E Test
// Validates GET/POST history endpoints, checkpoint merge, and coverage metadata behavior.

import dotenv from 'dotenv';

dotenv.config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const AUTH_TOKEN = process.env.TMM_PLUS_JWT || process.env.FREE_JWT || '';

function authHeaders() {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function iso(value) {
  return String(value || '').slice(0, 10);
}

async function assertBackendReachable() {
  try {
    const response = await fetch(`${BACKEND_URL}/api/health`);
    if (!response.ok) {
      throw new Error(`health endpoint returned ${response.status}`);
    }
  } catch (err) {
    throw new Error(
      `Backend not reachable at ${BACKEND_URL}. Start backend first (details: ${err.message || err})`
    );
  }
}

async function testGetHistory() {
  const response = await fetch(
    `${BACKEND_URL}/api/history/net-worth?start_date=2025-01-01&end_date=2025-12-31`,
    {
      method: 'GET',
      headers: authHeaders()
    }
  );
  const json = await response.json();

  assert(response.status === 200, `GET history failed: ${response.status} ${JSON.stringify(json)}`);
  assert(Array.isArray(json.points), 'GET history did not return points array');
  assert(json.as_of_rule === 'end_of_day_utc', `unexpected as_of_rule: ${json.as_of_rule}`);
  assert(json.coverage && typeof json.coverage === 'object', 'coverage metadata missing');
  const sorted = [...json.points].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  assert(
    JSON.stringify(sorted.map((p) => String(p.date))) === JSON.stringify(json.points.map((p) => String(p.date))),
    'GET history points are not sorted by date ascending'
  );
}

async function testPostHistoryWithCheckpointsMerge() {
  // Pre-read current history so we can choose an actual Plaid-backed date for precedence assertion.
  const pre = await fetch(
    `${BACKEND_URL}/api/history/net-worth?start_date=2024-12-01&end_date=2025-12-31`,
    { method: 'GET', headers: authHeaders() }
  );
  const preJson = await pre.json();
  assert(pre.status === 200, `pre-read history failed: ${pre.status} ${JSON.stringify(preJson)}`);
  const plaidPoint = (preJson.points || []).find((p) => p.source === 'plaid_live' || p.source === 'plaid_archived');
  const plaidDate = plaidPoint ? iso(plaidPoint.date) : null;

  const checkpoints = [
    // should be overridden by an existing Plaid-backed date when available.
    ...(plaidDate ? [{ date: plaidDate, netWorth: 1200, source: 'manual-input', confidence: 'high' }] : []),
    // should remain checkpoint outside seeded Plaid points
    { date: '2024-12-31', netWorth: 900, source: 'manual-input', confidence: 'med' }
  ];

  const response = await fetch(`${BACKEND_URL}/api/history/net-worth`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      start_date: '2024-12-01',
      end_date: '2025-12-31',
      checkpoints
    })
  });
  const json = await response.json();

  assert(response.status === 200, `POST history failed: ${response.status} ${JSON.stringify(json)}`);
  assert(Array.isArray(json.points), 'POST history did not return points array');
  const byDate = new Map(json.points.map((p) => [iso(p.date), p]));

  if (plaidDate) {
    const plaidWinner = byDate.get(plaidDate);
    assert(!!plaidWinner, `Expected merged point at ${plaidDate}`);
    assert(
      plaidWinner.source === 'plaid_live' || plaidWinner.source === 'plaid_archived',
      `Expected Plaid source to win on ${plaidDate}, got ${plaidWinner.source}`
    );
    assert(
      Number(plaidWinner.value) !== 1200,
      `Checkpoint unexpectedly overrode Plaid on ${plaidDate} (value=${plaidWinner.value})`
    );
  } else {
    console.log('ℹ️  No Plaid-backed point found in requested range; skipping Plaid precedence assertion.');
  }

  const dec = byDate.get('2024-12-31');
  assert(!!dec, 'Expected fallback checkpoint point at 2024-12-31');
  assert(
    dec.source === 'checkpoint_user' || dec.source === 'checkpoint_auto',
    `Expected checkpoint source outside coverage, got ${dec.source}`
  );
  assert(Number(dec.value) === 900, `Expected checkpoint fallback value 900 at 2024-12-31, got ${dec.value}`);
}

async function run() {
  console.log('🧪 Running history net-worth e2e test...\n');
  console.log(`Backend URL: ${BACKEND_URL}`);

  if (!AUTH_TOKEN) {
    console.log('⏭️  Skipping history net-worth e2e test.');
    console.log('   Missing auth token. Set TMM_PLUS_JWT or FREE_JWT.');
    process.exit(0);
  }

  try {
    await assertBackendReachable();
    console.log('✅ backend reachable');

    await testGetHistory();
    console.log('✅ GET /api/history/net-worth');

    await testPostHistoryWithCheckpointsMerge();
    console.log('✅ POST /api/history/net-worth checkpoint merge');

    console.log('\n✅ History net-worth e2e test passed');
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ History net-worth e2e test failed: ${err.message}`);
    process.exit(1);
  }
}

run();
