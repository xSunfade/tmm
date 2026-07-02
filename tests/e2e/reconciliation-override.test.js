// Reconciliation Override E2E Test
// Validates POST /api/history/reconciliation and resulting deterministic history output.

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

async function upsertOverride(chosenSource, checkpointValue, plaidValue) {
  const response = await fetch(`${BACKEND_URL}/api/history/reconciliation`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      point_date: '2025-04-30',
      chosen_source: chosenSource,
      checkpoint_value: checkpointValue,
      plaid_value: plaidValue,
      reason: `e2e ${chosenSource} wins`
    })
  });
  const json = await response.json();
  assert(response.status === 200, `POST reconciliation failed: ${response.status} ${JSON.stringify(json)}`);
  assert(json.ok === true, 'reconciliation response missing ok=true');
  assert(json.override && json.override.point_date === '2025-04-30', 'override payload missing/invalid');
}

async function getPoint(date) {
  const response = await fetch(
    `${BACKEND_URL}/api/history/net-worth?start_date=${encodeURIComponent(date)}&end_date=${encodeURIComponent(date)}`,
    { method: 'GET', headers: authHeaders() }
  );
  const json = await response.json();
  assert(response.status === 200, `GET history failed: ${response.status} ${JSON.stringify(json)}`);
  const point = (json.points || []).find((p) => iso(p.date) === date);
  assert(!!point, `expected point for ${date} after override`);
  return point;
}

async function testCheckpointWinsOverride() {
  await upsertOverride('checkpoint', 1550, 2000);
  const point = await getPoint('2025-04-30');
  assert(point.source === 'checkpoint_user' || point.source === 'checkpoint_auto', `expected checkpoint source, got ${point.source}`);
  assert(Number(point.value) === 1550, `expected checkpoint value 1550, got ${point.value}`);
}

async function testPlaidWinsOverride() {
  await upsertOverride('plaid', 1300, 2100);
  const point = await getPoint('2025-04-30');
  assert(point.source === 'plaid_live' || point.source === 'plaid_archived', `expected plaid source, got ${point.source}`);
  assert(Number(point.value) === 2100, `expected plaid value 2100, got ${point.value}`);
}

async function run() {
  console.log('🧪 Running reconciliation override e2e test...\n');
  console.log(`Backend URL: ${BACKEND_URL}`);

  if (!AUTH_TOKEN) {
    console.log('⏭️  Skipping reconciliation override e2e test.');
    console.log('   Missing auth token. Set TMM_PLUS_JWT or FREE_JWT.');
    process.exit(0);
  }

  try {
    await assertBackendReachable();
    console.log('✅ backend reachable');

    await testCheckpointWinsOverride();
    console.log('✅ checkpoint-wins override');

    await testPlaidWinsOverride();
    console.log('✅ plaid-wins override');

    console.log('\n✅ Reconciliation override e2e test passed');
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Reconciliation override e2e test failed: ${err.message}`);
    process.exit(1);
  }
}

run();
