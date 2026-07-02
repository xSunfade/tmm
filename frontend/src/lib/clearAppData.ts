/**
 * Known localStorage/sessionStorage keys used by TMM for app data (plan, sheets, tour, etc.).
 * Must NOT include Supabase auth key (sb-*-auth-token) — clearing keeps user signed in.
 */
import {
  removeAllScopedLocalStorageItems,
  removeAllScopedSessionStorageItems
} from './storage/userScopedStorage';

const APP_LOCAL_STORAGE_KEYS = [
  'mm-plan',
  'tmm_restore_declined',
  'tmm_spreadsheet_id',
  'tmm_sheet_id',
  'tmm_sheets_queue',
  'tmm_connect_sheets_dismissed',
  'tmm_sheets_oauth_done',
  'tmm_profile_prefs',
  'tmm_connected_accounts',
  'tmm_mock_accounts',
  'tmm_tour_progress',
  'tmm_tour_completed',
  'tmm_tour_declined',
  'tmm_onboarding_state',
  'tmm_onboarding_abandonment_date',
  'tmm_theme',
  'tmm_last_run',
  'tmm_simulation_settings',
  'tmm_simulation_augments',
  'tmm_pipeline_state',
  'tmm_goals',
  'tmm_accounts',
  'lastCheckInDate'
] as const;

const LAST_SYNCED_PREFIX = 'tmm_last_synced_';
const LAST_SYNCED_SCOPED_KEY = 'tmm_last_synced';
const APP_SESSION_STORAGE_KEYS = ['tmm_onboarding_abandonment_prompt_shown'] as const;

/**
 * Clears all TMM app data from localStorage and sessionStorage.
 * Does NOT clear Supabase auth (sb-*-auth-token), so the user stays signed in to TMM and Google.
 */
export function clearAllAppData(options?: { includeLegacyGlobal?: boolean }): void {
  const includeLegacyGlobal = options?.includeLegacyGlobal ?? true;
  try {
    for (const key of APP_LOCAL_STORAGE_KEYS) {
      removeAllScopedLocalStorageItems(key);
    }
    removeAllScopedLocalStorageItems(LAST_SYNCED_SCOPED_KEY);
    for (const key of APP_SESSION_STORAGE_KEYS) {
      removeAllScopedSessionStorageItems(key);
    }

    if (includeLegacyGlobal) {
      for (const key of APP_LOCAL_STORAGE_KEYS) {
        localStorage.removeItem(key);
      }
      // Remove all legacy tmm_last_synced_<spreadsheetId> keys
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(LAST_SYNCED_PREFIX)) keysToRemove.push(key);
      }
      keysToRemove.forEach((key) => localStorage.removeItem(key));
      for (const key of APP_SESSION_STORAGE_KEYS) {
        sessionStorage.removeItem(key);
      }
    }
  } catch (error) {
    console.warn('[clearAppData] Failed to clear some keys', error);
  }
}
