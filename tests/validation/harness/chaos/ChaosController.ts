import { createRng, seededShuffle, type DeterministicRng } from '../random';

export type Txn = {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name?: string;
};

export type SyncPage = {
  added: Txn[];
  modified: Txn[];
  removed: Array<{ transaction_id: string }>;
  has_more: boolean;
  next_cursor: string | null;
};

export type ChaosConfig = {
  enabled: boolean;
  seed: number;
  iterations: number;
};

export type ChaosSummary = {
  seed: number;
  pagesProduced: number;
  duplicateTransactionsInjected: number;
  replayCount: number;
  crashInjectedAtIteration: number | null;
  concurrentInterleaveUsed: boolean;
};

function splitRandomly<T>(source: T[], rng: DeterministicRng): T[][] {
  if (source.length <= 1) return [source];
  const bucketCount = Math.max(1, Math.min(source.length, rng.nextInt(4) + 1));
  const buckets: T[][] = Array.from({ length: bucketCount }, () => []);
  for (const item of source) {
    buckets[rng.nextInt(bucketCount)].push(item);
  }
  return buckets.filter((b) => b.length > 0);
}

export class ChaosController {
  private readonly cfg: ChaosConfig;
  private readonly rng: DeterministicRng;
  private summary: ChaosSummary;

  constructor(cfg: ChaosConfig) {
    this.cfg = cfg;
    this.rng = createRng(cfg.seed);
    this.summary = {
      seed: cfg.seed,
      pagesProduced: 0,
      duplicateTransactionsInjected: 0,
      replayCount: Math.max(1, cfg.iterations),
      crashInjectedAtIteration: null,
      concurrentInterleaveUsed: false
    };
  }

  getSummary(): ChaosSummary {
    return { ...this.summary };
  }

  buildPages(baseAdded: Txn[], baseModified: Txn[], baseRemoved: Array<{ transaction_id: string }>): SyncPage[] {
    if (!this.cfg.enabled) {
      this.summary.pagesProduced = 1;
      return [{
        added: baseAdded,
        modified: baseModified,
        removed: baseRemoved,
        has_more: false,
        next_cursor: 'cursor_1'
      }];
    }

    const added = seededShuffle([...baseAdded], this.rng);
    const modified = seededShuffle([...baseModified], this.rng);
    const removed = seededShuffle([...baseRemoved], this.rng);

    if (added.length > 0 && this.rng.chance(0.65)) {
      const dup = added[this.rng.nextInt(added.length)];
      added.push({ ...dup });
      this.summary.duplicateTransactionsInjected += 1;
    }

    const addedChunks = splitRandomly(added, this.rng);
    const modifiedChunks = splitRandomly(modified, this.rng);
    const removedChunks = splitRandomly(removed, this.rng);
    const pageCount = Math.max(addedChunks.length, modifiedChunks.length, removedChunks.length, 1);

    const pages: SyncPage[] = [];
    for (let i = 0; i < pageCount; i += 1) {
      pages.push({
        added: addedChunks[i] || [],
        modified: modifiedChunks[i] || [],
        removed: removedChunks[i] || [],
        has_more: i < pageCount - 1,
        next_cursor: `cursor_${i + 1}`
      });
    }
    this.summary.pagesProduced = pages.length;
    return pages;
  }

  shouldInjectCrash(iteration: number): boolean {
    if (!this.cfg.enabled) return false;
    if (this.summary.crashInjectedAtIteration !== null) return false;
    const crash = this.rng.chance(0.35);
    if (crash) {
      this.summary.crashInjectedAtIteration = iteration;
    }
    return crash;
  }

  interleaveOrder(): Array<'A' | 'B'> {
    if (!this.cfg.enabled) return ['A', 'B'];
    const interleave = seededShuffle(['A', 'B', 'A', 'B'], this.rng) as Array<'A' | 'B'>;
    this.summary.concurrentInterleaveUsed = true;
    return interleave;
  }
}
