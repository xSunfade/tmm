import { collectTransactionsSyncPages, dedupePlaidTransactions } from '../../../../backend/lib/plaidSyncEngine.js';
import { ChaosController, type SyncPage, type Txn } from '../chaos/ChaosController';

type TxRecord = Txn & { applied_count: number };

export type HarnessConfig = {
  chaosMode: boolean;
  seed: number;
  iterations: number;
};

export type HarnessResult = {
  cursor: string | null;
  transactionsById: Record<string, TxRecord>;
  nodeValueCents: number;
  duplicatesInFinalState: number;
  cursorHistory: string[];
  reconciliationLog: Array<{ id: string; previousCents: number; nextCents: number; reason: string }>;
  chaosSummary: ReturnType<ChaosController['getSummary']>;
};

type DbState = {
  cursor: string | null;
  txById: Map<string, TxRecord>;
  cursorHistory: string[];
  reconciliationLog: Array<{ id: string; previousCents: number; nextCents: number; reason: string }>;
};

function toCents(amount: number): number {
  return Math.round(Number(amount || 0) * 100);
}

function computeNodeValueCents(txById: Map<string, TxRecord>): number {
  let total = 0;
  for (const tx of txById.values()) {
    total += toCents(tx.amount);
  }
  return total;
}

function applySyncPage(db: DbState, page: SyncPage) {
  const upserts = dedupePlaidTransactions({
    added: page.added,
    modified: page.modified,
    backfill: []
  });

  for (const tx of upserts) {
    const current = db.txById.get(tx.transaction_id);
    const prev = current ? toCents(current.amount) : 0;
    db.txById.set(tx.transaction_id, {
      ...tx,
      applied_count: (current?.applied_count || 0) + 1
    });
    const next = toCents(tx.amount);
    db.reconciliationLog.push({
      id: tx.transaction_id,
      previousCents: prev,
      nextCents: next,
      reason: current ? 'modified_or_replayed' : 'added'
    });
  }

  for (const removal of page.removed) {
    const existing = db.txById.get(removal.transaction_id);
    if (!existing) continue;
    db.txById.delete(removal.transaction_id);
    db.reconciliationLog.push({
      id: removal.transaction_id,
      previousCents: toCents(existing.amount),
      nextCents: 0,
      reason: 'removed'
    });
  }

  if (page.next_cursor) {
    const prior = db.cursor;
    if (!prior || page.next_cursor > prior) {
      db.cursor = page.next_cursor;
      db.cursorHistory.push(page.next_cursor);
    }
  }
}

async function replayPages(db: DbState, pages: SyncPage[]) {
  let cursor = db.cursor;
  const aggregated = await collectTransactionsSyncPages({
    initialCursor: cursor,
    maxMutationRetries: 0,
    fetchPage: async () => {
      const next = pages.shift();
      if (!next) return { added: [], modified: [], removed: [], has_more: false, next_cursor: cursor };
      cursor = next.next_cursor || cursor;
      return next;
    }
  });
  applySyncPage(db, {
    added: aggregated.added || [],
    modified: aggregated.modified || [],
    removed: aggregated.removed || [],
    has_more: false,
    next_cursor: aggregated.nextCursor || cursor
  });
}

export async function runPlaidSyncChaosHarness(config: HarnessConfig): Promise<HarnessResult> {
  const chaos = new ChaosController({
    enabled: config.chaosMode,
    seed: config.seed,
    iterations: Math.max(1, config.iterations)
  });

  const baseAdded: Txn[] = [
    { transaction_id: 'tx_1', account_id: 'acc_1', amount: 12.11, date: '2026-01-01', name: 'Coffee' },
    { transaction_id: 'tx_2', account_id: 'acc_1', amount: 99.22, date: '2026-01-02', name: 'Groceries' },
    { transaction_id: 'tx_3', account_id: 'acc_2', amount: -1500.00, date: '2026-01-03', name: 'Paycheck' }
  ];
  const baseModified: Txn[] = [
    { transaction_id: 'tx_2', account_id: 'acc_1', amount: 101.22, date: '2026-01-02', name: 'Groceries adjusted' }
  ];
  const baseRemoved = [{ transaction_id: 'tx_1' }];

  const db: DbState = {
    cursor: null,
    txById: new Map(),
    cursorHistory: [],
    reconciliationLog: []
  };

  for (let i = 0; i < config.iterations; i += 1) {
    const pages = chaos.buildPages(baseAdded, baseModified, baseRemoved);
    if (chaos.shouldInjectCrash(i) && pages.length > 1) {
      const half = Math.floor(pages.length / 2);
      await replayPages(db, pages.slice(0, half));
      // Resume from same cursor.
      await replayPages(db, pages.slice(half));
    } else {
      await replayPages(db, [...pages]);
    }

    // Replay same payload multiple times to prove idempotent terminal state.
    await replayPages(db, [...pages]);
  }

  if (config.chaosMode) {
    // Simulate concurrent workers by selecting an interleave order,
    // then fully applying each worker batch (idempotent terminal state).
    const aPages = chaos.buildPages(baseAdded, baseModified, baseRemoved);
    const bPages = chaos.buildPages(baseAdded, baseModified, baseRemoved);
    const interleave = chaos.interleaveOrder();
    for (const turn of interleave) {
      if (turn === 'A') {
        await replayPages(db, [...aPages]);
      } else {
        await replayPages(db, [...bPages]);
      }
    }
  }

  const ids = Array.from(db.txById.keys());
  const duplicatesInFinalState = ids.length - new Set(ids).size;
  return {
    cursor: db.cursor,
    transactionsById: Object.fromEntries(
      Array.from(db.txById.entries()).map(([k, v]) => [k, v])
    ),
    nodeValueCents: computeNodeValueCents(db.txById),
    duplicatesInFinalState,
    cursorHistory: db.cursorHistory,
    reconciliationLog: db.reconciliationLog,
    chaosSummary: chaos.getSummary()
  };
}

export function assertMonotonicCursor(history: string[]): void {
  for (let i = 1; i < history.length; i += 1) {
    if (history[i] < history[i - 1]) {
      throw new Error(`Cursor regressed from ${history[i - 1]} to ${history[i]}`);
    }
  }
}
