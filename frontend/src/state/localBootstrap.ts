import type { AppAction } from './appState';
import {
  getScopedLocalStorageItem,
  removeScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../lib/storage/userScopedStorage';

const PROFILE_PREFS_KEY = 'tmm_profile_prefs';
const SHEET_ID_KEY = 'tmm_spreadsheet_id';
const LEGACY_SHEET_ID_KEY = 'tmm_sheet_id';
const SHEETS_DISMISSED_KEY = 'tmm_connect_sheets_dismissed';
const SHEETS_OAUTH_DONE_KEY = 'tmm_sheets_oauth_done';

export type LocalBootstrapResult = {
  sheetsConnected: boolean;
  sheetsDismissed: boolean;
};

function readProfilePrefs(): unknown | null {
  try {
    const raw = getScopedLocalStorageItem(PROFILE_PREFS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.warn('[bootstrap] Failed to parse profile prefs', error);
    return null;
  }
}

function readSheetsConnected(): boolean {
  const sheetId = getScopedLocalStorageItem(SHEET_ID_KEY) || getScopedLocalStorageItem(LEGACY_SHEET_ID_KEY);
  const oauthDone = getScopedLocalStorageItem(SHEETS_OAUTH_DONE_KEY) === '1';
  return Boolean(sheetId) || oauthDone;
}

function readSheetsDismissed(): boolean {
  return getScopedLocalStorageItem(SHEETS_DISMISSED_KEY) === '1';
}

export function bootstrapLocalState(dispatch: React.Dispatch<AppAction>): LocalBootstrapResult {
  readProfilePrefs();
  dispatch({ type: 'readiness', key: 'profileReady', value: true });

  const sheetsConnected = readSheetsConnected();
  const sheetsDismissed = readSheetsDismissed();
  dispatch({ type: 'sheets', connected: sheetsConnected, dismissed: sheetsDismissed });
  dispatch({ type: 'readiness', key: 'integrationsReady', value: true });

  return { sheetsConnected, sheetsDismissed };
}

export function persistSheetsDismissed(dismissed: boolean) {
  try {
    if (dismissed) {
      setScopedLocalStorageItem(SHEETS_DISMISSED_KEY, '1');
    } else {
      removeScopedLocalStorageItem(SHEETS_DISMISSED_KEY);
    }
  } catch (error) {
    console.warn('[bootstrap] Failed to persist sheets dismissed flag', error);
  }
}

export function persistSheetsOAuthDone(done: boolean) {
  try {
    if (done) {
      setScopedLocalStorageItem(SHEETS_OAUTH_DONE_KEY, '1');
    } else {
      removeScopedLocalStorageItem(SHEETS_OAUTH_DONE_KEY);
    }
  } catch (error) {
    console.warn('[bootstrap] Failed to persist sheets OAuth done flag', error);
  }
}
