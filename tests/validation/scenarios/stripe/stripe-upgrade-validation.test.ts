import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

type ReportLine = string;

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function decodeJwtSub(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return typeof payload?.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

function makeStripeSignature(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

async function writeReport(markdown: string) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const reportPath = path.resolve(__dirname, '../../STRIPE_VALIDATION_REPORT.md');
  await fs.writeFile(reportPath, markdown, 'utf8');
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ status: number; text: string; json: any | null }> {
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
  return { status: response.status, text, json };
}

async function run() {
  const backendUrl = String(process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  const stripeEnv = String(process.env.STRIPE_ENV || process.env.PLAID_ENV || 'sandbox').toLowerCase();
  const runLive = parseBoolean(process.env.STRIPE_VALIDATE_LIVE, false);
  const ackProd = parseBoolean(process.env.I_ACK_PROD, false) || parseBoolean(process.env.STRIPE_I_ACK_PROD, false);

  if (stripeEnv === 'production' && runLive && !ackProd) {
    throw new Error('Refusing STRIPE_VALIDATE_LIVE in production without I_ACK_PROD=true (or STRIPE_I_ACK_PROD=true)');
  }

  const report: ReportLine[] = [
    '# Stripe Validation Report',
    '',
    '## Run configuration',
    '',
    `- BACKEND_URL: \`${backendUrl}\``,
    `- STRIPE_ENV: \`${stripeEnv}\``,
    `- STRIPE_VALIDATE_LIVE: \`${runLive}\``,
    ''
  ];

  const health = await fetch(`${backendUrl}/api/health`);
  assert(health.ok, `Health endpoint failed at ${backendUrl}/api/health`);
  report.push('## Baseline contract checks', '', `- Health check: \`${health.status}\``);

  const unauthCheckout = await postJson(`${backendUrl}/api/stripe/create-checkout-session`, {});
  assert(unauthCheckout.status === 401, `Expected unauth checkout to return 401, got ${unauthCheckout.status}`);
  report.push(`- Unauthenticated checkout blocked: \`${unauthCheckout.status}\``);

  const unauthPortal = await postJson(`${backendUrl}/api/stripe/create-portal-session`, {});
  assert(unauthPortal.status === 401, `Expected unauth portal to return 401, got ${unauthPortal.status}`);
  report.push(`- Unauthenticated portal blocked: \`${unauthPortal.status}\``);

  const invalidWebhook = await postJson(
    `${backendUrl}/api/webhooks/stripe`,
    { id: 'evt_invalid', type: 'customer.subscription.updated', data: { object: { status: 'active', metadata: {} } } },
    { 'stripe-signature': 't=1,v1=invalid' }
  );
  assert(
    [400, 503].includes(invalidWebhook.status),
    `Expected invalid/missing Stripe config webhook to return 400 or 503, got ${invalidWebhook.status}`
  );
  report.push(`- Invalid webhook signature response: \`${invalidWebhook.status}\``);

  if (!runLive) {
    report.push('', '## Live Stripe flow checks', '', '- Skipped (`STRIPE_VALIDATE_LIVE` is not set to true).', '');
    await writeReport(report.join('\n'));
    console.log('✅ Stripe validation passed (baseline only; live checks skipped)');
    return;
  }

  const jwt = String(process.env.STRIPE_TEST_USER_JWT || process.env.TMM_PLUS_JWT || process.env.FREE_JWT || '').trim();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  assert(jwt.length > 0, 'STRIPE_VALIDATE_LIVE requires STRIPE_TEST_USER_JWT (or TMM_PLUS_JWT / FREE_JWT)');
  assert(webhookSecret.length > 0, 'STRIPE_VALIDATE_LIVE requires STRIPE_WEBHOOK_SECRET');

  const jwtUserId = decodeJwtSub(jwt);
  const explicitUserId = String(process.env.STRIPE_TEST_USER_ID || '').trim();
  const userId = explicitUserId || jwtUserId;
  assert(!!userId, 'Could not derive test user id. Set STRIPE_TEST_USER_ID explicitly.');

  report.push('', '## Live Stripe flow checks', '', `- Test user id: \`${userId}\``);

  const checkout = await postJson(
    `${backendUrl}/api/stripe/create-checkout-session`,
    {},
    {
      Authorization: `Bearer ${jwt}`,
      Origin: process.env.STRIPE_TEST_ORIGIN || 'http://localhost:5173'
    }
  );
  assert(checkout.status === 200, `Expected checkout session creation to return 200, got ${checkout.status}: ${checkout.text}`);
  assert(typeof checkout.json?.url === 'string', 'Checkout response missing url');
  report.push(`- Checkout session created: \`${checkout.status}\``);

  const portal = await postJson(
    `${backendUrl}/api/stripe/create-portal-session`,
    {},
    {
      Authorization: `Bearer ${jwt}`,
      Origin: process.env.STRIPE_TEST_ORIGIN || 'http://localhost:5173'
    }
  );
  assert(portal.status === 200, `Expected portal session creation to return 200, got ${portal.status}: ${portal.text}`);
  assert(typeof portal.json?.url === 'string', 'Portal response missing url');
  report.push(`- Portal session created: \`${portal.status}\``);

  const upgradeEvent = {
    id: `evt_upgrade_${Date.now()}`,
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: `sub_${Date.now()}`,
        object: 'subscription',
        status: 'active',
        metadata: {
          user_id: userId,
          supabase_user_id: userId
        }
      }
    }
  };
  const upgradePayload = JSON.stringify(upgradeEvent);
  const upgradeSignature = makeStripeSignature(upgradePayload, webhookSecret);
  const upgradeResponse = await fetch(`${backendUrl}/api/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': upgradeSignature
    },
    body: upgradePayload
  });
  const upgradeText = await upgradeResponse.text();
  assert(upgradeResponse.status === 200, `Expected upgrade webhook 200, got ${upgradeResponse.status}: ${upgradeText}`);
  report.push(`- Signed upgrade webhook accepted: \`${upgradeResponse.status}\``);

  const downgradeEvent = {
    id: `evt_downgrade_${Date.now()}`,
    object: 'event',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: `sub_${Date.now()}_down`,
        object: 'subscription',
        status: 'canceled',
        metadata: {
          user_id: userId,
          supabase_user_id: userId
        }
      }
    }
  };
  const downgradePayload = JSON.stringify(downgradeEvent);
  const downgradeSignature = makeStripeSignature(downgradePayload, webhookSecret);
  const downgradeResponse = await fetch(`${backendUrl}/api/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': downgradeSignature
    },
    body: downgradePayload
  });
  const downgradeText = await downgradeResponse.text();
  assert(downgradeResponse.status === 200, `Expected downgrade webhook 200, got ${downgradeResponse.status}: ${downgradeText}`);
  report.push(`- Signed downgrade webhook accepted: \`${downgradeResponse.status}\``);

  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
  const supabaseSecret = String(process.env.SUPABASE_SECRET_KEY || '').trim();
  if (supabaseUrl && supabaseSecret) {
    const supabase = createClient(supabaseUrl, supabaseSecret, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from('profiles')
      .select('plan_tier')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      throw new Error(`Supabase verification failed: ${error.message}`);
    }
    assert(data?.plan_tier === 'free', `Expected plan tier to be free after downgrade webhook, got ${data?.plan_tier}`);
    report.push(`- Supabase plan_tier verification after downgrade: \`${data?.plan_tier}\``);
  } else {
    report.push('- Supabase verification skipped (SUPABASE_URL / SUPABASE_SECRET_KEY not both present).');
  }

  report.push('', '## Result', '', '- Stripe validation completed successfully.', '');
  await writeReport(report.join('\n'));
  console.log('✅ Stripe validation passed');
}

run().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const failureReport = [
    '# Stripe Validation Report',
    '',
    '## Result',
    '',
    `- ❌ Failed: ${message}`,
    ''
  ].join('\n');
  try {
    await writeReport(failureReport);
  } catch {
    // noop
  }
  console.error(`❌ Stripe validation failed: ${message}`);
  process.exit(1);
});
