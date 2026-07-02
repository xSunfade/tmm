import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupePlaidTransactions, collectTransactionsSyncPages } from '../lib/plaidSyncEngine.js';
import { buildSyncJobDedupeKey } from '../models/plaidSyncJobs.js';
import { schemas } from '../middleware/validation.js';

test('buildSyncJobDedupeKey is stable by user/item/trigger', () => {
  const keyA = buildSyncJobDedupeKey({
    userId: 'u1',
    itemId: 'item_1',
    trigger: 'webhook'
  });
  const keyB = buildSyncJobDedupeKey({
    userId: 'u1',
    itemId: 'item_1',
    trigger: 'webhook'
  });
  const keyC = buildSyncJobDedupeKey({
    userId: 'u1',
    itemId: 'item_2',
    trigger: 'webhook'
  });
  assert.equal(keyA, keyB);
  assert.notEqual(keyA, keyC);
});

test('exchangeTokenBody accepts optional link_intent_id', () => {
  const parsed = schemas.exchangeTokenBody.safeParse({
    public_token: 'public-123',
    link_intent_id: 'intent-123'
  });
  assert.equal(parsed.success, true);
});

test('exchangeTokenBody accepts optional link_success_metadata', () => {
  const parsed = schemas.exchangeTokenBody.safeParse({
    public_token: 'public-123',
    link_intent_id: 'intent-123',
    link_success_metadata: {
      institution_id: 'ins_123',
      link_session_id: 'session_123',
      accounts: [
        {
          name: 'Plaid Checking',
          mask: '0000',
          type: 'depository',
          subtype: 'checking'
        }
      ]
    }
  });
  assert.equal(parsed.success, true);
});

test('linkTelemetryBody accepts Link event payload', () => {
  const parsed = schemas.linkTelemetryBody.safeParse({
    event_type: 'event',
    event_name: 'TRANSITION_VIEW',
    view_name: 'CREDENTIAL',
    institution_id: 'ins_123',
    institution_name: 'Test Bank',
    link_session_id: 'session_123',
    reason: 'progress',
    metadata: { mfa_type: 'code' }
  });
  assert.equal(parsed.success, true);
});

test('dedupePlaidTransactions prioritizes modified over added duplicates', () => {
  const rows = dedupePlaidTransactions({
    added: [{ transaction_id: 'tx_1', amount: 10 }],
    modified: [{ transaction_id: 'tx_1', amount: 15 }],
    backfill: [{ transaction_id: 'tx_2', amount: 20 }]
  });
  assert.equal(rows.length, 2);
  const tx1 = rows.find((r) => r.transaction_id === 'tx_1');
  assert.equal(tx1.amount, 15);
});

test('collectTransactionsSyncPages retries mutation once', async () => {
  let calls = 0;
  const result = await collectTransactionsSyncPages({
    initialCursor: 'c0',
    maxMutationRetries: 1,
    fetchPage: async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('mutation');
        err.response = { data: { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' } };
        throw err;
      }
      return {
        added: [{ transaction_id: 'tx_1' }],
        modified: [],
        removed: [],
        next_cursor: 'c1',
        has_more: false
      };
    }
  });

  assert.equal(calls, 2);
  assert.equal(result.nextCursor, 'c1');
  assert.equal(result.added.length, 1);
});

