import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

type JsonRecord = Record<string, unknown>;

type SyncStatusItem = {
  item_id: string;
  last_sync_finished_at: string | null;
  next_eligible_at?: string | null;
};

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, text, json };
}

async function postJson(url: string, body: JsonRecord, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, text, json };
}

async function poll<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  fetchValue: () => Promise<T>,
  done: (value: T) => boolean
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fetchValue();
    if (done(value)) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout while waiting for ${label}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../../..');

dotenv.config({ path: path.join(root, '.env') });
dotenv.config({ path: path.join(root, 'frontend', '.env') });
dotenv.config({ path: path.join(root, 'backend', '.env') });

async function run() {
  const backendUrl = String(process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const plaidEnv = String(process.env.PLAID_ENVIRONMENT || process.env.PLAID_ENV || 'sandbox').toLowerCase();
  const webhookUrl = String(process.env.PLAID_WEBHOOK_URL || '').trim();
  const ackProd = parseBoolean(process.env.I_ACK_PROD, false);

  const supabaseUrl = String(process.env.VITE_SUPABASE_URL || '').trim();
  const anonKey = String(process.env.VITE_SUPABASE_ANON_KEY || '').trim();
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const testEmail = String(process.env.PLAYWRIGHT_TEST_USER || '').trim();
  const testPassword = String(process.env.PLAYWRIGHT_TEST_PASSWORD || '').trim();

  console.log('Plaid live validation: preflight checks');
  assert(backendUrl.length > 0, 'BACKEND_URL is required');
  assert(webhookUrl.startsWith('https://'), 'PLAID_WEBHOOK_URL must be https://');
  assert(webhookUrl.includes('/api/webhooks/plaid'), 'PLAID_WEBHOOK_URL must end with /api/webhooks/plaid');
  assert(!/localhost|127\.0\.0\.1/i.test(webhookUrl), 'PLAID_WEBHOOK_URL must not point to localhost');
  assert(['sandbox', 'production'].includes(plaidEnv), `Unsupported PLAID environment for this suite: ${plaidEnv}`);
  if (plaidEnv === 'production') {
    assert(ackProd, 'Refusing production run without I_ACK_PROD=true');
  }
  assert(supabaseUrl.length > 0 && anonKey.length > 0, 'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
  assert(testEmail.length > 0 && testPassword.length > 0, 'Missing PLAYWRIGHT_TEST_USER or PLAYWRIGHT_TEST_PASSWORD');

  const supabase = createClient(supabaseUrl, serviceRoleKey || anonKey);
  const signIn = await supabase.auth.signInWithPassword({ email: testEmail, password: testPassword });
  if (signIn.error || !signIn.data.session?.access_token) {
    throw new Error(`Supabase sign-in failed: ${signIn.error?.message || 'no session access_token'}`);
  }
  const jwt = signIn.data.session.access_token;
  const authHeaders = { Authorization: `Bearer ${jwt}` };

  const health = await getJson(`${backendUrl}/api/health`);
  assert(health.ok, `Health check failed (${health.status}) at ${backendUrl}/api/health`);

  const opsBaseline = await getJson(`${backendUrl}/api/ops/plaid/health`, authHeaders);
  assert(opsBaseline.ok, `Plaid ops health failed (${opsBaseline.status}): ${opsBaseline.text}`);
  const baselineWebhookCount = Number(opsBaseline.json?.webhooks_total || 0);

  const syncBaselineResp = await getJson(`${backendUrl}/api/plaid/sync/status`, authHeaders);
  assert(syncBaselineResp.ok, `Plaid sync status failed (${syncBaselineResp.status}): ${syncBaselineResp.text}`);
  const baselineItems = Array.isArray(syncBaselineResp.json?.items)
    ? (syncBaselineResp.json.items as SyncStatusItem[])
    : [];
  assert(baselineItems.length > 0, 'No Plaid items found for test user. Connect at least one item first.');

  const now = Date.now();
  const eligibleItems = baselineItems.filter((item) => {
    const nextEligible = parseIso(item.next_eligible_at || null);
    return nextEligible == null || nextEligible <= now;
  });
  assert(
    eligibleItems.length > 0,
    'No items currently eligible for sync (outer/inner gates active). Wait until next_eligible_at and re-run.'
  );

  const webhookSmoke = await postJson(
    `${backendUrl}/api/ops/plaid/dev/webhook-smoke`,
    {
      item_ids: eligibleItems.map((item) => item.item_id),
      fire_sandbox_sync: plaidEnv === 'sandbox'
    },
    authHeaders
  );
  assert(
    webhookSmoke.ok,
    `Webhook smoke endpoint failed (${webhookSmoke.status}): ${webhookSmoke.text}`
  );
  assert(
    !!webhookSmoke.json?.ok,
    `Webhook smoke operation reported failure: ${JSON.stringify(webhookSmoke.json || {})}`
  );

  await poll(
    'plaid webhook delivery acknowledgement',
    60_000,
    2_000,
    async () => getJson(`${backendUrl}/api/ops/plaid/health`, authHeaders),
    (value) => value.ok && Number(value.json?.webhooks_total || 0) > baselineWebhookCount
  );

  const targetItemId = eligibleItems[0]?.item_id || null;
  const syncTrigger = await postJson(
    `${backendUrl}/api/plaid/transactions/sync`,
    targetItemId ? { item_id: targetItemId } : {},
    authHeaders
  );
  assert(
    syncTrigger.status === 202 || syncTrigger.status === 204,
    `Unexpected sync trigger status ${syncTrigger.status}: ${syncTrigger.text}`
  );

  let sawRunning = false;
  await poll(
    'sync status settle',
    90_000,
    2_000,
    async () => getJson(`${backendUrl}/api/plaid/sync/status`, authHeaders),
    (value) => {
      if (!value.ok) return false;
      const running = !!value.json?.running;
      if (running) {
        sawRunning = true;
        return false;
      }
      return sawRunning || syncTrigger.status === 204;
    }
  );

  const finalStatus = await getJson(`${backendUrl}/api/plaid/sync/status`, authHeaders);
  assert(finalStatus.ok, `Final sync status failed (${finalStatus.status}): ${finalStatus.text}`);
  const finalItems = Array.isArray(finalStatus.json?.items) ? (finalStatus.json.items as SyncStatusItem[]) : [];
  const finalByItem = new Map(finalItems.map((item) => [item.item_id, item]));
  const baselineByItem = new Map(baselineItems.map((item) => [item.item_id, item]));

  const advanced = eligibleItems.some((item) => {
    const before = parseIso(baselineByItem.get(item.item_id)?.last_sync_finished_at || null);
    const after = parseIso(finalByItem.get(item.item_id)?.last_sync_finished_at || null);
    return after != null && (before == null || after > before);
  });

  assert(
    advanced,
    'No eligible item advanced last_sync_finished_at. If sync was skipped (204), re-run after next_eligible_at.'
  );

  console.log('✅ Plaid live validation passed');
  console.log(`- Environment: ${plaidEnv}`);
  console.log(`- Webhook baseline count: ${baselineWebhookCount}`);
  console.log(`- Triggered sync status: ${syncTrigger.status}`);
  console.log(`- Eligible items tested: ${eligibleItems.length}`);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ Plaid live validation failed: ${message}`);
  process.exit(1);
});
