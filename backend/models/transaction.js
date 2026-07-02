// Transaction Model
// Handles transaction data operations in Supabase

import { supabaseAdmin } from '../supabaseClient.js';

/**
 * Create a new transaction
 * @param {Object} transactionData - Transaction data
 * @returns {Promise<Object>} Created transaction
 */
export async function createTransaction(transactionData) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .insert({
      account_id: transactionData.accountId,
      plaid_transaction_id: transactionData.plaidTransactionId,
      amount: transactionData.amount,
      date: transactionData.date,
      name: transactionData.name,
      category: transactionData.category || [],
      merchant_name: transactionData.merchantName || null,
      pending: transactionData.pending || false,
      iso_currency_code: transactionData.isoCurrencyCode || null,
      unofficial_currency_code: transactionData.unofficialCurrencyCode || null
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create transaction: ${error.message}`);
  }

  return data;
}

/**
 * Get transactions for an account
 * @param {string} accountId - Account UUID
 * @param {Object} options - Query options (limit, offset, startDate, endDate)
 * @returns {Promise<Array>} Array of transactions
 */
export async function getTransactionsByAccount(accountId, options = {}) {
  let query = supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('account_id', accountId);

  // Apply date filters if provided
  if (options.startDate) {
    query = query.gte('date', options.startDate);
  }
  if (options.endDate) {
    query = query.lte('date', options.endDate);
  }

  // Apply sorting
  query = query.order('date', { ascending: false });

  // Apply pagination
  if (options.limit) {
    query = query.limit(options.limit);
  }
  if (options.offset) {
    query = query.range(options.offset, options.offset + (options.limit || 100) - 1);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to get transactions: ${error.message}`);
  }

  return data || [];
}

/**
 * Get transaction by Plaid transaction ID
 * @param {string} plaidTransactionId - Plaid transaction ID
 * @returns {Promise<Object|null>} Transaction object or null
 */
export async function getTransactionByPlaidId(plaidTransactionId) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('*')
    .eq('plaid_transaction_id', plaidTransactionId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to get transaction: ${error.message}`);
  }

  return data;
}

/**
 * Bulk insert transactions
 * Uses upsert to avoid duplicates based on plaid_transaction_id
 * @param {Array} transactions - Array of transaction objects
 * @returns {Promise<Array>} Array of created/updated transactions
 */
export async function bulkInsertTransactions(transactions) {
  if (!transactions || transactions.length === 0) {
    return [];
  }

  // Transform transactions to match database schema
  const transformed = transactions.map(tx => ({
    account_id: tx.accountId,
    plaid_transaction_id: tx.plaidTransactionId,
    amount: tx.amount,
    date: tx.date,
    name: tx.name,
    category: tx.category || [],
    merchant_name: tx.merchantName || null,
    pending: tx.pending || false,
    iso_currency_code: tx.isoCurrencyCode || null,
    unofficial_currency_code: tx.unofficialCurrencyCode || null
  }));

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .upsert(transformed, {
      onConflict: 'plaid_transaction_id',
      ignoreDuplicates: false
    })
    .select();

  if (error) {
    throw new Error(`Failed to bulk insert transactions: ${error.message}`);
  }

  return data || [];
}

/**
 * Delete transactions for an account
 * @param {string} accountId - Account UUID
 * @returns {Promise<void>}
 */
export async function deleteTransactionsByAccount(accountId) {
  const { error } = await supabaseAdmin
    .from('transactions')
    .delete()
    .eq('account_id', accountId);

  if (error) {
    throw new Error(`Failed to delete transactions: ${error.message}`);
  }
}

/**
 * Delete a specific transaction
 * @param {string} transactionId - Transaction UUID
 * @returns {Promise<void>}
 */
export async function deleteTransaction(transactionId) {
  const { error } = await supabaseAdmin
    .from('transactions')
    .delete()
    .eq('id', transactionId);

  if (error) {
    throw new Error(`Failed to delete transaction: ${error.message}`);
  }
}

/**
 * Get transactions by user ID (across all accounts)
 * @param {string} userId - User UUID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} Array of transactions
 */
export async function getTransactionsByUserId(userId, options = {}) {
  // First get all accounts for the user
  const { data: accounts, error: accountsError } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('user_id', userId);

  if (accountsError) {
    throw new Error(`Failed to get user accounts: ${accountsError.message}`);
  }

  if (!accounts || accounts.length === 0) {
    return [];
  }

  const accountIds = accounts.map(acc => acc.id);

  let query = supabaseAdmin
    .from('transactions')
    .select('*')
    .in('account_id', accountIds);

  // Apply date filters if provided
  if (options.startDate) {
    query = query.gte('date', options.startDate);
  }
  if (options.endDate) {
    query = query.lte('date', options.endDate);
  }

  // Apply sorting
  query = query.order('date', { ascending: false });

  // Apply pagination
  if (options.limit) {
    query = query.limit(options.limit);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to get transactions: ${error.message}`);
  }

  return data || [];
}

/**
 * Upsert transactions received from Plaid /transactions/sync added/modified arrays.
 * @param {Array<Object>} transactions - Plaid transaction objects
 * @param {Map<string, string>} localAccountIdByPlaidId - plaid_account_id -> local account UUID
 * @returns {Promise<Array>} Upserted transactions
 */
export async function upsertTransactionsFromPlaidSync(transactions, localAccountIdByPlaidId) {
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return [];
  }

  const rows = transactions
    .map((tx) => {
      const localAccountId = localAccountIdByPlaidId.get(tx.account_id);
      if (!localAccountId || !tx.transaction_id) return null;
      return {
        account_id: localAccountId,
        plaid_transaction_id: tx.transaction_id,
        amount: tx.amount,
        date: tx.date,
        name: tx.name || 'Unknown',
        category: tx.category || [],
        merchant_name: tx.merchant_name || null,
        pending: !!tx.pending,
        iso_currency_code: tx.iso_currency_code || null,
        unofficial_currency_code: tx.unofficial_currency_code || null
      };
    })
    .filter(Boolean);

  if (rows.length === 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .upsert(rows, {
      onConflict: 'plaid_transaction_id',
      ignoreDuplicates: false
    })
    .select();

  if (error) {
    throw new Error(`Failed to upsert Plaid sync transactions: ${error.message}`);
  }

  return data || [];
}

/**
 * Delete transactions by Plaid transaction IDs.
 * @param {Array<string>} plaidTransactionIds - Plaid transaction IDs
 * @returns {Promise<number>} Number of deleted rows
 */
export async function deleteTransactionsByPlaidIds(plaidTransactionIds) {
  if (!Array.isArray(plaidTransactionIds) || plaidTransactionIds.length === 0) {
    return 0;
  }

  const { data, error } = await supabaseAdmin
    .from('transactions')
    .delete()
    .in('plaid_transaction_id', plaidTransactionIds)
    .select('id');

  if (error) {
    throw new Error(`Failed to delete transactions by Plaid IDs: ${error.message}`);
  }

  return (data || []).length;
}
