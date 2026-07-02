// Google Tokens Storage
// Stores and retrieves Google OAuth tokens (for Sheets integration) with user association
// Uses encryption similar to Plaid token storage

import crypto from 'crypto';
import { supabaseAdmin } from '../supabaseClient.js';

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

/**
 * Encrypt a token
 * @param {string} text - Plain text token
 * @returns {string} Encrypted token (format: iv:authTag:encrypted)
 */
function encrypt(text) {
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
 * @param {string} encryptedText - Encrypted token
 * @returns {string} Decrypted token
 */
function decrypt(encryptedText) {
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
 * Store Google OAuth tokens for a user
 * @param {string} userId - User ID (UUID from auth.users)
 * @param {Object} tokens - Token object with access_token, refresh_token (optional), expires_at, google_user_id, google_user_email
 * @returns {Promise<void>}
 */
export async function storeGoogleTokens(userId, tokens) {
  if (!userId) {
    throw new Error('userId is required');
  }
  if (!tokens || !tokens.access_token) {
    throw new Error('tokens.access_token is required');
  }
  if (!tokens.expires_at) {
    throw new Error('tokens.expires_at is required');
  }

  try {
    // Encrypt tokens
    const encryptedAccessToken = encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    // Store in database
    const { error } = await supabaseAdmin
      .from('google_sheets_tokens')
      .upsert({
        user_id: userId,
        access_token: encryptedAccessToken,
        refresh_token: encryptedRefreshToken,
        expires_at: new Date(tokens.expires_at).toISOString(),
        google_user_id: tokens.google_user_id || null,
        google_user_email: tokens.google_user_email || null,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    if (error) {
      throw new Error(`Failed to store Google tokens: ${error.message}`);
    }
  } catch (error) {
    console.error('Error storing Google tokens:', error);
    throw error;
  }
}

/**
 * Retrieve Google OAuth tokens for a user
 * @param {string} userId - User ID (UUID from auth.users)
 * @returns {Promise<Object>} Decrypted tokens object
 */
export async function getGoogleTokens(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('google_sheets_tokens')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // No tokens found
      }
      throw new Error(`Failed to retrieve Google tokens: ${error.message}`);
    }

    if (!data) {
      return null;
    }

    // Decrypt tokens
    const decrypted = {
      access_token: decrypt(data.access_token),
      refresh_token: data.refresh_token ? decrypt(data.refresh_token) : null,
      expires_at: data.expires_at,
      google_user_id: data.google_user_id,
      google_user_email: data.google_user_email
    };

    return decrypted;
  } catch (error) {
    console.error('Error retrieving Google tokens:', error);
    throw error;
  }
}

/**
 * Remove Google tokens for a user
 * @param {string} userId - User ID (UUID from auth.users)
 * @returns {Promise<void>}
 */
export async function removeGoogleTokens(userId) {
  if (!userId) {
    throw new Error('userId is required');
  }

  try {
    const { error } = await supabaseAdmin
      .from('google_sheets_tokens')
      .delete()
      .eq('user_id', userId);

    if (error) {
      throw new Error(`Failed to remove Google tokens: ${error.message}`);
    }
  } catch (error) {
    console.error('Error removing Google tokens:', error);
    throw error;
  }
}

/**
 * Check if Google tokens exist for a user
 * @param {string} userId - User ID (UUID from auth.users)
 * @returns {Promise<boolean>} True if tokens exist
 */
export async function hasGoogleTokens(userId) {
  if (!userId) {
    return false;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('google_sheets_tokens')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (error && error.code === 'PGRST116') {
      return false;
    }

    return !!data;
  } catch (error) {
    console.error('Error checking Google tokens existence:', error);
    return false;
  }
}
