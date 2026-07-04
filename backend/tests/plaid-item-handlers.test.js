import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createListPlaidItemsHandler,
  removePlaidItemForUser
} from '../lib/plaidItemHandlers.js';

// ---------------------------------------------------------------------------
// GET /api/plaid/items (BUG-1 regression: handler must not reference
// undefined variables and must return { items, item_count, item_cap })
// ---------------------------------------------------------------------------

function fakeSupabaseWithRows(rows, error = null) {
  return {
    from() {
      return {
        select() {
          return {
            eq: async () => ({ data: rows, error })
          };
        }
      };
    }
  };
}

async function requestItems(rows, { error = null } = {}) {
  const app = express();
  app.get(
    '/api/plaid/items',
    (req, _res, next) => {
      req.userId = 'user-1';
      next();
    },
    createListPlaidItemsHandler({
      supabaseAdmin: fakeSupabaseWithRows(rows, error),
      itemCap: 5
    })
  );

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/plaid/items`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('GET /api/plaid/items returns empty list for 0 items', async () => {
  const { status, body } = await requestItems([]);
  assert.equal(status, 200);
  assert.deepEqual(body, { items: [], item_count: 0, item_cap: 5 });
});

test('GET /api/plaid/items returns a single item', async () => {
  const { status, body } = await requestItems([{ item_id: 'item_a' }]);
  assert.equal(status, 200);
  assert.deepEqual(body.items, [{ item_id: 'item_a' }]);
  assert.equal(body.item_count, 1);
});

test('GET /api/plaid/items returns N items with matching count', async () => {
  const rows = [{ item_id: 'item_a' }, { item_id: 'item_b' }, { item_id: 'item_c' }];
  const { status, body } = await requestItems(rows);
  assert.equal(status, 200);
  assert.equal(body.items.length, 3);
  assert.equal(body.item_count, 3);
  assert.equal(body.item_cap, 5);
});

test('GET /api/plaid/items surfaces DB errors as 500', async () => {
  const { status, body } = await requestItems(null, { error: { message: 'boom' } });
  assert.equal(status, 500);
  assert.equal(body.error, 'Failed to list items');
});

// ---------------------------------------------------------------------------
// removePlaidItemForUser (BUG-3 regression: remove-item must revoke at Plaid
// and delete the token row; zero orphan tokens after removal)
// ---------------------------------------------------------------------------

function makeRemovalDeps(overrides = {}) {
  const calls = [];
  const deps = {
    getToken: async () => 'access-token-1',
    removeToken: async (...args) => calls.push(['removeToken', ...args]),
    plaidClient: {
      itemRemove: async (...args) => calls.push(['itemRemove', ...args])
    },
    createArchiveSnapshotForItem: async (...args) => calls.push(['snapshot', args[0], args[1]]),
    deleteAccountsByUserAndItemId: async (...args) => calls.push(['deleteAccounts', ...args]),
    removePlaidItemStatus: async (...args) => calls.push(['removeStatus', ...args]),
    recordPlaidConnectionEvent: async (event) => calls.push(['event', event]),
    logger: { warn: () => {} },
    ...overrides
  };
  return { deps, calls };
}

test('remove-item revokes at Plaid, deletes token row, accounts, and status', async () => {
  const { deps, calls } = makeRemovalDeps();
  const result = await removePlaidItemForUser(deps, { userId: 'u1', itemId: 'item_1' });

  assert.equal(result.plaidRevoked, true);
  assert.equal(result.tokenDeleted, true);

  const names = calls.map((c) => c[0]);
  assert.ok(names.includes('itemRemove'), 'must call Plaid itemRemove');
  assert.ok(names.includes('removeToken'), 'must delete the token row');
  assert.ok(names.includes('deleteAccounts'));
  assert.ok(names.includes('removeStatus'));

  const removeTokenCall = calls.find((c) => c[0] === 'removeToken');
  assert.deepEqual(removeTokenCall.slice(1), ['item_1', 'u1']);
});

test('remove-item still deletes token when Plaid revocation fails (best-effort)', async () => {
  const { deps, calls } = makeRemovalDeps({
    plaidClient: {
      itemRemove: async () => {
        throw new Error('plaid down');
      }
    }
  });
  const result = await removePlaidItemForUser(deps, { userId: 'u1', itemId: 'item_1' });

  assert.equal(result.plaidRevoked, false);
  assert.equal(result.tokenDeleted, true);
  assert.ok(calls.some((c) => c[0] === 'removeToken'), 'token row must still be deleted');
});

test('remove-item tolerates an already-missing token and cleans up locally', async () => {
  const { deps, calls } = makeRemovalDeps({
    getToken: async () => {
      throw new Error('Token not found for item: item_1');
    }
  });
  const result = await removePlaidItemForUser(deps, { userId: 'u1', itemId: 'item_1' });

  assert.equal(result.plaidRevoked, false);
  assert.equal(result.tokenDeleted, false);
  const names = calls.map((c) => c[0]);
  assert.ok(!names.includes('itemRemove'));
  assert.ok(names.includes('deleteAccounts'));
  assert.ok(names.includes('removeStatus'));
});

test('remove-item propagates unexpected token-store errors', async () => {
  const { deps } = makeRemovalDeps({
    getToken: async () => {
      throw new Error('connection refused');
    }
  });
  await assert.rejects(
    () => removePlaidItemForUser(deps, { userId: 'u1', itemId: 'item_1' }),
    /connection refused/
  );
});
