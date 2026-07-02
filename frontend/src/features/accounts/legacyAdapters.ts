import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

export type AccountCategory = 'income' | 'expense' | 'asset' | 'debt';

export type AccountRow = {
  id: string;
  name: string;
  amount: number;
  notes?: string;
};

export type AccountsState = Record<AccountCategory, AccountRow[]>;

const STORAGE_KEY = 'tmm_accounts';

const DEFAULT_STATE: AccountsState = {
  income: [],
  expense: [],
  asset: [],
  debt: []
};

function readStorage(): AccountsState {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  const raw = getScopedLocalStorageItem(STORAGE_KEY);
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as AccountsState;
    return {
      income: parsed.income ?? [],
      expense: parsed.expense ?? [],
      asset: parsed.asset ?? [],
      debt: parsed.debt ?? []
    };
  } catch (error) {
    console.warn('[accounts] Failed to parse accounts', error);
    return DEFAULT_STATE;
  }
}

function writeStorage(state: AccountsState) {
  if (typeof window === 'undefined') return;
  setScopedLocalStorageItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadAccounts(): AccountsState {
  return readStorage();
}

export function saveAccounts(state: AccountsState) {
  writeStorage(state);
}
