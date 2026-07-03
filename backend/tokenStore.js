// Token Storage Management
// Stores Plaid access tokens securely using database-backed storage with encryption

import crypto from 'crypto';
import { getStorage, initializeStorage } from './storage.js';

// Storage instance (initialized on module load)
let storage = null;

// Encryption key (in production, use a secure key management system)
// Fail closed in production if key is missing
const ALGORITHM = 'aes-256-gcm';

// Get encryption key - fail closed in production
function getEncryptionKey() {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TOKEN_ENCRYPTION_KEY is required in production. Set this environment variable.');
    }
    // In development, generate a random key (not recommended for production)
    console.warn('⚠️  TOKEN_ENCRYPTION_KEY not set. Generating random key for development only.');
    return crypto.randomBytes(32).toString('hex');
  }
  
  // Validate key format (should be 64 hex characters for 32 bytes)
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-character hexadecimal string (32 bytes)');
  }
  
  return key;
}

const ENCRYPTION_KEY = getEncryptionKey();

/**
 * Initialize token storage (called on server startup)
 * @param {Object} config - Storage configuration
 */
export async function initializeTokenStorage(config = {}) {
  try {
    storage = await initializeStorage(config);
    console.log('Token storage initialized');
  } catch (error) {
    console.error('Failed to initialize token storage:', error);
    throw error;
  }
}

/**
 * Get storage instance (throws if not initialized)
 */
function getStorageInstance() {
  if (!storage) {
    // Try to get from storage module (may have been initialized elsewhere)
    try {
      storage = getStorage();
    } catch (error) {
      throw new Error('Token storage not initialized. Call initializeTokenStorage() first.');
    }
  }
  return storage;
}

/**
 * Encrypt a token
 * Exported for tests/security/token-encryption.test.js; not part of the storage API.
 * @param {string} text - Plain text token
 * @returns {string} Encrypted token
 */
export function encrypt(text) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a token
 * Exported for tests/security/token-encryption.test.js; not part of the storage API.
 * @param {string} encryptedText - Encrypted token
 * @returns {string} Decrypted token
 */
export function decrypt(encryptedText) {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }
  
  const key = getEncryptionKey();
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

/**
 * Store an access token for an item
 * @param {string} itemId - Plaid item ID
 * @param {string} accessToken - Access token
 * @param {string} userId - User ID (optional, defaults to 'default_user')
 */
export async function storeToken(itemId, accessToken, userId = 'default_user') {
  if (!itemId || !accessToken) {
    throw new Error('itemId and accessToken are required');
  }
  
  // Encrypt the token before storing
  const encrypted = encrypt(accessToken);
  
  // Store in database
  const db = getStorageInstance();
  await db.storeToken(itemId, encrypted, userId);
}

/**
 * Retrieve an access token for an item
 * @param {string} itemId - Plaid item ID
 * @param {string} userId - User ID (optional, for user-scoped token retrieval)
 * @returns {Promise<string>} Decrypted access token
 */
export async function getToken(itemId, userId = null) {
  if (!itemId) {
    throw new Error('itemId is required');
  }
  
  // Get encrypted token from database
  const db = getStorageInstance();
  const encrypted = await db.getToken(itemId, userId);
  
  // Decrypt the token
  return decrypt(encrypted);
}

/**
 * Remove a token from storage
 * @param {string} itemId - Plaid item ID
 * @param {string} userId - User ID (optional, for user-scoped token removal)
 */
export async function removeToken(itemId, userId = null) {
  if (!itemId) {
    throw new Error('itemId is required');
  }
  
  const db = getStorageInstance();
  await db.removeToken(itemId, userId);
}

/**
 * Check if a token exists
 * @param {string} itemId - Plaid item ID
 * @returns {Promise<boolean>} True if token exists
 */
export async function hasToken(itemId) {
  if (!itemId) {
    return false;
  }
  
  try {
    const db = getStorageInstance();
    return await db.hasToken(itemId);
  } catch (error) {
    return false;
  }
}

/**
 * Retrieve stored Plaid /transactions/sync cursor for an item.
 * @param {string} itemId - Plaid item ID
 * @param {string|null} userId - Optional user scope
 * @returns {Promise<string|null>} Cursor value
 */
export async function getTransactionsSyncCursor(itemId, userId = null) {
  if (!itemId) {
    throw new Error('itemId is required');
  }

  const db = getStorageInstance();
  return await db.getTransactionsSyncCursor(itemId, userId);
}

/**
 * Persist Plaid /transactions/sync cursor for an item.
 * @param {string} itemId - Plaid item ID
 * @param {string|null} cursor - Cursor value
 * @param {string|null} userId - Optional user scope
 */
export async function setTransactionsSyncCursor(itemId, cursor, userId = null) {
  if (!itemId) {
    throw new Error('itemId is required');
  }

  const db = getStorageInstance();
  await db.setTransactionsSyncCursor(itemId, cursor, userId);
}

/**
 * List Plaid item IDs that have stored tokens for a user.
 * @param {string} userId - User UUID
 * @returns {Promise<Array<string>>}
 */
export async function listItemIdsForUser(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }

  const db = getStorageInstance();
  return await db.listItemIdsForUser(userId);
}

