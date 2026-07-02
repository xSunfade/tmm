import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  collectTransactionsSyncPages,
  dedupePlaidTransactions,
  PLAID_SYNC_MUTATION_ERROR
} from '../../backend/lib/plaidSyncEngine.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readFixture(name) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const fixturePath = path.resolve(__dirname, '../fixtures/plaid/sync_runs', name);
  const raw = await fs.readFile(fixturePath, 'utf8');
  return JSON.parse(raw);
}

async function testMutationRetryFixture() {
  const fixture = await readFixture('mutation_retry_fixture.json');
  let attemptIdx = 0;
  let stepIdx = 0;

  const result = await collectTransactionsSyncPages({
    initialCursor: fixture.initialCursor,
    maxMutationRetries: fixture.maxMutationRetries,
    fetchPage: async (cursor) => {
      const attempt = fixture.attempts[attemptIdx];
      if (!attempt) throw new Error('Unexpected extra attempt in fixture replay');
      const step = attempt[stepIdx];
      if (!step) throw new Error('Unexpected extra page fetch in fixture replay');

      stepIdx += 1;
      if (step.type === 'error') {
        attemptIdx += 1;
        stepIdx = 0;
        const err = new Error(step.code);
        err.code = step.code;
        err.response = { data: { error_code: step.code } };
        throw err;
      }

      if (step.cursor !== cursor) {
        throw new Error(`Fixture cursor mismatch. Expected ${step.cursor}, got ${cursor}`);
      }
      if (stepIdx >= attempt.length) {
        attemptIdx += 1;
        stepIdx = 0;
      }
      return step.data;
    }
  });

  assert(
    result.nextCursor === fixture.expected.nextCursor,
    `Expected next cursor ${fixture.expected.nextCursor}, got ${result.nextCursor}`
  );
  assert(result.added.length === fixture.expected.addedCount, 'Unexpected added transaction count');
  assert(result.modified.length === fixture.expected.modifiedCount, 'Unexpected modified transaction count');
  assert(result.removed.length === fixture.expected.removedCount, 'Unexpected removed transaction count');
}

async function testDedupeFixture() {
  const fixture = await readFixture('dedupe_backfill_fixture.json');
  const deduped = dedupePlaidTransactions({
    added: fixture.added,
    modified: fixture.modified,
    backfill: fixture.backfill
  });

  const ids = deduped.map((tx) => tx.transaction_id);
  assert(
    JSON.stringify(ids) === JSON.stringify(fixture.expected.transactionIds),
    `Unexpected transaction id sequence: ${JSON.stringify(ids)}`
  );

  for (const tx of deduped) {
    const expectedAmount = fixture.expected.amountById[tx.transaction_id];
    assert(
      Number(tx.amount) === Number(expectedAmount),
      `Unexpected amount for ${tx.transaction_id}. Expected ${expectedAmount}, got ${tx.amount}`
    );
  }
}

async function testNonMutationErrorBubbles() {
  let threw = false;
  try {
    await collectTransactionsSyncPages({
      initialCursor: null,
      maxMutationRetries: 1,
      fetchPage: async () => {
        const err = new Error('invalid');
        err.code = 'INVALID_INPUT';
        err.response = { data: { error_code: 'INVALID_INPUT' } };
        throw err;
      }
    });
  } catch (err) {
    threw = true;
    assert(err.code !== PLAID_SYNC_MUTATION_ERROR, 'Expected non-mutation error to bubble');
  }
  assert(threw, 'Expected non-mutation errors to be thrown');
}

async function run() {
  console.log('🧪 Running Plaid sync fixture validation tests...\n');
  await testMutationRetryFixture();
  console.log('✅ mutation-during-pagination fixture');
  await testDedupeFixture();
  console.log('✅ dedupe + backfill fixture');
  await testNonMutationErrorBubbles();
  console.log('✅ non-mutation error propagation');
  console.log('\n✅ Plaid sync fixture validation passed');
}

run().catch((err) => {
  console.error(`\n❌ Plaid sync fixture validation failed: ${err.message}`);
  process.exit(1);
});
