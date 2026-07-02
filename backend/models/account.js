// Account Model
// Handles bank account data operations in Supabase

import { supabaseAdmin } from '../supabaseClient.js';

/**
 * Create a new account
 * @param {Object} accountData - Account data
 * @returns {Promise<Object>} Created account
 */
export async function createAccount(accountData) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .insert({
      user_id: accountData.userId,
      plaid_item_id: accountData.plaidItemId,
      plaid_account_id: accountData.plaidAccountId,
      name: accountData.name,
      type: accountData.type,
      subtype: accountData.subtype || null,
      balance: accountData.balance || 0,
      currency_code: accountData.currencyCode || 'USD',
      last_synced_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create account: ${error.message}`);
  }

  return data;
}

/**
 * Get all accounts for a user
 * @param {string} userId - User UUID
 * @returns {Promise<Array>} Array of accounts
 */
export async function getAccountsByUserId(userId) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to get accounts: ${error.message}`);
  }

  return data || [];
}

/**
 * Get distinct Plaid item IDs that have accounts for this user.
 * @param {string} userId - User UUID
 * @returns {Promise<Array<string>>} Array of distinct plaid_item_id values
 */
export async function getItemIdsWithAccounts(userId) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('plaid_item_id')
    .eq('user_id', userId);

  if (error) {
    throw new Error(`Failed to get item IDs for user accounts: ${error.message}`);
  }

  const ids = new Set((data || []).map((row) => row.plaid_item_id).filter(Boolean));
  return Array.from(ids);
}

/**
 * Get accounts for a user and Plaid item (for reconnect old-account lookup).
 * @param {string} userId - User UUID
 * @param {string} plaidItemId - Plaid item ID
 * @returns {Promise<Array>} Array of accounts
 */
export async function getAccountsByUserAndItemId(userId, plaidItemId) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('plaid_item_id', plaidItemId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to get accounts for item: ${error.message}`);
  }

  return data || [];
}

/**
 * Delete all accounts for a user and Plaid item (e.g. when user removes a "Plaid Connection Lost" item).
 * @param {string} userId - User UUID
 * @param {string} plaidItemId - Plaid item ID
 * @returns {Promise<void>}
 */
export async function deleteAccountsByUserAndItemId(userId, plaidItemId) {
  const { error } = await supabaseAdmin
    .from('accounts')
    .delete()
    .eq('user_id', userId)
    .eq('plaid_item_id', plaidItemId);

  if (error) {
    throw new Error(`Failed to delete accounts for item: ${error.message}`);
  }
}

/**
 * Delete a single account for a user by Plaid account ID (e.g. when user removes one sub-account from the list).
 * @param {string} userId - User UUID
 * @param {string} plaidAccountId - Plaid account ID (plaid_account_id)
 * @returns {Promise<void>}
 */
export async function deleteAccountByUserAndPlaidAccountId(userId, plaidAccountId) {
  const { error } = await supabaseAdmin
    .from('accounts')
    .delete()
    .eq('user_id', userId)
    .eq('plaid_account_id', plaidAccountId);

  if (error) {
    throw new Error(`Failed to delete account: ${error.message}`);
  }
}

/**
 * Get account by ID
 * @param {string} accountId - Account UUID
 * @returns {Promise<Object|null>} Account object or null
 */
export async function getAccountById(accountId) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to get account: ${error.message}`);
  }

  return data;
}

/**
 * Get account by Plaid account ID
 * @param {string} userId - User UUID
 * @param {string} plaidAccountId - Plaid account ID
 * @returns {Promise<Object|null>} Account object or null
 */
