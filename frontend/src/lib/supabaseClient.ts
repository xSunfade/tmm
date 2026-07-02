import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function getEnvVar(key: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string {
  const value = import.meta.env[key];
  if (!value) {
    throw new Error(`Missing ${key}. Set it in your Vite env.`);
  }
  return value;
}

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const supabaseUrl = getEnvVar('VITE_SUPABASE_URL');
  const supabaseKey = getEnvVar('VITE_SUPABASE_ANON_KEY');
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];

  client = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: `sb-${projectRef}-auth-token`
    }
  });

  return client;
}
