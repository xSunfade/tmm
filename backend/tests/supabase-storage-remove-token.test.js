import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStorage } from '../storage/supabaseStorage.js';

// BUG-2 regression: removeToken previously ran an inverted post-delete check
// that threw "Token not found" when the token STILL existed and passed
// silently when the delete matched nothing.

function fakeClient({ deletedRows = [], error = null } = {}) {
  const seen = { filters: {} };
  const builder = {
    delete() {
      return builder;
    },
    eq(column, value) {
      seen.filters[column] = value;
      return builder;
    },
    select: async () => ({ data: deletedRows, error })
  };
  return {
    seen,
    from(table) {
      seen.table = table;
      return builder;
    }
  };
}

test('removeToken succeeds silently when a token row is deleted', async () => {
  const client = fakeClient({ deletedRows: [{ item_id: 'item_1' }] });
  const storage = new SupabaseStorage({ client });
  await storage.removeToken('item_1', 'user-1');
  assert.equal(client.seen.table, 'plaid_tokens');
  assert.equal(client.seen.filters.item_id, 'item_1');
  assert.equal(client.seen.filters.user_id, 'user-1');
});

test('removeToken throws "Token not found" when nothing was deleted', async () => {
  const client = fakeClient({ deletedRows: [] });
  const storage = new SupabaseStorage({ client });
  await assert.rejects(
    () => storage.removeToken('missing_item', 'user-1'),
    /Token not found for item: missing_item/
  );
});

test('removeToken surfaces database errors', async () => {
  const client = fakeClient({ deletedRows: null, error: { message: 'db exploded' } });
  const storage = new SupabaseStorage({ client });
  await assert.rejects(() => storage.removeToken('item_1'), /Failed to remove token: db exploded/);
});

test('removeToken requires itemId', async () => {
  const storage = new SupabaseStorage({ client: fakeClient() });
  await assert.rejects(() => storage.removeToken(null), /itemId is required/);
});
