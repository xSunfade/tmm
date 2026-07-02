import { createTransactionsSyncWorkflow } from '../../../../backend/lib/plaidWorkflows/transactionsSyncWorkflow.js';
import { InMemoryPlaidSyncStorage } from '../../harness/storage/InMemoryPlaidSyncStorage';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function run() {
  const storage = new InMemoryPlaidSyncStorage();
  const userId = 'user_1';
  const itemId = 'item_1';
  storage.setToken(userId, itemId, 'token_1');
  storage.seedAccounts([
    { id: 'local_acc_1', plaid_account_id: 'acc_1', plaid_item_id: itemId, user_id: userId }
  ]);

  let syncCall = 0;
  const plaidClient = {
    async transactionsRefresh() { return undefined; },
    async transactionsSync() {
      syncCall += 1;
      if (syncCall === 1) {
        return { data: { added: [{ transaction_id: 'tx_a', account_id: 'acc_1', amount: 10.25, date: '2026-01-01' }], modified: [], removed: [], has_more: true, next_cursor: 'c1' } };
      }
      return { data: { added: [], modified: [{ transaction_id: 'tx_a', account_id: 'acc_1', amount: 11.25, date: '2026-01-01' }], removed: [], has_more: false, next_cursor: 'c2' } };
    },
    async transactionsGet() {
      return { data: { transactions: [], total_transactions: 0 } };
    }
  };

  const syncWorkflow = createTransactionsSyncWorkflow({
    plaidClient,
    getToken: storage.getToken.bind(storage),
    getTransactionsSyncCursor: storage.getTransactionsSyncCursor.bind(storage),
    setTransactionsSyncCursor: storage.setTransactionsSyncCursor.bind(storage),
    upsertTransactionsFromPlaidSync: storage.upsertTransactionsFromPlaidSync.bind(storage),
    deleteTransactionsByPlaidIds: storage.deleteTransactionsByPlaidIds.bind(storage),
    getAccountsByUserAndPlaidAccountIds: storage.getAccountsByUserAndPlaidAccountIds.bind(storage),
    getAccountsByUserAndItemId: storage.getAccountsByUserAndItemId.bind(storage),
    getTransactionDateRangeForItem: async () => ({ earliest: '2026-01-01', latest: '2026-01-01' }),
    updatePlaidCoverageWindow: async () => undefined,
    applyPlaidTransactionsSyncAtomic: async () => ({}),
    logPlaidSyncRunStart: async () => { storage.syncRuns.push({ status: 'start' }); },
    logPlaidSyncRunFinish: async (data: any) => { storage.syncRuns.push({ status: data.status }); },
    createArchiveSnapshotForItem: async () => undefined,
    setPlaidItemHealthy: async () => undefined,
    recordPlaidCircuitSuccess: async () => undefined,
    recordPlaidCircuitFailure: async () => undefined,
    upsertPlaidItemStatus: async () => undefined,
    releasePlaidItemSyncLock: async () => undefined,
    acquirePlaidItemSyncLock: async () => ({ acquired: true }),
    ensurePlaidCircuitAllowsRequest: async () => ({ allowed: true }),
    enforceSyncQuotas: async () => undefined,
    shiftIsoDateByDays: () => '2025-12-22',
    dateToIsoDate: () => '2026-01-01',
    buildSyncUpsertPayload: (values: any[]) => values,
    getPlaidErrorCode: () => null,
    isPlaidFailureForBreaker: () => false,
    constants: {
      PLAID_SYNC_PAGE_SIZE: 100,
      DEFAULT_BACKFILL_DAYS: 10,
      PLAID_SYNC_USE_RPC_APPLY: false,
      PLAID_SYNC_COOLDOWN_SECONDS: 30,
      PLAID_SYNC_LOCK_SECONDS: 120,
      PLAID_SYNC_MUTATION_RETRIES: 0
    },
    chaosHooks: {
      async transformSyncPage(page: any) {
        return {
          ...page,
          added: [...(page.added || [])].reverse(),
          modified: [...(page.modified || [])].reverse()
        };
      }
    }
  });

  const result = await syncWorkflow(itemId, userId, {});
  assert(result.item_id === itemId, 'Unexpected workflow result item id');
  assert(storage.transactions.size === 1, 'Expected one transaction row');
  const row = storage.transactions.get('tx_a');
  assert(!!row, 'Expected tx_a row');
  assert(Number(row?.amount) === 11.25, `Expected modified amount to win, got ${row?.amount}`);
  const cursor = await storage.getTransactionsSyncCursor(itemId, userId);
  assert(cursor === 'c2', `Expected cursor c2, got ${cursor}`);
  console.log('✅ Injectable workflow validation passed');
}

run().catch((error) => {
  console.error(`❌ Injectable workflow validation failed: ${error.message}`);
  process.exit(1);
});
