// Supabase Client Configuration
// Initializes and exports Supabase client instances for database operations.
// Clients are created only when configuration is present so the module can be
// imported (e.g. by unit tests) without env vars; production boot is guarded
// by the config validator in config.js (FRAGILE-6).

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Load .env in development
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

// Fails on first use (with a clear message) instead of at import time.
function unconfiguredClient(message) {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      throw new Error(message);
    }
  });
}

// Standard client (publishable key, respects RLS)
export const supabase = (SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: false // Server-side, no session persistence needed
      }
    })
  : unconfiguredClient(
      'Supabase is not configured: set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY environment variables'
    );

// Admin client (secret key, bypasses RLS). Stays null when the secret key is
// absent — callers already branch on this. Production refuses to boot without
// it (config.js validator).
export const supabaseAdmin = (SUPABASE_URL && SUPABASE_SECRET_KEY)
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
