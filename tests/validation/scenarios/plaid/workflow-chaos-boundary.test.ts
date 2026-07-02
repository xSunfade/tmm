import { createTransactionsSyncWorkflow } from '../../../../backend/lib/plaidWorkflows/transactionsSyncWorkflow.js';
import { InMemoryPlaidSyncStorage } from '../../harness/storage/InMemoryPlaidSyncStorage';
import { writeArtifact } from '../../harness/artifacts';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

type Page = {
  added: any[];
  modified: any[];
  removed: any[];
  has_more: boolean;
  next_cursor: string | null;
};

function makePlaidClient(syncPages: Page[], backfill: any[] = []) {
  const byCursor = new Map<string, Page>();
  let previousCursor = '__start__';
  for (const page of syncPages) {
    byCursor.set(previousCursor, page);
    previousCursor = page.next_cursor || previousCursor;
  }
  return {
    async transactionsRefresh() {
      return undefined;
    },
    async transactionsSync(request: { cursor?: string | null }) {
      const key = request?.cursor || '__start__';
      const page =
        byCursor.get(key) ||
        { added: [], modified: [], removed: [], has_more: false, next_cursor: syncPages[syncPages.length - 1]?.next_cursor || null };
      return { data: page };
    },
    async transactionsGet() {
      return { data: { transactions: backfill, total_transactions: backfill.length } };
    }
  };
}

function buildDeps(storage: InMemoryPlaidSyncStorage, plaidClient: any, chaosHooks: any = null) {
  return {
    plaidClient,
    getToken: storage.getToken.bind(storage),
    getTransactionsSyncCursor: storage.getTransactionsSyncCursor.bind(storage),
    setTransactionsSyncCursor: storage.setTransactionsSyncCursor.bind(storage),
    upsertTransactionsFromPlaidSync: storage.upsertTransactionsFromPlaidSync.bind(storage),
    deleteTransactionsByPlaidIds: storage.deleteTransactionsByPlaidIds.bind(storage),
    getAccountsByUserAndPlaidAccountIds: storage.getAccountsByUserAndPlaidAccountIds.bind(storage),
    getAccountsByUserAndItemId: storage.getAccountsByUserAndItemId.bind(storage),
    getTransactionDateRangeForItem: async () => ({ earliest: '2026-01-01', latest: '2026-01-03' }),
    updatePlaidCoverageWindow: async () => undefined,
    applyPlaidTransactionsSyncAtomic: async () => ({}),
    logPlaidSyncRunStart: storage.logPlaidSyncRunStart.bind(storage),
    logPlaidSyncRunFinish: storage.logPlaidSyncRunFinish.bind(storage),
    createArchiveSnapshotForItem: async () => undefined,
    setPlaidItemHealthy: async () => undefined,
    recordPlaidCircuitSuccess: async () => undefined,
    recordPlaidCircuitFailure: async () => undefined,
    upsertPlaidItemStatus: async () => undefined,
    releasePlaidItemSyncLock: storage.releasePlaidItemSyncLock.bind(storage),
    acquirePlaidItemSyncLock: storage.acquirePlaidItemSyncLock.bind(storage),
    ensurePlaidCircuitAllowsRequest: async () => ({ allowed: true }),
    enforceSyncQuotas: async () => undefined,
    shiftIsoDateByDays: () => '2025-12-22',
    dateToIsoDate: () => '2026-01-03',
    buildSyncUpsertPayload: (rows: any[]) => rows,
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
    chaosHooks
  };
}

function seededPages(seed: number): Page[] {
  const flip = seed % 2 === 0;
  const baseA = [
    { transaction_id: 'tx_1', account_id: 'acc_1', amount: 10.11, date: '2026-01-01', name: 'A' },
    { transaction_id: 'tx_2', account_id: 'acc_1', amount: 20.22, date: '2026-01-02', name: 'B' }
  ];
  const baseM = [{ transaction_id: 'tx_2', account_id: 'acc_1', amount: 25.22, date: '2026-01-02', name: 'B2' }];
  const baseR = [{ transaction_id: 'tx_1' }];
  if (flip) {
    return [
      { added: [baseA[1], baseA[0], baseA[1]], modified: [], removed: [], has_more: true, next_cursor: 'cursor_1' },
      { added: [], modified: baseM, removed: baseR, has_more: false, next_cursor: 'cursor_2' }
    ];
  }
  return [
    { added: [baseA[0], baseA[1]], modified: baseM, removed: [], has_more: true, next_cursor: 'cursor_1' },
    { added: [], modified: [], removed: baseR, has_more: false, next_cursor: 'cursor_2' }
  ];
}

