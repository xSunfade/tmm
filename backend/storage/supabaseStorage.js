// Supabase Storage Implementation
// Provides persistent token storage using Supabase PostgreSQL database

import { supabaseAdmin } from '../supabaseClient.js';
import { StorageInterface } from '../storage.js';

/**
 * Supabase storage implementation
 */
export class SupabaseStorage extends StorageInterface {
  constructor(config = {}) {
    super();
    this.config = config;
  }

  /**
   * Initialize the Supabase storage
   * Verifies connection by querying a table that exists in the schema.
   * Uses public.profiles (migration 006); plaid_tokens (001) is required for token storage.
   * @returns {Promise<void>}
   */
  async initialize() {
    try {
      // Verify connection: prefer profiles (006) as it exists in auth-focused setups; fallback to plaid_tokens (001)
      let error = null;
      const { error: profilesError } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .limit(1);
      if (!profilesError) {
        console.log('Supabase storage initialized');
        return;
      }
      if (profilesError.code === 'PGRST116') {
        const { error: tokensError } = await supabaseAdmin
          .from('plaid_tokens')
          .select('item_id')
          .limit(1);
        if (!tokensError) {
          console.log('Supabase storage initialized');
          return;
        }
        error = tokensError;
      } else {
        error = profilesError;
      }
      throw new Error(`Failed to connect to Supabase: ${error.message}`);
    } catch (error) {
      console.error('Error initializing Supabase storage:', error);
      throw error;
    }
  }

  /**
   * Store an access token for an item
   * @param {string} itemId - Plaid item ID
   * @param {string} accessToken - Encrypted access token
   * @param {string} userId - User ID (UUID from auth.users, required for authenticated users)
   * @returns {Promise<void>}
   */
  async storeToken(itemId, accessToken, userId) {
    if (!itemId || !accessToken) {
      throw new Error('itemId and accessToken are required');
    }
    if (!userId) {
      throw new Error('userId is required for authenticated token storage');
    }

    try {
      // For authenticated users, userId is a UUID from auth.users
      // We can directly use it without creating a user record
      // Upsert token (insert or update)
      const { error } = await supabaseAdmin
        .from('plaid_tokens')
        .upsert({
          item_id: itemId,
          user_id: userId, // Direct UUID from auth.users
          access_token: accessToken,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'item_id'
        });

      if (error) {
        throw new Error(`Failed to store token: ${error.message}`);
      }
    } catch (error) {
      console.error('Error storing token:', error);
      throw error;
    }
  }

  /**
   * Retrieve an access token for an item
   * @param {string} itemId - Plaid item ID
   * @param {string} userId - User ID (optional, for user-scoped token retrieval)
   * @returns {Promise<string>} Encrypted access token
   */
  async getToken(itemId, userId = null) {
    if (!itemId) {
      throw new Error('itemId is required');
    }

    try {
      let query = supabaseAdmin
        .from('plaid_tokens')
        .select('access_token')
        .eq('item_id', itemId);

      // If userId is provided, filter by user_id for security
      if (userId) {
        query = query.eq('user_id', userId);
      }

      const { data, error } = await query.single();

      if (error) {
        if (error.code === 'PGRST116') {
          throw new Error(`Token not found for item: ${itemId}`);
        }
        throw new Error(`Failed to retrieve token: ${error.message}`);
      }

      if (!data) {
        throw new Error(`Token not found for item: ${itemId}`);
      }

      return data.access_token;
    } catch (error) {
      if (error.message.includes('Token not found')) {
        throw error;
      }
      console.error('Error retrieving token:', error);
      throw error;
    }
  }

  /**
   * Remove a token from storage
   * @param {string} itemId - Plaid item ID
   * @param {string} userId - User ID (optional, for user-scoped token removal)
   * @returns {Promise<void>}
   */
  async removeToken(itemId, userId = null) {
    if (!itemId) {
      throw new Error('itemId is required');
    }

    try {
      let query = supabaseAdmin
        .from('plaid_tokens')
        .delete()
        .eq('item_id', itemId);

      // If userId is provided, filter by user_id for security
      if (userId) {
        query = query.eq('user_id', userId);
      }

      const { error } = await query;

      if (error) {
        throw new Error(`Failed to remove token: ${error.message}`);
      }

      // Verify token was removed (check if it still exists)
      const { data } = await supabaseAdmin
        .from('plaid_tokens')
        .select('item_id')
        .eq('item_id', itemId)
        .single();

      if (data) {
        throw new Error(`Token not found for item: ${itemId}`);
      }
    } catch (error) {
      if (error.message.includes('Token not found')) {
        throw error;
      }
      console.error('Error removing token:', error);
      throw error;
    }
  }

