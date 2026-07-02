// Supabase Client Configuration
// Initializes and exports Supabase client instances for database operations

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load .env in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set in environment variables');
}

// Create standard Supabase client (uses publishable key, respects RLS)
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: false // Server-side, no session persistence needed
  }
});

// Create admin client (uses secret key, bypasses RLS)
// Use this for server-side operations that need to bypass RLS
// Note: Secret keys cannot be used in browsers and will fail with HTTP 401
export const supabaseAdmin = SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: {
        persistSession: false
      }
    })
  : null;

// Export environment info for reference
export const supabaseConfig = {
  url: SUPABASE_URL,
  hasSecretKey: !!SUPABASE_SECRET_KEY
};
