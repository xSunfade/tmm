export const PLAID_SYNC_MUTATION_ERROR = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION';

function getErrorCode(err) {
  return err?.response?.data?.error_code || err?.code || null;
}

export async function collectTransactionsSyncPages({
  initialCursor = null,
  fetchPage,
  maxMutationRetries = 1
}) {
  if (typeof fetchPage !== 'function') {
    throw new Error('fetchPage function is required');
  }

  let attempt = 0;
  while (attempt <= maxMutationRetries) {
    let cursor = initialCursor;
    let hasMore = true;
    const added = [];
    const modified = [];
    const removed = [];

    try {
      while (hasMore) {
        const page = await fetchPage(cursor);
        added.push(...(page?.added || []));
        modified.push(...(page?.modified || []));
        removed.push(...(page?.removed || []));
        cursor = page?.next_cursor || cursor;
        hasMore = !!page?.has_more;
      }
      return { added, modified, removed, nextCursor: cursor };
    } catch (err) {
      const code = getErrorCode(err);
      if (code === PLAID_SYNC_MUTATION_ERROR && attempt < maxMutationRetries) {
        attempt += 1;
        continue;
      }
      throw err;
    }
  }

  return { added: [], modified: [], removed: [], nextCursor: initialCursor };
}

export function dedupePlaidTransactions({
  added = [],
  modified = [],
  backfill = []
}) {
  const deduped = new Map();
  [...added, ...modified, ...backfill].forEach((tx) => {
    if (tx?.transaction_id) {
      deduped.set(tx.transaction_id, tx);
    }
  });
  return Array.from(deduped.values());
}
