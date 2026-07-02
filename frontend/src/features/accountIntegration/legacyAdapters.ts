import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

export type ConnectedAccount = {
  id: string;
  name: string;
  institution: string;
  balance?: number;
  currencyCode?: string;
  lastSyncIso?: string | null;
  accountId?: string;
  itemId?: string;
  accountType?: string;
  provider?: string;
  linkedEntityId?: string;
  connectionStatus?: string;
  staleReason?: string | null;
  itemStatus?: string;
  needsUpdateMode?: boolean;
  lastWebhookCode?: string | null;
};

const STORAGE_KEY = 'tmm_connected_accounts';

function readStorage(): ConnectedAccount[] {
  if (typeof window === 'undefined') return [];
  const raw = getScopedLocalStorageItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ConnectedAccount[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[account-integration] Failed to parse connected accounts', error);
    return [];
  }
}

function writeStorage(accounts: ConnectedAccount[]) {
  if (typeof window === 'undefined') return;
  setScopedLocalStorageItem(STORAGE_KEY, JSON.stringify(accounts));
}

export function loadConnectedAccounts(): ConnectedAccount[] {
  return readStorage();
}

/** Load only mock accounts from localStorage (for merging with backend Plaid list) */
export function loadMockAccountsOnly(): ConnectedAccount[] {
  return readStorage().filter((a) => a.provider === 'mock');
}

export type PlaidItemWithAccounts = {
  item_id: string;
  institution_name: string | null;
  connected: boolean;
  item_status?: {
    status?: string;
    needs_update_mode?: boolean;
    last_error_code?: string | null;
    last_webhook_type?: string | null;
    last_webhook_code?: string | null;
  } | null;
  accounts: Array<{
    plaid_account_id: string;
    name: string;
    type: string;
    subtype?: string;
    balance?: number;
    currency_code?: string;
    last_synced_at?: string;
    current?: boolean;
    is_current?: boolean;
    is_stale?: boolean;
    stale_reason?: string | null;
  }>;
};

export type PlaidItemsWithAccountsResponse = {
  items: PlaidItemWithAccounts[];
  item_count?: number;
  item_cap?: number;
};

/**
 * Load Plaid items with nested accounts (grouped by institution) from backend.
 */
export async function loadPlaidItemsWithAccountsResponse(
  plaidBaseUrl: string,
  authFetch: (url: string, options?: RequestInit) => Promise<any>
): Promise<PlaidItemsWithAccountsResponse> {
  const base = plaidBaseUrl.replace(/\/$/, '');
  const res = await authFetch(`${base}/api/plaid/items-with-accounts`, { method: 'GET', cache: 'no-store' });
  return {
    items: res?.items || [],
    item_count: typeof res?.item_count === 'number' ? res.item_count : undefined,
    item_cap: typeof res?.item_cap === 'number' ? res.item_cap : undefined
  };
}

export function flattenPlaidItemsToConnectedAccounts(items: PlaidItemWithAccounts[]): ConnectedAccount[] {
  const flat: ConnectedAccount[] = [];
  for (const item of items) {
    for (const acc of item.accounts) {
      const markedCurrent = acc.is_current === true || acc.current === true;
      const connectionStatus = !item.connected
        ? 'disconnected'
        : markedCurrent
          ? 'connected'
          : 'stale';
      flat.push({
        id: acc.plaid_account_id,
        name: acc.name,
        institution: item.institution_name || item.item_id || 'Institution',
        accountId: acc.plaid_account_id,
        itemId: item.item_id,
        accountType: acc.type,
        provider: 'plaid',
        balance: typeof acc.balance === 'number' ? acc.balance : undefined,
        currencyCode: acc.currency_code,
        lastSyncIso: acc.last_synced_at || null,
        connectionStatus,
        staleReason: acc.stale_reason ?? null,
        itemStatus: item.item_status?.status || undefined,
        needsUpdateMode: !!item.item_status?.needs_update_mode,
        lastWebhookCode: item.item_status?.last_webhook_code ?? undefined
      });
    }
  }
  return flat;
}

/**
 * Backward-compatible helper that returns only grouped items.
 */
export async function loadPlaidItemsWithAccounts(
  plaidBaseUrl: string,
  authFetch: (url: string, options?: RequestInit) => Promise<any>
): Promise<PlaidItemWithAccounts[]> {
  const response = await loadPlaidItemsWithAccountsResponse(plaidBaseUrl, authFetch);
  return response.items;
}

/**
 * Load Plaid connected accounts from backend (flat list for linking logic).
 * Returns accounts with connectionStatus 'connected', 'stale', or 'disconnected' per account.
 * - disconnected: item has no token
 * - stale: account freshness is stale per backend DB status/timestamps
 * - connected: account freshness is current per backend DB status/timestamps
 */
export async function loadPlaidAccountsFromBackend(
  plaidBaseUrl: string,
  authFetch: (url: string, options?: RequestInit) => Promise<any>
): Promise<ConnectedAccount[]> {
  const response = await loadPlaidItemsWithAccountsResponse(plaidBaseUrl, authFetch);
  return flattenPlaidItemsToConnectedAccounts(response.items);
}

export function saveConnectedAccounts(accounts: ConnectedAccount[]) {
  writeStorage(accounts);
}
