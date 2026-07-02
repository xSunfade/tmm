type AccountRow = { id: string; plaid_account_id: string; plaid_item_id: string; user_id: string };
type TxRow = { plaid_transaction_id: string; account_id: string; amount: number; date: string; name?: string };

export class InMemoryPlaidSyncStorage {
  tokens = new Map<string, string>();
  cursors = new Map<string, string | null>();
  accounts: AccountRow[] = [];
  transactions = new Map<string, TxRow>();
  syncRuns: Array<Record<string, unknown>> = [];
  locks = new Set<string>();
  cursorHistory = new Map<string, string[]>();
  reconciliationEvents: Array<{ id: string; previous: number; next: number; reason: string }> = [];

  key(userId: string, itemId: string): string {
    return `${userId}:${itemId}`;
  }

  setToken(userId: string, itemId: string, token: string) {
    this.tokens.set(this.key(userId, itemId), token);
  }

  seedAccounts(rows: AccountRow[]) {
    this.accounts = [...rows];
  }

  async getToken(itemId: string, userId: string) {
    const token = this.tokens.get(this.key(userId, itemId));
    if (!token) throw new Error('Token not found');
    return token;
  }

  async getTransactionsSyncCursor(itemId: string, userId: string) {
    return this.cursors.get(this.key(userId, itemId)) || null;
  }

  async setTransactionsSyncCursor(itemId: string, cursor: string | null, userId: string) {
    const key = this.key(userId, itemId);
    const current = this.cursors.get(key);
    if (current && cursor && cursor < current) {
      throw new Error(`Cursor regression ${current} -> ${cursor}`);
    }
    this.cursors.set(key, cursor);
    if (cursor) {
      const history = this.cursorHistory.get(key) || [];
      history.push(cursor);
      this.cursorHistory.set(key, history);
    }
  }

  async getAccountsByUserAndPlaidAccountIds(userId: string, plaidIds: string[]) {
    return this.accounts.filter((a) => a.user_id === userId && plaidIds.includes(a.plaid_account_id));
  }

  async getAccountsByUserAndItemId(userId: string, itemId: string) {
    return this.accounts.filter((a) => a.user_id === userId && a.plaid_item_id === itemId);
  }

  async upsertTransactionsFromPlaidSync(transactions: any[], byPlaidAccountId: Map<string, string>) {
    const rows: TxRow[] = [];
    for (const tx of transactions) {
      const accountId = byPlaidAccountId.get(tx.account_id);
      if (!accountId) continue;
      const row: TxRow = {
        plaid_transaction_id: tx.transaction_id,
        account_id: accountId,
        amount: Number(tx.amount || 0),
        date: tx.date,
        name: tx.name || 'Unknown'
      };
      const existing = this.transactions.get(row.plaid_transaction_id);
      this.transactions.set(row.plaid_transaction_id, row);
      this.reconciliationEvents.push({
        id: row.plaid_transaction_id,
        previous: Number(existing?.amount || 0),
        next: Number(row.amount || 0),
        reason: existing ? 'modified' : 'added'
      });
      rows.push(row);
    }
    return rows;
  }

  async deleteTransactionsByPlaidIds(ids: string[]) {
    let deleted = 0;
    for (const id of ids) {
      const existing = this.transactions.get(id);
      if (this.transactions.delete(id)) {
        deleted += 1;
        this.reconciliationEvents.push({
          id,
          previous: Number(existing?.amount || 0),
          next: 0,
          reason: 'removed'
        });
      }
    }
    return deleted;
  }

  async acquirePlaidItemSyncLock({ userId, itemId }: { userId: string; itemId: string }) {
    const lockKey = `${userId}:${itemId}`;
    if (this.locks.has(lockKey)) {
      return { acquired: false, reason: 'locked' };
    }
    this.locks.add(lockKey);
    return { acquired: true, reason: null };
  }

  async releasePlaidItemSyncLock({ userId, itemId }: { userId: string; itemId: string }) {
    const lockKey = `${userId}:${itemId}`;
    this.locks.delete(lockKey);
  }

  async logPlaidSyncRunStart(data: Record<string, unknown>) {
    this.syncRuns.push({ ...data, status: 'running' });
  }

  async logPlaidSyncRunFinish(data: Record<string, unknown>) {
    this.syncRuns.push({ ...data, status: data.status || 'completed' });
  }
}