  /**
   * Check if a token exists
   * @param {string} itemId - Plaid item ID
   * @returns {Promise<boolean>} True if token exists
   */
  async hasToken(itemId) {
    if (!itemId) {
      return false;
    }

    try {
      const { data, error } = await supabaseAdmin
        .from('plaid_tokens')
        .select('item_id')
        .eq('item_id', itemId)
        .single();

      if (error && error.code === 'PGRST116') {
        return false;
      }

      return !!data;
    } catch (error) {
      console.error('Error checking token existence:', error);
      return false;
    }
  }

  /**
   * Retrieve the stored Plaid /transactions/sync cursor for an item.
   * @param {string} itemId - Plaid item ID
   * @param {string|null} userId - Optional user scope
   * @returns {Promise<string|null>}
   */
  async getTransactionsSyncCursor(itemId, userId = null) {
    if (!itemId) {
      throw new Error('itemId is required');
    }

    let query = supabaseAdmin
      .from('plaid_tokens')
      .select('transactions_sync_cursor')
      .eq('item_id', itemId);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query.single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new Error(`Token not found for item: ${itemId}`);
      }
      throw new Error(`Failed to retrieve transactions sync cursor: ${error.message}`);
    }

    return data?.transactions_sync_cursor || null;
  }

  /**
   * Persist Plaid /transactions/sync cursor for an item.
   * @param {string} itemId - Plaid item ID
   * @param {string|null} cursor - Cursor value
   * @param {string|null} userId - Optional user scope
   * @returns {Promise<void>}
   */
  async setTransactionsSyncCursor(itemId, cursor, userId = null) {
    if (!itemId) {
      throw new Error('itemId is required');
    }

    let query = supabaseAdmin
      .from('plaid_tokens')
      .update({
        transactions_sync_cursor: cursor || null,
        updated_at: new Date().toISOString()
      })
      .eq('item_id', itemId);

    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { error } = await query;
    if (error) {
      throw new Error(`Failed to persist transactions sync cursor: ${error.message}`);
    }
  }

  /**
   * List Plaid item IDs that have tokens for a user.
   * @param {string} userId - User UUID
   * @returns {Promise<Array<string>>}
   */
  async listItemIdsForUser(userId) {
    if (!userId) {
      throw new Error('userId is required');
    }

    const { data, error } = await supabaseAdmin
      .from('plaid_tokens')
      .select('item_id')
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to list item IDs for user: ${error.message}`);
    }

    return (data || []).map((row) => row.item_id).filter(Boolean);
  }

  /**
   * Close the storage connection (cleanup)
   * Supabase client doesn't need explicit closing, but we implement for interface compliance
   * @returns {Promise<void>}
   */
  async close() {
    // Supabase client is stateless, no cleanup needed
    return Promise.resolve();
  }

  /**
   * Get or create a user by identifier
   * For now, we use a simple identifier string. In the future, this will use Supabase Auth.
   * @param {string} userId - User identifier (email or 'default_user')
   * @returns {Promise<{id: string}>} User record
   * @private
   */
  async _getOrCreateUser(userId) {
    try {
      // Try to find user by email if userId looks like an email
      const isEmail = userId.includes('@');
      let userRecord = null;

      if (isEmail) {
        const { data, error } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('email', userId)
          .single();

        if (!error && data) {
          userRecord = data;
        }
      }

      // If not found, try to find by ID (for 'default_user' or UUID)
      if (!userRecord) {
        const { data, error } = await supabaseAdmin
          .from('users')
          .select('id')
          .eq('id', userId)
          .single();

        if (!error && data) {
          userRecord = data;
        }
      }

      // If still not found, create a new user
      if (!userRecord) {
        const { data, error } = await supabaseAdmin
          .from('users')
          .insert({
            email: isEmail ? userId : null
          })
          .select('id')
          .single();

        if (error) {
          throw new Error(`Failed to create user: ${error.message}`);
        }

        userRecord = data;
      }

      return userRecord;
    } catch (error) {
      console.error('Error getting or creating user:', error);
      throw error;
    }
  }
}