async function runVariant(seed: number, opts: { crash?: boolean; concurrent?: boolean; replay?: number } = {}) {
  const storage = new InMemoryPlaidSyncStorage();
  const userId = 'user_1';
  const itemId = 'item_1';
  storage.setToken(userId, itemId, 'token_1');
  storage.seedAccounts([{ id: 'local_acc_1', plaid_account_id: 'acc_1', plaid_item_id: itemId, user_id: userId }]);
  storage.transactions.set('tx_2', {
    plaid_transaction_id: 'tx_2',
    account_id: 'local_acc_1',
    amount: 20.22,
    date: '2026-01-01',
    name: 'seed'
  });

  let crashInjected = false;
  const chaosHooks = opts.crash
    ? {
        async beforeApply() {
          if (!crashInjected) {
            crashInjected = true;
            throw new Error('CHAOS_CRASH_BEFORE_APPLY');
          }
        }
      }
    : null;

  const workflow = createTransactionsSyncWorkflow(buildDeps(storage, makePlaidClient(seededPages(seed)), chaosHooks));

  const replay = Math.max(1, opts.replay || 1);
  for (let i = 0; i < replay; i += 1) {
    try {
      if (opts.concurrent) {
        const results = await Promise.allSettled([
          workflow(itemId, userId, {}),
          workflow(itemId, userId, {})
        ]);
        for (const result of results) {
          if (result.status === 'rejected' && !String(result.reason?.message || result.reason).includes('lock')) {
            throw result.reason;
          }
        }
      } else {
        await workflow(itemId, userId, opts.crash ? { chaosCrashMidSync: true } : {});
      }
    } catch (error) {
      if (String((error as Error).message).includes('CHAOS_CRASH_BEFORE_APPLY')) {
        await workflow(itemId, userId, {});
      } else if (!String((error as Error).message).includes('lock')) {
        throw error;
      }
    }
  }

  const key = `${userId}:${itemId}`;
  return {
    key,
    cursor: storage.cursors.get(key) || null,
    cursorHistory: storage.cursorHistory.get(key) || [],
    transactions: Object.fromEntries(
      Array.from(storage.transactions.entries()).sort(([a], [b]) => a.localeCompare(b))
    ),
    reconciliationEvents: storage.reconciliationEvents,
    syncRuns: storage.syncRuns
  };
}

async function run() {
  const seed = Number(process.env.CHAOS_SEED || 1337);
  const baseline = await runVariant(seed, { replay: 1 });
  const replayed = await runVariant(seed, { replay: 3 });
  const crashResume = await runVariant(seed, { crash: true });
  const concurrent = await runVariant(seed, { concurrent: true });
  const reordered = await runVariant(seed + 1, {});

  const baselineIds = Object.keys(baseline.transactions);
  assert(JSON.stringify(baselineIds) === JSON.stringify(Object.keys(replayed.transactions)), 'Replay changed final id set');
  assert(JSON.stringify(baselineIds) === JSON.stringify(Object.keys(crashResume.transactions)), 'Crash/resume changed final id set');
  assert(JSON.stringify(baselineIds) === JSON.stringify(Object.keys(concurrent.transactions)), 'Concurrency changed final id set');
  assert(JSON.stringify(baselineIds) === JSON.stringify(Object.keys(reordered.transactions)), 'Reordering changed final id set');

  assert(baseline.cursor === 'cursor_2', `Expected cursor_2 baseline, got ${baseline.cursor}`);
  for (const variant of [baseline, replayed, crashResume, concurrent, reordered]) {
    for (let i = 1; i < variant.cursorHistory.length; i += 1) {
      assert(variant.cursorHistory[i] >= variant.cursorHistory[i - 1], 'Cursor regressed');
    }
    const ids = Object.keys(variant.transactions);
    assert(ids.length === new Set(ids).size, 'Duplicate tx rows exist');
    assert(variant.reconciliationEvents.some((e) => e.reason === 'added'), 'Missing added log');
    assert(variant.reconciliationEvents.some((e) => e.reason === 'modified'), 'Missing modified log');
    assert(variant.reconciliationEvents.some((e) => e.reason === 'removed'), 'Missing removed log');
  }

  const root = process.cwd();
  await writeArtifact(root, 'plaid_final_state_snapshot.json', 'plaid_final_state_snapshot', seed, {
    baseline,
    replayed,
    crashResume,
    concurrent,
    reordered
  });
  await writeArtifact(root, 'plaid_state_diff.json', 'plaid_state_diff', seed, {
    changed: false,
    comparedVariants: ['replayed', 'crashResume', 'concurrent', 'reordered']
  });

  console.log('✅ Workflow-boundary chaos proof passed');
}

run().catch((error) => {
  console.error(`❌ Workflow-boundary chaos proof failed: ${(error as Error).message}`);
  process.exit(1);
});
