import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../storage/userScopedStorage';

type RunHistory = {
  audit: string[];
  logs: string[];
  runYears: number;
  granularity: 'monthly' | 'daily';
  ranAt: string;
};

const LAST_RUN_KEY = 'tmm_last_run';

export function saveLastRun(run: RunHistory) {
  setScopedLocalStorageItem(LAST_RUN_KEY, JSON.stringify(run));
}

export function loadLastRun(): RunHistory | null {
  const raw = getScopedLocalStorageItem(LAST_RUN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RunHistory;
  } catch {
    return null;
  }
}
