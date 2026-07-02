import { migratePlan } from './migrations';
import { DEFAULT_PLAN_STATE } from './defaults';
import type { PlanState } from './types';
import {
  getActiveStorageUserId,
  getScopedLocalStorageItem,
  removeScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../storage/userScopedStorage';

const LEGACY_PLAN_KEY = 'mm-plan';
const PLAN_KEY = 'mm-plan';
const RESTORE_DECLINED_KEY = 'tmm_restore_declined';

export type RestoreDecision = {
  snapshotId: string;
  decidedAt: string;
};

export function loadPlanSnapshot(): PlanState {
  const raw = getScopedLocalStorageItem(PLAN_KEY);
  if (!raw) {
    const activeUserId = getActiveStorageUserId();
    if (activeUserId !== 'anon') {
      const legacyRaw = localStorage.getItem(LEGACY_PLAN_KEY);
      if (legacyRaw) {
        try {
          const migrated = migratePlan(JSON.parse(legacyRaw));
          setScopedLocalStorageItem(PLAN_KEY, JSON.stringify(migrated));
          localStorage.removeItem(LEGACY_PLAN_KEY);
          return migrated;
        } catch (error) {
          console.warn('[plan] Failed to migrate legacy plan snapshot', error);
        }
      }
    }
    return { ...DEFAULT_PLAN_STATE };
  }
  try {
    return migratePlan(JSON.parse(raw));
  } catch (error) {
    console.warn('[plan] Failed to parse plan snapshot', error);
    return { ...DEFAULT_PLAN_STATE };
  }
}

export function savePlanSnapshot(plan: PlanState) {
  try {
    setScopedLocalStorageItem(PLAN_KEY, JSON.stringify(plan));
  } catch (error) {
    console.warn('[plan] Failed to persist plan snapshot', error);
  }
}

export function getRestoreSnapshotId(plan: PlanState): string {
  const altNames = Object.keys(plan.alternatives || {});
  const altCount = altNames.length;
  const lastSaved = (plan as { lastSaved?: string | null }).lastSaved || null;
  return `${altCount}:${lastSaved || 'none'}`;
}

export function getRestoreDecline(): RestoreDecision | null {
  const raw = getScopedLocalStorageItem(RESTORE_DECLINED_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RestoreDecision;
  } catch {
    return null;
  }
}

export function setRestoreDecline(decision: RestoreDecision | null) {
  if (!decision) {
    removeScopedLocalStorageItem(RESTORE_DECLINED_KEY);
    return;
  }
  setScopedLocalStorageItem(RESTORE_DECLINED_KEY, JSON.stringify(decision));
}

