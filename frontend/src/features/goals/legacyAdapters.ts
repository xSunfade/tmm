import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

export type GoalItem = {
  id: string;
  title: string;
  targetAmount: number;
  targetDate: string;
};

const STORAGE_KEY = 'tmm_goals';

function readStorage(): GoalItem[] {
  if (typeof window === 'undefined') return [];
  const raw = getScopedLocalStorageItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as GoalItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[goals] Failed to parse goals', error);
    return [];
  }
}

function writeStorage(goals: GoalItem[]) {
  if (typeof window === 'undefined') return;
  setScopedLocalStorageItem(STORAGE_KEY, JSON.stringify(goals));
}

export function loadGoals(): GoalItem[] {
  return readStorage();
}

export function saveGoals(goals: GoalItem[]) {
  writeStorage(goals);
}
