/**
 * One-off script to obtain a JWT for Stripe validation (STRIPE_TEST_USER_JWT).
 * Signs in with a test user and prints the access_token and user id.
 *
 * Env (from .env, frontend/.env, or backend/.env):
 * - VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
 * - STRIPE_TEST_USER_EMAIL + STRIPE_TEST_USER_PASSWORD
 *   OR PLAYWRIGHT_TEST_USER + PLAYWRIGHT_TEST_PASSWORD
 * - Optional: SUPABASE_SERVICE_ROLE_KEY (if CAPTCHA is enabled)
 *
 * Run from repo root: npm run test:stripe:get-jwt
 * Then set STRIPE_TEST_USER_JWT=<printed token> when running Stripe live validation.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');

dotenv.config({ path: path.join(root, '.env') });
dotenv.config({ path: path.join(root, 'frontend', '.env') });
dotenv.config({ path: path.join(root, 'backend', '.env') });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email =
  process.env.STRIPE_TEST_USER_EMAIL ||
  process.env.PLAYWRIGHT_TEST_USER;
const password =
  process.env.STRIPE_TEST_USER_PASSWORD ||
  process.env.PLAYWRIGHT_TEST_PASSWORD;

if (!supabaseUrl || !anonKey) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Set in frontend/.env or .env');
  process.exit(1);
}

if (!email || !password) {
  console.error(
    'Missing test user credentials. Set either:\n' +
      '  STRIPE_TEST_USER_EMAIL + STRIPE_TEST_USER_PASSWORD\n' +
      '  or PLAYWRIGHT_TEST_USER + PLAYWRIGHT_TEST_PASSWORD\n' +
      'in .env or frontend/.env'
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey || anonKey);

const { data, error } = await supabase.auth.signInWithPassword({ email, password });

if (error) {
  console.error('Sign-in failed:', error.message);
  console.error('Ensure the user exists in Supabase with Email provider and a password.');
  process.exit(1);
}

if (!data.session?.access_token) {
  console.error('No session or access_token returned.');
  process.exit(1);
}

const jwt = data.session.access_token;
const userId = data.session.user?.id ?? '';

console.log('Copy the value below for STRIPE_TEST_USER_JWT (do not commit):\n');
console.log(jwt);
console.log('\nUser id (for STRIPE_TEST_USER_ID if needed):');
console.log(userId);
