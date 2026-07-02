import {
  getScopedLocalStorageItem,
  removeAllScopedLocalStorageItems,
  removeScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../storage/userScopedStorage';

const SHEET_ID_KEY = 'tmm_spreadsheet_id';
const LEGACY_SHEET_ID_KEY = 'tmm_sheet_id';
const QUEUE_KEY = 'tmm_sheets_queue';
const LAST_SYNCED_KEY = 'tmm_last_synced';

export function getStoredSheetId() {
  return getScopedLocalStorageItem(SHEET_ID_KEY) || getScopedLocalStorageItem(LEGACY_SHEET_ID_KEY);
}

export function setStoredSheetId(id: string) {
  setScopedLocalStorageItem(SHEET_ID_KEY, id);
}

/**
 * Clears only sheet-link data from localStorage. Must never touch Supabase auth
 * storage (e.g. sb-*-auth-token) or call signOut — Unlink must not affect TMM login.
 */
export function clearStoredSheetId() {
  const id = getStoredSheetId();
  if (id) {
    try {
      removeScopedLocalStorageItem(LAST_SYNCED_KEY, id);
      // Drop pending queue items for this spreadsheet so unlink fully clears sheet data
      const queue = loadSheetQueue();
      const filtered = queue.filter((item) => item.spreadsheetId !== id);
      if (filtered.length < queue.length) saveSheetQueue(filtered);
    } catch {
      // ignore
    }
  }
  removeScopedLocalStorageItem(SHEET_ID_KEY);
  removeScopedLocalStorageItem(LEGACY_SHEET_ID_KEY);
  removeAllScopedLocalStorageItems(LAST_SYNCED_KEY);
}

export function getLastSyncedAt(spreadsheetId: string): string | null {
  if (!spreadsheetId) return null;
  try {
    return getScopedLocalStorageItem(LAST_SYNCED_KEY, spreadsheetId);
  } catch {
    return null;
  }
}

export function setLastSyncedAt(spreadsheetId: string, iso: string): void {
  if (!spreadsheetId) return;
  try {
    setScopedLocalStorageItem(LAST_SYNCED_KEY, iso, spreadsheetId);
  } catch {
    // ignore
  }
}

export type SheetQueueItem = {
  id: string;
  spreadsheetId: string;
  range: string;
  values: unknown[][];
  retries: number;
  createdAt: string;
  lastError?: string | null;
};

export function loadSheetQueue(): SheetQueueItem[] {
  const raw = getScopedLocalStorageItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveSheetQueue(queue: SheetQueueItem[]) {
  setScopedLocalStorageItem(QUEUE_KEY, JSON.stringify(queue));
}

