// User Model
// Handles user data operations in Supabase

import { supabaseAdmin } from '../supabaseClient.js';

/**
 * Create a new user
 * @param {Object} userData - User data (email, etc.)
 * @returns {Promise<Object>} Created user
 */
export async function createUser(userData = {}) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .insert({
      email: userData.email || null
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create user: ${error.message}`);
  }

  return data;
}

/**
 * Get user by ID
 * @param {string} userId - User UUID
 * @returns {Promise<Object|null>} User object or null
 */
export async function getUserById(userId) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to get user: ${error.message}`);
  }

  return data;
}

/**
 * Get user by email
 * @param {string} email - User email
 * @returns {Promise<Object|null>} User object or null
 */
export async function getUserByEmail(email) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    throw new Error(`Failed to get user: ${error.message}`);
  }

  return data;
}

/**
 * Update user
 * @param {string} userId - User UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated user
 */
export async function updateUser(userId, updates) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update user: ${error.message}`);
  }

  return data;
}

/**
 * Get or create user by identifier
 * Helper function to get existing user or create new one
 * @param {string} identifier - Email or user ID
 * @returns {Promise<Object>} User object
 */
export async function getOrCreateUser(identifier) {
  // Try to find by email if it looks like an email
  if (identifier.includes('@')) {
    let user = await getUserByEmail(identifier);
    if (user) {
      return user;
    }
    // Create new user with email
    return await createUser({ email: identifier });
  }

  // Try to find by ID
  let user = await getUserById(identifier);
  if (user) {
    return user;
  }

  // Create new user without email
  return await createUser({});
}
