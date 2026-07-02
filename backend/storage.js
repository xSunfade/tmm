// Storage Abstraction Layer
// Provides a unified interface for token storage using Supabase PostgreSQL

/**
 * Storage interface that all storage implementations must follow
 */
class StorageInterface {
  /**
   * Initialize the storage backend
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented');
  }

  /**
   * Store an access token for an item
   * @param {string} itemId - Plaid item ID
   * @param {string} accessToken - Encrypted access token
   * @param {string} userId - User ID (optional, defaults to 'default_user')
   * @returns {Promise<void>}
   */
  async storeToken(itemId, accessToken, userId = 'default_user') {
    throw new Error('storeToken() must be implemented');
  }

  /**
   * Retrieve an access token for an item
   * @param {string} itemId - Plaid item ID
   * @returns {Promise<string>} Encrypted access token
   */
  async getToken(itemId) {
    throw new Error('getToken() must be implemented');
  }

  /**
   * Remove a token from storage
   * @param {string} itemId - Plaid item ID
   * @returns {Promise<void>}
   */
  async removeToken(itemId) {
    throw new Error('removeToken() must be implemented');
  }

  /**
   * Check if a token exists
   * @param {string} itemId - Plaid item ID
   * @returns {Promise<boolean>} True if token exists
   */
  async hasToken(itemId) {
    throw new Error('hasToken() must be implemented');
  }

  /**
   * Retrieve the stored Plaid /transactions/sync cursor for an item.
   * @param {string} itemId - Plaid item ID
   * @param {string|null} userId - Optional user ID scope
   * @returns {Promise<string|null>} Cursor or null
   */
  async getTransactionsSyncCursor(itemId, userId = null) {
    throw new Error('getTransactionsSyncCursor() must be implemented');
  }

  /**
   * Persist Plaid /transactions/sync cursor for an item.
   * @param {string} itemId - Plaid item ID
   * @param {string|null} cursor - Cursor value
   * @param {string|null} userId - Optional user ID scope
   * @returns {Promise<void>}
   */
  async setTransactionsSyncCursor(itemId, cursor, userId = null) {
    throw new Error('setTransactionsSyncCursor() must be implemented');
  }

  /**
   * List item IDs that have tokens for a user.
   * @param {string} userId - User UUID
   * @returns {Promise<Array<string>>}
   */
  async listItemIdsForUser(userId) {
    throw new Error('listItemIdsForUser() must be implemented');
  }

  /**
   * Close the storage connection (cleanup)
   * @returns {Promise<void>}
   */
  async close() {
    throw new Error('close() must be implemented');
  }
}

// Storage instance (will be initialized based on environment)
let storageInstance = null;

/**
 * Get the storage instance
 * @returns {StorageInterface} Storage instance
 */
export function getStorage() {
  if (!storageInstance) {
    throw new Error('Storage not initialized. Call initializeStorage() first.');
  }
  return storageInstance;
}

/**
 * Initialize storage using Supabase
 * @param {Object} config - Configuration object (kept for interface compatibility)
 * @returns {Promise<StorageInterface>} Initialized storage instance
 */
export async function initializeStorage(config = {}) {
  if (storageInstance) {
    // Already initialized, close existing connection
    await storageInstance.close();
  }

  // Always use Supabase storage
  const { SupabaseStorage } = await import('./storage/supabaseStorage.js');
  storageInstance = new SupabaseStorage(config.supabase || {});

  await storageInstance.initialize();
  return storageInstance;
}

/**
 * Export the storage interface class for implementations
 */
export { StorageInterface };

