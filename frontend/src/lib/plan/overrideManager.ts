import type { IncomeRow, ExpenseRow, AssetRow, DebtRow } from './types';

type Entity = IncomeRow | ExpenseRow | AssetRow | DebtRow;

export function getEffectiveValue(entity: Entity): number {
  if (entity.dataSource === 'connected') {
    if (entity.overrideActive && entity.manualValue !== null && entity.manualValue !== undefined) {
      return entity.manualValue;
    }
    if (entity.autoValue !== null && entity.autoValue !== undefined) {
      return entity.autoValue;
    }
  }

  if ('amount' in entity) return entity.amount || 0;
  if ('value' in entity) return entity.value || 0;
  if ('bal' in entity) return entity.bal || 0;
  return 0;
}

export function applyManualOverride(entity: Entity, value: number) {
  entity.overrideActive = true;
  entity.manualValue = value;
  entity.lastOverriddenAt = new Date().toISOString();
}

export function revertToConnected(entity: Entity) {
  entity.overrideActive = false;
  entity.manualValue = null;
  entity.lastOverriddenAt = new Date().toISOString();
}

