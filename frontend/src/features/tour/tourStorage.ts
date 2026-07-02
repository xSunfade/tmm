import {
  getScopedLocalStorageItem,
  removeScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

const TOUR_PROGRESS_KEY = 'tmm_tour_progress';
const TOUR_COMPLETED_KEY = 'tmm_tour_completed';
const TOUR_DECLINED_KEY = 'tmm_tour_declined';

export function getTourProgress(): string | null {
  return getScopedLocalStorageItem(TOUR_PROGRESS_KEY);
}

export function setTourProgress(step: string) {
  try {
    setScopedLocalStorageItem(TOUR_PROGRESS_KEY, step);
  } catch (error) {
    console.warn('[tour] Failed to persist progress', error);
  }
}

export function isTourCompleted(): boolean {
  return getScopedLocalStorageItem(TOUR_COMPLETED_KEY) === 'true';
}

export function isTourDeclined(): boolean {
  return getScopedLocalStorageItem(TOUR_DECLINED_KEY) === 'true';
}

export function setTourDeclined() {
  try {
    setScopedLocalStorageItem(TOUR_DECLINED_KEY, 'true');
  } catch (error) {
    console.warn('[tour] Failed to set declined', error);
  }
}

export function clearTourDeclined() {
  try {
    removeScopedLocalStorageItem(TOUR_DECLINED_KEY);
  } catch (error) {
    console.warn('[tour] Failed to clear declined', error);
  }
}

export function getTourEligibility(): boolean {
  if (isTourCompleted()) return false;
  if (isTourDeclined()) return false;
  const progress = getTourProgress();
  return Boolean(progress && progress !== '0');
}

export function canResumeTour(): boolean {
  if (isTourCompleted()) return false;
  const progress = getTourProgress();
  return Boolean(progress && progress !== '0');
}

export function setTourCompleted() {
  try {
    setScopedLocalStorageItem(TOUR_COMPLETED_KEY, 'true');
    setScopedLocalStorageItem(TOUR_PROGRESS_KEY, '0');
  } catch (error) {
    console.warn('[tour] Failed to persist completion', error);
  }
}

export function clearTourCompleted() {
  try {
    removeScopedLocalStorageItem(TOUR_COMPLETED_KEY);
  } catch (error) {
    console.warn('[tour] Failed to clear completion', error);
  }
}
