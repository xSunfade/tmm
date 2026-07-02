// Plaid Transactions Sync E2E Test
// Validates sync single/all, webhook trigger, and transactions DB ownership guard.

import dotenv from 'dotenv';

dotenv.config();

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const AUTH_TOKEN = process.env.TMM_PLUS_JWT || '';
const TEST_ITEM_ID = process.env.TEST_ITEM_ID || '';
const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || '';
const OTHER_USERS_ACCOUNT_ID = process.env.OTHER_USERS_ACCOUNT_ID || '';
const PLAID_WEBHOOK_SECRET = process.env.PLAID_WEBHOOK_SECRET || '';

function authHeaders() {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function printSkip(missingVars) {
  console.log('⏭️  Skipping Plaid transactions e2e test.');
  console.log(`   Missing env vars: ${missingVars.join(', ')}`);
  console.log('   Required: TMM_PLUS_JWT, TEST_ITEM_ID, TEST_ACCOUNT_ID, OTHER_USERS_ACCOUNT_ID');
}

async function testSyncSingleItem() {
  const response = await fetch(`${BACKEND_URL}/api/plaid/transactions/sync`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ item_id: TEST_ITEM_ID })
  });
  const json = await response.json();

  assert(response.status === 200, `sync single item failed: ${response.status} ${JSON.stringify(json)}`);
  assert(json.ok === true, 'sync single item missing ok=true');
  assert(Array.isArray(json.results), 'sync single item missing results array');
  assert(json.results.length === 1, `sync single item expected 1 result, got ${json.results.length}`);
  assert(json.results[0].item_id === TEST_ITEM_ID, 'sync single item returned unexpected item_id');
}

async function testSyncAllItems() {
  const response = await fetch(`${BACKEND_URL}/api/plaid/transactions/sync`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({})
  });
  const json = await response.json();

  assert(response.status === 200, `sync all items failed: ${response.status} ${JSON.stringify(json)}`);
  assert(json.ok === true, 'sync all items missing ok=true');
  assert(Array.isArray(json.results), 'sync all items missing results array');
}

async function testWebhookDebounceTrigger() {
  const webhookHeaders = {
    'Content-Type': 'application/json'
  };
  if (PLAID_WEBHOOK_SECRET) {
    webhookHeaders['x-plaid-webhook-secret'] = PLAID_WEBHOOK_SECRET;
  }

  const payload = {
    webhook_type: 'TRANSACTIONS',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    item_id: TEST_ITEM_ID
  };

  const first = await fetch(`${BACKEND_URL}/api/webhooks/plaid`, {
    method: 'POST',
    headers: webhookHeaders,
    body: JSON.stringify(payload)
  });
  const second = await fetch(`${BACKEND_URL}/api/webhooks/plaid`, {
    method: 'POST',
    headers: webhookHeaders,
    body: JSON.stringify(payload)
  });

  const firstJson = await first.json();
  const secondJson = await second.json();

  assert(first.status === 200, `webhook first call failed: ${first.status} ${JSON.stringify(firstJson)}`);
  assert(second.status === 200, `webhook second call failed: ${second.status} ${JSON.stringify(secondJson)}`);
  assert(firstJson.received === true, 'webhook first call missing received=true');
  assert(secondJson.received === true, 'webhook second call missing received=true');
}

async function testReadDbOwnershipGuard() {
  const ownResponse = await fetch(
    `${BACKEND_URL}/api/plaid/transactions/db?account_id=${encodeURIComponent(TEST_ACCOUNT_ID)}&limit=10`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`
      }
    }
  );
  const ownJson = await ownResponse.json();
  assert(ownResponse.status === 200, `read own account failed: ${ownResponse.status} ${JSON.stringify(ownJson)}`);
  assert(Array.isArray(ownJson.transactions), 'read own account missing transactions array');

  const otherResponse = await fetch(
    `${BACKEND_URL}/api/plaid/transactions/db?account_id=${encodeURIComponent(OTHER_USERS_ACCOUNT_ID)}&limit=10`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`
      }
    }
  );
  const otherJson = await otherResponse.json();
  assert(
    otherResponse.status === 404,
    `ownership guard expected 404, got ${otherResponse.status} ${JSON.stringify(otherJson)}`
  );
}

async function run() {
  console.log('🧪 Running Plaid transactions sync e2e test...\n');
  console.log(`Backend URL: ${BACKEND_URL}\n`);

  const required = {
    TMM_PLUS_JWT: AUTH_TOKEN,
    TEST_ITEM_ID,
    TEST_ACCOUNT_ID,
    OTHER_USERS_ACCOUNT_ID
  };
  const missingVars = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingVars.length > 0) {
    printSkip(missingVars);
    process.exit(0);
  }

  try {
    await testSyncSingleItem();
    console.log('✅ sync single item');

    await testSyncAllItems();
    console.log('✅ sync all items');

    await testWebhookDebounceTrigger();
    console.log('✅ webhook debounce trigger (double delivery accepted)');

    await testReadDbOwnershipGuard();
    console.log('✅ read DB ownership guard');

    console.log('\n✅ Plaid transactions sync e2e test passed');
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Plaid transactions sync e2e test failed: ${err.message}`);
    process.exit(1);
  }
}

run();
