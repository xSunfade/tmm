// Handlers for Plaid item listing and removal.
// Extracted from server.js with injected dependencies so route behavior is
// unit-testable ahead of the Phase 2.9 router split (BUG-1, BUG-3).

/**
 * Build the GET /api/plaid/items handler.
 * Lists connected Plaid items (institutions) for the authenticated user.
 *
 * @param {Object} deps
 * @param {Object} deps.supabaseAdmin - service-role Supabase client
 * @param {number} deps.itemCap - max connected items per user
 * @returns {import('express').RequestHandler}
 */
export function createListPlaidItemsHandler({ supabaseAdmin, itemCap }) {
  return async (req, res, next) => {
    try {
      const userId = req.userId;
      const { data: rows, error } = await supabaseAdmin
        .from('plaid_tokens')
        .select('item_id')
        .eq('user_id', userId);

      if (error) {
        return res.status(500).json({ error: 'Failed to list items', message: error.message });
      }

      const items = (rows || []).map((r) => ({ item_id: r.item_id }));
      res.json({
        items,
        item_count: items.length,
        item_cap: itemCap
      });
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Fully remove a Plaid item for a user (BUG-3 / ADR-6 REVOKED transition):
 * best-effort revoke at Plaid, archive snapshot, delete accounts
 * (transactions cascade), delete the encrypted token row, remove item status.
 *
 * Contrast with /api/plaid/disconnect, which keeps an item-status row in
 * state 'disconnected' so the UI can show the institution as disconnected;
 * remove-item erases the item from the user's list entirely. Both paths
 * revoke at Plaid and must leave zero token rows behind.
 *
 * @param {Object} deps - injected collaborators (see call site in server.js)
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.itemId
 * @returns {Promise<{ plaidRevoked: boolean, tokenDeleted: boolean }>}
 */
export async function removePlaidItemForUser(deps, { userId, itemId }) {
  const {
    getToken,
    removeToken,
    plaidClient,
    createArchiveSnapshotForItem,
    deleteAccountsByUserAndItemId,
    removePlaidItemStatus,
    recordPlaidConnectionEvent,
    logger = console
  } = deps;

  let accessToken = null;
  try {
    accessToken = await getToken(itemId, userId);
  } catch (err) {
    if (!(err?.message || '').includes('Token not found')) throw err;
    // Token already gone (e.g. bank-side revocation) — continue local cleanup.
  }

  let plaidRevoked = false;
  if (accessToken) {
    try {
      await plaidClient.itemRemove({ access_token: accessToken });
      plaidRevoked = true;
    } catch (err) {
      // Best-effort: local cleanup must proceed even if Plaid is unreachable.
      // Static format string: itemId is user-provided (js/tainted-format-string).
      logger.warn('[plaid] item/remove failed for item %s:', itemId, err?.message || err);
    }
  }

  await createArchiveSnapshotForItem(userId, itemId, {
    pointSource: 'plaid_archived',
    metadata: { trigger: 'remove_item', item_id: itemId }
  });
  await deleteAccountsByUserAndItemId(userId, itemId);

  let tokenDeleted = false;
  if (accessToken) {
    await removeToken(itemId, userId);
    tokenDeleted = true;
  }

  await removePlaidItemStatus(userId, itemId);

  try {
    // 'disconnect'/'update' are the closest values allowed by the migration-017
    // CHECK constraints; metadata.trigger distinguishes remove-item from disconnect.
    await recordPlaidConnectionEvent({
      userId,
      itemId,
      eventType: 'disconnect',
      connectionType: 'update',
      metadata: { trigger: 'remove_item', plaid_revoked: plaidRevoked }
    });
  } catch (err) {
    // Event logging must not fail the removal itself.
    // Static format string: itemId is user-provided (js/tainted-format-string).
    logger.warn('[plaid] connection event log failed for item %s:', itemId, err?.message || err);
  }

  return { plaidRevoked, tokenDeleted };
}
