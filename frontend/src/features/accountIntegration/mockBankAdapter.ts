/**
 * Mock Bank Adapter for sandbox testing without real bank connections.
 * Creates accounts that can be linked to TMM nodes for development/testing.
 */
import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

const MOCK_STORAGE_KEY = 'tmm_mock_accounts';

export type MockAccountData = {
  accountId: string;
  accountName: string;
  accountType: string;
  balance: number;
  provider: 'mock';
  createdAt: string;
};

type MockStorage = {
  accounts: MockAccountData[];
};

function loadMockStorage(): MockStorage {
  if (typeof window === 'undefined') return { accounts: [] };
  try {
    const raw = getScopedLocalStorageItem(MOCK_STORAGE_KEY);
    if (!raw) return { accounts: [] };
    const parsed = JSON.parse(raw) as MockStorage;
    return { accounts: parsed.accounts ?? [] };
  } catch {
    return { accounts: [] };
  }
}

function saveMockStorage(data: MockStorage) {
  if (typeof window === 'undefined') return;
  setScopedLocalStorageItem(MOCK_STORAGE_KEY, JSON.stringify(data));
}

export type MockConnectParams = {
  accountName: string;
  accountType: string;
  initialBalance: number;
};

export type MockConnectResult = {
  accountId: string;
  account: {
    id: string;
    name: string;
    institution: string;
    accountId: string;
    accountType: string;
    provider: 'mock';
    lastSyncIso: string;
    connectionStatus: string;
  };
};

/**
 * Connect a mock account. Creates the account and returns it for adding to connected accounts.
 */
export function connectMockAccount(params: MockConnectParams): MockConnectResult {
  const { accountName, accountType = 'checking', initialBalance = 1000 } = params;
  const accountId = `mock_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

  const mockData: MockAccountData = {
    accountId,
    accountName: accountName || 'Mock Account',
    accountType,
    balance: initialBalance,
    provider: 'mock',
    createdAt: new Date().toISOString()
  };

  const storage = loadMockStorage();
  storage.accounts.push(mockData);
  saveMockStorage(storage);

  return {
    accountId,
    account: {
      id: accountId,
      name: mockData.accountName,
      institution: 'Mock Bank',
      accountId,
      accountType: mockData.accountType,
      provider: 'mock',
      lastSyncIso: new Date().toISOString(),
      connectionStatus: 'connected'
    }
  };
}

/**
 * Disconnect a mock account. Removes from mock storage.
 */
export function disconnectMockAccount(accountId: string): void {
  const storage = loadMockStorage();
  storage.accounts = storage.accounts.filter((a) => a.accountId !== accountId);
  saveMockStorage(storage);
}

/**
 * Fetch balance for a mock account.
 */
export function fetchMockBalance(accountId: string): number {
  const storage = loadMockStorage();
  const acc = storage.accounts.find((a) => a.accountId === accountId);
  if (!acc) throw new Error(`Mock account ${accountId} not found`);
  return acc.balance;
}
