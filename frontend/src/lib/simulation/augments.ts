import { addMonths } from './dateUtils';
import type { Augment } from '../plan/types';
import { randomForKey as defaultRandomForKey } from './prng';

type AugmentRandomOptions = {
  seed?: string;
  randomForKey?: (seed: string, key: string) => number;
};

export function isAugmentActive(augment: Augment, date: Date, options?: AugmentRandomOptions): boolean {
  if (!augment.enabled) return false;
  const checkDate = date instanceof Date ? date : new Date(date);
  const startDate = new Date(augment.activation.startDate);

  if (augment.activation.probability < 1.0) {
    const key = `${augment.id}:${checkDate.toISOString().slice(0, 10)}`;
    const seed = options?.seed || 'tmm-default-seed';
    const draw = (options?.randomForKey || defaultRandomForKey)(seed, key);
    if (draw > augment.activation.probability) {
      return false;
    }
  }

  switch (augment.activation.type) {
    case 'fixed-date': {
      if (checkDate < startDate) return false;
      if (augment.duration.type === 'instant') {
        return checkDate.toISOString().slice(0, 10) === startDate.toISOString().slice(0, 10);
      }
      if (augment.duration.type === 'temporary') {
        const endDate = addMonths(startDate, augment.duration.months || 0);
        return checkDate >= startDate && checkDate <= endDate;
      }
      if (augment.duration.type === 'permanent') {
        return checkDate >= startDate;
      }
      return checkDate >= startDate;
    }
    case 'date-range': {
      const rangeEnd = augment.activation.endDate ? new Date(augment.activation.endDate) : null;
      if (rangeEnd && checkDate > rangeEnd) return false;
      if (checkDate < startDate) return false;
      if (augment.duration.type === 'instant') {
        return checkDate.toISOString().slice(0, 10) === startDate.toISOString().slice(0, 10);
      }
      if (augment.duration.type === 'temporary') {
        const endDate = addMonths(startDate, augment.duration.months || 0);
        return checkDate >= startDate && checkDate <= endDate;
      }
      if (augment.duration.type === 'permanent') {
        return checkDate >= startDate;
      }
      return checkDate >= startDate;
    }
    case 'recurring':
    case 'conditional':
    default:
      return false;
  }
}

export function getActiveAugmentsAtDate(
  augments: Augment[],
  date: Date,
  options?: AugmentRandomOptions
): Augment[] {
  return augments.filter((augment) => isAugmentActive(augment, date, options));
}

type SimulationState = {
  income: Array<{ name?: string; amount: number }>;
  expense: Array<{ name?: string; amount: number }>;
  assets: Array<{ name?: string; apy?: number }>;
  debts: Array<{ name?: string; pmt?: number }>;
  cash: number;
  temporaryIncome: number;
  temporaryExpense: number;
};

export function applyAugmentEffects(
  state: SimulationState,
  augment: Augment,
  currentDate: Date,
  options?: AugmentRandomOptions
) {
  if (!isAugmentActive(augment, currentDate, options)) return;

  augment.effects.forEach((effect) => {
    switch (effect.type) {
      case 'pause-income':
        state.income = state.income.map((inc) =>
          effect.target && inc.name !== effect.target ? inc : { ...inc, amount: 0 }
        );
        break;
      case 'add-income':
        state.temporaryIncome = (state.temporaryIncome || 0) + (Number(effect.amount) || 0);
        break;
      case 'scale-income': {
        const scaleFactor = typeof effect.scale === 'number' ? effect.scale : 1.0;
        state.income = state.income.map((inc) =>
          effect.target && inc.name !== effect.target
            ? inc
            : { ...inc, amount: inc.amount * scaleFactor }
        );
        break;
      }
      case 'pause-expense':
        state.expense = state.expense.map((exp) =>
          effect.target && exp.name !== effect.target ? exp : { ...exp, amount: 0 }
        );
        break;
      case 'add-expense':
        state.temporaryExpense = (state.temporaryExpense || 0) + (Number(effect.amount) || 0);
        break;
      case 'scale-expense': {
        const expenseScale = typeof effect.scale === 'number' ? effect.scale : 1.0;
        state.expense = state.expense.map((exp) =>
          effect.target && exp.name !== effect.target
            ? exp
            : { ...exp, amount: exp.amount * expenseScale }
        );
        break;
      }
      case 'lump-sum':
        state.cash = (state.cash || 0) + (Number(effect.amount) || 0);
        break;
      case 'scale-asset': {
        const assetScale = typeof effect.scale === 'number' ? effect.scale : 1.0;
        state.assets = state.assets.map((asset) =>
          effect.target && asset.name !== effect.target
            ? asset
            : { ...asset, apy: asset.apy !== undefined ? asset.apy * assetScale : asset.apy }
        );
        break;
      }
      case 'pause-debt':
        state.debts = state.debts.map((debt) =>
          effect.target && debt.name !== effect.target ? debt : { ...debt, pmt: 0 }
        );
        break;
      default:
        break;
    }
  });
}

