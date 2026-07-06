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