export async function getAccountByPlaidId(userId, plaidAccountId) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('plaid_account_id', plaidAccountId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to get account: ${error.message}`);
  }

  return data;
}

/**
 * Get accounts for a user by a list of Plaid account IDs.
 * @param {string} userId - User UUID
 * @param {Array<string>} plaidAccountIds - Plaid account IDs
 * @returns {Promise<Array>} Matching account rows
 */
export async function getAccountsByUserAndPlaidAccountIds(userId, plaidAccountIds) {
  if (!Array.isArray(plaidAccountIds) || plaidAccountIds.length === 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('*')
    .eq('user_id', userId)
    .in('plaid_account_id', plaidAccountIds);

  if (error) {
    throw new Error(`Failed to get accounts by Plaid IDs: ${error.message}`);
  }

  return data || [];
}

/**
 * Update account
 * @param {string} accountId - Account UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated account
 */
export async function updateAccount(accountId, updates) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', accountId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update account: ${error.message}`);
  }

  return data;
}

/**
 * Update an account row with Plaid account data (used for reconnect in place).
 * @param {string} accountId - Account UUID
 * @param {Object} plaidAccount - Plaid account object from accounts/get
 * @returns {Promise<Object>} Updated account
 */
export async function updateAccountFromPlaidData(accountId, plaidAccount) {
  return await updateAccount(accountId, {
    plaid_account_id: plaidAccount.account_id,
    name: plaidAccount.name || 'Unknown',
    type: plaidAccount.type || 'other',
    subtype: plaidAccount.subtype || null,
    balance: (plaidAccount.balances && plaidAccount.balances.current != null)
      ? plaidAccount.balances.current
      : 0,
    currency_code: (plaidAccount.balances && plaidAccount.balances.iso_currency_code) || 'USD',
    last_synced_at: new Date().toISOString(),
    persistent_account_id: plaidAccount.persistent_account_id ?? null,
    mask: plaidAccount.mask ?? null
  });
}

/**
 * Update account balance and last synced time
 * @param {string} accountId - Account UUID
 * @param {number} balance - New balance
 * @returns {Promise<Object>} Updated account
 */
export async function updateAccountBalance(accountId, balance) {
  return await updateAccount(accountId, {
    balance,
    last_synced_at: new Date().toISOString()
  });
}

/**
 * Delete account
 * @param {string} accountId - Account UUID
 * @returns {Promise<void>}
 */
export async function deleteAccount(accountId) {
  const { error } = await supabaseAdmin
    .from('accounts')
    .delete()
    .eq('id', accountId);

  if (error) {
    throw new Error(`Failed to delete account: ${error.message}`);
  }
}

/**
 * Get accounts by Plaid item ID
 * @param {string} plaidItemId - Plaid item ID
 * @returns {Promise<Array>} Array of accounts
 */
export async function getAccountsByPlaidItemId(plaidItemId) {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('*')
    .eq('plaid_item_id', plaidItemId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to get accounts: ${error.message}`);
  }

  return data || [];
}

/**
 * Upsert sub-accounts for a Plaid item (after link or refresh).
 * @param {string} userId - User UUID
 * @param {string} plaidItemId - Plaid item ID
 * @param {Array} plaidAccounts - Array from Plaid accounts/get (account_id, name, type, subtype, etc.)
 * @returns {Promise<Array>} Upserted account rows
 */
export async function upsertAccountsForItem(userId, plaidItemId, plaidAccounts) {
  if (!plaidAccounts || plaidAccounts.length === 0) return [];

  const rows = plaidAccounts.map((acc) => ({
    user_id: userId,
    plaid_item_id: plaidItemId,
    plaid_account_id: acc.account_id,
    name: acc.name || 'Unknown',
    type: acc.type || 'other',
    subtype: acc.subtype || null,
    balance: (acc.balances && acc.balances.current != null) ? acc.balances.current : 0,
    currency_code: (acc.balances && acc.balances.iso_currency_code) || 'USD',
    last_synced_at: new Date().toISOString(),
    persistent_account_id: acc.persistent_account_id ?? null,
    mask: acc.mask ?? null
  }));

  const { data, error } = await supabaseAdmin
    .from('accounts')
    .upsert(rows, {
      onConflict: 'user_id,plaid_account_id',
      ignoreDuplicates: false
    })
    .select();

  if (error) {
    throw new Error(`Failed to upsert accounts: ${error.message}`);
  }

  return data || [];
}
