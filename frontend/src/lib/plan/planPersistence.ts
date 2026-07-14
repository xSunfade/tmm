import { migratePlan } from './migrations';
import { DEFAULT_PLAN_STATE } from './defaults';
import type { PlanState } from './types';
import {
  getActiveStorageUserId,
  getScopedLocalStorageItem,
  getScopedStorageKey,
  removeScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../storage/userScopedStorage';

const LEGACY_PLAN_KEY = 'mm-plan';
const PLAN_KEY = 'mm-plan';
const RESTORE_DECLINED_KEY = 'tmm_restore_declined';
const CORRUPT_BACKUP_KEY = 'tmm.plan.corrupt-backup';

export type RestoreDecision = {
  snapshotId: string;
  decidedAt: string;
};

function backupCorruptPlanSnapshot(raw: string) {
  try {
    // Never overwrite an existing backup: the first corrupt blob is the one
    // closest to the user's real data.
    if (!getScopedLocalStorageItem(CORRUPT_BACKUP_KEY)) {
      setScopedLocalStorageItem(CORRUPT_BACKUP_KEY, raw);
    }
  } catch (error) {
    console.warn('[plan] Failed to back up corrupt plan snapshot', error);
  }
}

export function getCorruptPlanBackup(): string | null {
  return getScopedLocalStorageItem(CORRUPT_BACKUP_KEY);
}

export function clearCorruptPlanBackup(): void {
  removeScopedLocalStorageItem(CORRUPT_BACKUP_KEY);
}

/**
 * Attempts to parse the corrupt-plan backup again. On success the recovered
 * plan becomes the live snapshot and the backup is cleared; returns null when
 * there is no backup or it still cannot be parsed.
 */
export function retryCorruptPlanBackup(): PlanState | null {
  const raw = getCorruptPlanBackup();
  if (!raw) return null;
  let recovered: PlanState;
  try {
    recovered = migratePlan(JSON.parse(raw));
  } catch (error) {
    console.warn('[plan] Corrupt plan backup still cannot be parsed', error);
    return null;
  }
  try {
    setScopedLocalStorageItem(PLAN_KEY, JSON.stringify(recovered));
    clearCorruptPlanBackup();
  } catch (error) {
    console.warn('[plan] Recovered plan could not be re-saved', error);
  }
  return recovered;
}

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
    backupCorruptPlanSnapshot(raw);
    return { ...DEFAULT_PLAN_STATE };
  }
}

/** Returns true when the snapshot was written; false when persistence failed (e.g. quota). */
export function savePlanSnapshot(plan: PlanState): boolean {
  try {
    setScopedLocalStorageItem(PLAN_KEY, JSON.stringify(plan));
    return true;
  } catch (error) {
    console.warn('[plan] Failed to persist plan snapshot', error);
    return false;
  }
}

/**
 * Cross-tab storage guard (Phase 2.7): notifies this tab when another tab
 * saves the plan for the same user. The browser only fires `storage` events
 * in tabs that did NOT perform the write, so any hit means this tab is stale.
 * Returns an unsubscribe function.
 */
export function subscribeToExternalPlanWrites(onExternalWrite: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const watchedKey = getScopedStorageKey(PLAN_KEY);
  const handler = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return;
    if (event.key !== watchedKey) return;
    onExternalWrite();
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
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

