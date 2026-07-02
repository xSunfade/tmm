import type { PlanState, IncomeRow, AssetRow, DebtRow } from '../../lib/plan/types';
import type { ConnectedAccount } from './legacyAdapters';

type LinkedEntityType = 'income' | 'expense' | 'asset' | 'debt';

/**
 * Reverts plan entities that reference a connected account which no longer exists
 * (e.g. after removing a Plaid item). Those entities are set back to manual/default state
 * so they no longer show as linked or show an Unlink button.
 */
export function revertStalePlanLinks(
  planState: PlanState,
  accounts: ConnectedAccount[]
): PlanState | null {
  const accountIds = new Set(accounts.map((a) => a.accountId || a.id).filter(Boolean));
  const nextPlan = JSON.parse(JSON.stringify(planState)) as PlanState;
  let changed = false;

  for (const altName of Object.keys(nextPlan.alternatives || {})) {
    const alt = nextPlan.alternatives[altName];
    for (const entityType of ['income', 'expense', 'asset', 'debt'] as LinkedEntityType[]) {
      const entities = alt[entityType] || [];
      for (const entity of entities) {
        if (entity.dataSource !== 'connected' || !entity.connectedAccountId) continue;
        if (accountIds.has(entity.connectedAccountId)) continue;

        const manualVal = entity.manualValue ?? undefined;
        if (entityType === 'debt') (entity as any).bal = manualVal !== undefined ? manualVal : (entity as any).bal;
        if (entityType === 'asset') (entity as any).value = manualVal !== undefined ? manualVal : (entity as any).value;
        if (entityType === 'income' || entityType === 'expense') (entity as any).amount = manualVal !== undefined ? manualVal : (entity as any).amount;

        entity.dataSource = 'manual';
        entity.connectedAccountId = undefined;
        entity.autoValue = null;
        entity.lastSyncedAt = null;
        entity.overrideActive = false;
        entity.lastOverriddenAt = null;
        changed = true;
      }
    }
  }

  return changed ? nextPlan : null;
}

export function applyConnectedBalancesToPlan(
  planState: PlanState,
  accounts: ConnectedAccount[]
): PlanState | null {
  if (!accounts.length) return null;

  const accountById = new Map<string, ConnectedAccount>();
  for (const account of accounts) {
    accountById.set(account.accountId || account.id, account);
  }

  const nextPlan = JSON.parse(JSON.stringify(planState)) as PlanState;
  let changed = false;

  for (const altName of Object.keys(nextPlan.alternatives || {})) {
    const alt = nextPlan.alternatives[altName];
    for (const entityType of ['income', 'expense', 'asset', 'debt'] as LinkedEntityType[]) {
      const entities = alt[entityType] || [];
      for (const entity of entities) {
        if (entity.dataSource !== 'connected' || !entity.connectedAccountId) continue;
        const linked = accountById.get(entity.connectedAccountId);
        if (!linked || typeof linked.balance !== 'number') continue;

        const nextAutoValue = linked.balance;
        if (entity.autoValue !== nextAutoValue) {
          entity.autoValue = nextAutoValue;
          entity.lastSyncedAt = new Date().toISOString();
          changed = true;
        }

        if (!entity.overrideActive) {
          if (entityType === 'income' || entityType === 'expense') {
            const row = entity as IncomeRow;
            if (row.amount !== nextAutoValue) {
              row.amount = nextAutoValue;
              changed = true;
            }
          } else if (entityType === 'asset') {
            const row = entity as AssetRow;
            if (row.value !== nextAutoValue) {
              row.value = nextAutoValue;
              changed = true;
            }
          } else if (entityType === 'debt') {
            const row = entity as DebtRow;
            if (row.bal !== nextAutoValue) {
              row.bal = nextAutoValue;
              changed = true;
            }
          }
        }
      }
    }
  }

  return changed ? nextPlan : null;
}
