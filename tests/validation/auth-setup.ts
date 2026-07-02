/**
 * Playwright auth global setup: sign in with Supabase (email/password) and save
 * storage state so all tests run in an authenticated context.
 *
 * Requires in env (e.g. .env or frontend/.env):
 * - VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (from frontend)
 * - PLAYWRIGHT_TEST_USER (email), PLAYWRIGHT_TEST_PASSWORD (password)
 *
 * If your project has CAPTCHA enabled (Supabase Auth), sign-in from Node will fail
 * unless you either:
 * - Set SUPABASE_SERVICE_ROLE_KEY (from Dashboard → Settings → API): used only
 *   here to perform sign-in (CAPTCHA is bypassed with service role). Do not commit.
 * - Or disable CAPTCHA in Dashboard → Authentication → Bot and Abuse Protection.
 *
 * The saved storage state also sets tmm_tour_declined, tmm_onboarding_state, and
 * tmm_connect_sheets_dismissed so the tour, onboarding, and Connect Sheets nudge
 * never appear (dashboard stays visible for parity tests).
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'user.json');

async function globalSetup() {
  dotenv.config();
  dotenv.config({ path: path.join(process.cwd(), 'frontend', '.env') });
  dotenv.config({ path: path.join(process.cwd(), 'backend', '.env') });

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.PLAYWRIGHT_TEST_USER;
  const password = process.env.PLAYWRIGHT_TEST_PASSWORD;
  const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';

  if (!supabaseUrl || !anonKey || !email || !password) {
    throw new Error(
      'Playwright auth setup needs: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, PLAYWRIGHT_TEST_USER, PLAYWRIGHT_TEST_PASSWORD. ' +
        'Set them in .env or frontend/.env. Create a test user in Supabase with Email provider and a password.'
    );
  }

  // Use service role key when set: bypasses CAPTCHA so sign-in works from Node (do not commit this key).
  const supabase = createClient(supabaseUrl, serviceRoleKey || anonKey);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    throw new Error(
      `Playwright auth setup: sign-in failed (${error.message}). Ensure the test user exists and has a password set.`
    );
  }

  if (!data.session) {
    throw new Error('Playwright auth setup: no session returned from sign-in.');
  }

  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  const storageKey = `sb-${projectRef}-auth-token`;
  const storageValue = JSON.stringify(data.session);

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: storageKey, value: storageValue }
  );
  // Disable tour, onboarding, and Sheets nudge for validation so dashboard stays visible (no overlay)
  await page.evaluate(() => {
    localStorage.setItem('tmm_tour_declined', 'true');
    localStorage.setItem(
      'tmm_onboarding_state',
      JSON.stringify({
        onboardingCompleted: true,
        tourVersion: '1.0',
        surveyCompleted: true,
        currentPath: ['dashboard']
      })
    );
    localStorage.setItem('tmm_connect_sheets_dismissed', '1');
  });

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  await context.storageState({ path: AUTH_FILE });
  await browser.close();

  console.log('[playwright] Auth state saved to', AUTH_FILE);
}

export default globalSetup;
