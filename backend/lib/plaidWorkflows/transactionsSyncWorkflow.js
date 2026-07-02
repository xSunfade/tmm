import { randomUUID } from 'crypto';
import { collectTransactionsSyncPages, dedupePlaidTransactions } from '../plaidSyncEngine.js';

function getDefaultNow() {
  return new Date();
}

export function createTransactionsSyncWorkflow(deps) {
  const {
    plaidClient,
    getToken,
    getTransactionsSyncCursor,
    setTransactionsSyncCursor,
    upsertTransactionsFromPlaidSync,
    deleteTransactionsByPlaidIds,
    getAccountsByUserAndPlaidAccountIds,
    getAccountsByUserAndItemId,
    getTransactionDateRangeForItem,
    updatePlaidCoverageWindow,
    applyPlaidTransactionsSyncAtomic,
    logPlaidSyncRunStart,
    logPlaidSyncRunFinish,
    createArchiveSnapshotForItem,
    setPlaidItemHealthy,
    recordPlaidCircuitSuccess,
    recordPlaidCircuitFailure,
    upsertPlaidItemStatus,
    releasePlaidItemSyncLock,
    acquirePlaidItemSyncLock,
    ensurePlaidCircuitAllowsRequest,
    enforceSyncQuotas,
    shiftIsoDateByDays,
    dateToIsoDate,
    buildSyncUpsertPayload,
    getPlaidErrorCode,
    isPlaidFailureForBreaker,
    constants,
    now = getDefaultNow,
    chaosHooks = null
  } = deps;

  async function fetchAllTransactionsSyncUpdates(accessToken, baseCursor) {
    return collectTransactionsSyncPages({
      initialCursor: baseCursor || null,
      maxMutationRetries: constants.PLAID_SYNC_MUTATION_RETRIES,
      fetchPage: async (cursor) => {
        const response = await plaidClient.transactionsSync({
          access_token: accessToken,
          cursor,
          count: constants.PLAID_SYNC_PAGE_SIZE
        });
        let page = response.data || {};
        if (chaosHooks?.transformSyncPage) {
          page = await chaosHooks.transformSyncPage(page);
        }
        return page;
      }
    });
  }

  async function fetchTransactionsWindow(accessToken, startDate, endDate) {
    const transactions = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const response = await plaidClient.transactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
        options: { count: constants.PLAID_SYNC_PAGE_SIZE, offset }
      });
      const data = response.data || {};
      const chunk = data.transactions || [];
      transactions.push(...chunk);
      total = Number(data.total_transactions || chunk.length || 0);
      offset += chunk.length;
      if (chunk.length === 0) break;
    }
    return transactions;
  }

  return async function syncTransactionsForItem(itemId, userId, options = {}) {
    const syncRunId = randomUUID();
    const backfillDays = Number.isFinite(Number(options.backfillDays))
      ? Number(options.backfillDays)
      : constants.DEFAULT_BACKFILL_DAYS;
    const backfillStartDate = shiftIsoDateByDays(Math.max(0, backfillDays), now());
    const backfillEndDate = dateToIsoDate(now());
    const accessToken = await getToken(itemId, userId);
    let baseCursor = null;
    let nextCursor = null;
    let added = [];
    let modified = [];
    let removed = [];
    let upsertedCount = 0;
    let deleted = 0;
    let skippedUnmappedAccounts = 0;
    let lockAcquired = false;

    try {
      await enforceSyncQuotas({ userId, itemId, phase: 'execute' });
      const lockResult = await acquirePlaidItemSyncLock({
        userId,
        itemId,
        workerId: options.workerId || null,
        lockSeconds: constants.PLAID_SYNC_LOCK_SECONDS
      });
      if (!lockResult.acquired) {
        const lockErr = new Error(lockResult.reason === 'cooldown'
          ? 'Plaid item is in cooldown'
          : 'Plaid item sync lock is already held');
        lockErr.code = lockResult.reason === 'cooldown' ? 'SYNC_ITEM_COOLDOWN' : 'SYNC_ITEM_LOCKED';
        lockErr.noRetry = true;
        throw lockErr;
      }
      lockAcquired = true;

      if (options.forceRefresh) {
        await plaidClient.transactionsRefresh({ access_token: accessToken });
      }

      const breakerCheck = await ensurePlaidCircuitAllowsRequest();
      if (!breakerCheck.allowed) {
        const breakerErr = new Error(
          `Plaid circuit breaker open: ${breakerCheck.breaker?.reason || 'upstream instability'}`
        );
        breakerErr.code = 'PLAID_CIRCUIT_OPEN';
        breakerErr.noRetry = true;
        throw breakerErr;
      }

      baseCursor = await getTransactionsSyncCursor(itemId, userId);
      await logPlaidSyncRunStart({
        syncRunId,
        itemId,
        userId,
        cursorBefore: baseCursor,
        backfillStartDate,
        backfillEndDate
      });

      const syncUpdates = await fetchAllTransactionsSyncUpdates(accessToken, baseCursor);
      added = syncUpdates.added || [];
      modified = syncUpdates.modified || [];
      removed = syncUpdates.removed || [];
      nextCursor = syncUpdates.nextCursor || baseCursor;

      if (chaosHooks?.beforeApply && options.chaosCrashMidSync) {
        await chaosHooks.beforeApply({
          itemId,
          userId,
          baseCursor,
          nextCursor,
          added,
          modified,
          removed
        });
      }

      const backfillTransactions = await fetchTransactionsWindow(accessToken, backfillStartDate, backfillEndDate);
      const allUpserts = dedupePlaidTransactions({
        added,
        modified,
        backfill: backfillTransactions
      });

      if (constants.PLAID_SYNC_USE_RPC_APPLY) {
        const dateRangeFromPayload = allUpserts.reduce((acc, tx) => {
          const d = tx?.date || null;
          if (!d) return acc;
          if (!acc.earliest || d < acc.earliest) acc.earliest = d;
          if (!acc.latest || d > acc.latest) acc.latest = d;
          return acc;
        }, { earliest: null, latest: null });

        const rpcResult = await applyPlaidTransactionsSyncAtomic({
          userId,
          itemId,
          nextCursor: nextCursor || baseCursor,
          upserts: buildSyncUpsertPayload(allUpserts),
          removedIds: (removed || []).map((r) => r.transaction_id).filter(Boolean),
          coverage: dateRangeFromPayload,
          syncRunId,
          counts: {
            added_count: added.length,
            modified_count: modified.length,
            removed_count: removed.length
          }
        });
        upsertedCount = Number(rpcResult?.upserted_count || 0);
        deleted = Number(rpcResult?.deleted_count || 0);
        skippedUnmappedAccounts = Number(rpcResult?.skipped_unmapped_accounts || 0);
      } else {
        const plaidAccountIds = Array.from(new Set(allUpserts.map((tx) => tx.account_id).filter(Boolean)));
        const accounts = await getAccountsByUserAndPlaidAccountIds(userId, plaidAccountIds);
        const localAccountIdByPlaidId = new Map(accounts.map((a) => [a.plaid_account_id, a.id]));
        const upserted = await upsertTransactionsFromPlaidSync(allUpserts, localAccountIdByPlaidId);
        upsertedCount = upserted.length;
        deleted = await deleteTransactionsByPlaidIds((removed || []).map((r) => r.transaction_id).filter(Boolean));
        skippedUnmappedAccounts = allUpserts.length - upserted.length;

        if (nextCursor && nextCursor !== baseCursor) {
          await setTransactionsSyncCursor(itemId, nextCursor, userId);
        }

        const itemAccounts = await getAccountsByUserAndItemId(userId, itemId);
        const dateRange = await getTransactionDateRangeForItem(
          itemId,
          userId,
          itemAccounts.map((a) => a.id)
        );
        await updatePlaidCoverageWindow(itemId, userId, dateRange);

        await logPlaidSyncRunFinish({
          syncRunId,
          cursorAfter: nextCursor,
          addedCount: added.length,
          modifiedCount: modified.length,
          removedCount: removed.length,
          upsertedCount,
          deletedCount: deleted,
          skippedUnmappedAccounts,
          status: 'completed'
        });
      }

      await createArchiveSnapshotForItem(userId, itemId, {
        pointSource: 'plaid_live',
        metadata: { trigger: 'transactions_sync', item_id: itemId, sync_run_id: syncRunId }
      });

      await setPlaidItemHealthy(userId, itemId, { trigger: 'transactions_sync' });
      await recordPlaidCircuitSuccess();
      await releasePlaidItemSyncLock({ userId, itemId, success: true, cooldownSeconds: 0 });
      lockAcquired = false;

      return {
        sync_run_id: syncRunId,
        item_id: itemId,
        added: added.length,
        modified: modified.length,
        removed: removed.length,
        upserted: upsertedCount,
        deleted,
        skipped_unmapped_accounts: skippedUnmappedAccounts,
        cursor_updated: nextCursor !== baseCursor,
        backfill_start_date: backfillStartDate,
        backfill_end_date: backfillEndDate
      };
    } catch (error) {
      try {
        await logPlaidSyncRunFinish({
          syncRunId,
          cursorAfter: nextCursor || baseCursor,
          addedCount: added.length,
          modifiedCount: modified.length,
          removedCount: removed.length,
          upsertedCount,
          deletedCount: deleted,
          skippedUnmappedAccounts,
          status: 'failed',
          errorMessage: error?.message || 'unknown sync failure'
        });
      } catch {
        // best effort
      }
      try {
        await upsertPlaidItemStatus({
          userId,
          itemId,
          status: 'sync_error',
          needsUpdateMode: false,
          lastErrorCode: getPlaidErrorCode(error),
          webhookType: 'INTERNAL',
          webhookCode: 'SYNC_FAILED',
          metadata: { error: error?.message || 'unknown sync failure' }
        });
      } catch {
        // best effort
      }
      if (getPlaidErrorCode(error) || isPlaidFailureForBreaker(error)) {
        try {
          await recordPlaidCircuitFailure({
            reason: getPlaidErrorCode(error) || error.code || 'plaid_sync_failure'
          });
        } catch {
          // best effort
        }
      }
      try {
        if (lockAcquired) {
          await releasePlaidItemSyncLock({
            userId,
            itemId,
            success: false,
            cooldownSeconds: constants.PLAID_SYNC_COOLDOWN_SECONDS
          });
        }
      } catch {
        // best effort
      }
      throw error;
    }
  };
}
