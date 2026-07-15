// Stripe checkout/portal sessions and the Stripe webhook (money path — see
// tmm-stripe-entitlements skill before changing).
//
// Phase 4: webhook processing is table-driven (plan_catalog/tier_entitlements
// via lib/stripeWebhookHandlers.js) with stripe_events idempotency; checkout
// resolves prices from plan_catalog by lookup_key (no hardcoded price ids);
// TMM+ checkout is invite-gated in production (D2).

import express from 'express';
import Stripe from 'stripe';
import config from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../supabaseClient.js';
import { createArchiveSnapshotForUser } from '../lib/historyService.js';
import { createStripeWebhookProcessor } from '../lib/stripeWebhookHandlers.js';
import { suspendPlaidForUser, restorePlaidForUser } from '../lib/plaidLifecycle.js';
import { enqueueSyncForItem } from '../lib/plaidSyncService.js';
import { writeAuditLog } from '../lib/auditLog.js';
import { parseBooleanFlag } from '../lib/serverUtils.js';

const stripe = config.stripe.secretKey
  ? new Stripe(config.stripe.secretKey, { apiVersion: '2026-01-28.clover' })
  : null;

// D2: TMM+ is invite-gated at launch. Default on in production; dev/test
// environments keep checkout open so validation suites run without seeding.
const INVITE_REQUIRED_FOR_CHECKOUT = parseBooleanFlag(
  process.env.INVITE_REQUIRED_FOR_CHECKOUT,
  config.isProduction
);

function getFallbackAppOrigin(req) {
  const reqOrigin = String(req.headers.origin || '').trim();
  if (reqOrigin) {
    try {
      return new URL(reqOrigin).origin;
    } catch {
      // Ignore invalid Origin header and continue to configured fallback.
    }
  }
  return config.corsOrigins[0] || 'http://localhost:5173';
}

function resolveAbsoluteUrl(candidate, fallback) {
  if (!candidate || typeof candidate !== 'string') return fallback;
  try {
    return new URL(candidate).toString();
  } catch {
    return fallback;
  }
}

async function getOrCreateStripeCustomerIdForUser(userId, email) {
  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load profile: ${error.message}`);
  }

  if (profile?.stripe_customer_id) {
    return profile.stripe_customer_id;
  }

  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: {
      user_id: userId,
      supabase_user_id: userId
    }
  });

  const { error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({ stripe_customer_id: customer.id })
    .eq('id', userId);
  if (updateError) {
    throw new Error(`Failed to save Stripe customer id: ${updateError.message}`);
  }

  return customer.id;
}

/**
 * Resolve the Stripe price for a checkout request. `plan` is a plan_catalog
 * lookup_key (e.g. tmm_plus_monthly). With no plan specified, prefer the
 * active TMM+ monthly catalog row; fall back to the legacy env price only
 * when the catalog is empty (pre-4.6 dev environments).
 */
async function resolveCheckoutPriceId(plan) {
  const lookupKey = typeof plan === 'string' && plan.trim() ? plan.trim() : null;
  if (lookupKey) {
    const { data, error } = await supabaseAdmin
      .from('plan_catalog')
      .select('stripe_price_id, active')
      .eq('lookup_key', lookupKey)
      .maybeSingle();
    if (error) throw new Error(`Failed to resolve plan: ${error.message}`);
    if (!data?.active) return null;
    return data.stripe_price_id;
  }

  const { data: defaultRow, error: defaultError } = await supabaseAdmin
    .from('plan_catalog')
    .select('stripe_price_id')
    .eq('tier', 'tmm_plus')
    .eq('billing_interval', 'month')
    .eq('active', true)
    .maybeSingle();
  if (defaultError) throw new Error(`Failed to resolve default plan: ${defaultError.message}`);
  if (defaultRow?.stripe_price_id) return defaultRow.stripe_price_id;

  return config.stripe.tmmPlusPriceId || null;
}

async function userHasRedeemedInvite(userId) {
  const { data, error } = await supabaseAdmin
    .from('invites')
    .select('code')
    .eq('redeemed_by', userId)
    .limit(1);
  if (error) throw new Error(`Failed to check invite: ${error.message}`);
  return (data || []).length > 0;
}

const router = express.Router();

router.post('/api/stripe/create-checkout-session', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured on the backend' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database admin client unavailable' });
    }

    if (INVITE_REQUIRED_FOR_CHECKOUT) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('is_admin')
        .eq('id', req.userId)
        .maybeSingle();
      if (!profile?.is_admin && !(await userHasRedeemedInvite(req.userId))) {
        return res.status(403).json({
          error: 'TMM+ is invite-only right now',
          message: 'Join the waitlist and redeem an invite code to subscribe.',
          code: 'INVITE_REQUIRED'
        });
      }
    }

    const body = req.body || {};
    const priceId = await resolveCheckoutPriceId(body.plan);
    if (!priceId) {
      return res.status(400).json({
        error: 'Unknown plan',
        message: 'The requested plan is not available.',
        code: 'UNKNOWN_PLAN'
      });
    }

    const origin = getFallbackAppOrigin(req);
    const successUrl = resolveAbsoluteUrl(body.success_url, `${origin}?stripe=success`);
    const cancelUrl = resolveAbsoluteUrl(body.cancel_url, `${origin}?stripe=cancel`);
    const customerId = await getOrCreateStripeCustomerIdForUser(req.userId, req.user?.email || null);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: req.userId,
      subscription_data: {
        metadata: {
          user_id: req.userId,
          supabase_user_id: req.userId
        }
      }
    });

    if (!session.url) {
      throw new Error('Stripe did not return a Checkout session URL');
    }

    return res.json({ url: session.url });
  } catch (err) {
    return next(err);
  }
});

router.post('/api/stripe/create-portal-session', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured on the backend' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database admin client unavailable' });
    }

    const { data: profile, error } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.userId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to load profile: ${error.message}`);
    }
    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ error: 'No subscription found; use Upgrade to TMM+ to subscribe.' });
    }

    const origin = getFallbackAppOrigin(req);
    const body = req.body || {};
    const returnUrl = resolveAbsoluteUrl(body.return_url, `${origin}?stripe=success`);

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: returnUrl
    });

    return res.json({ url: portalSession.url });
  } catch (err) {
    return next(err);
  }
});

// Webhook processor wired with the real side effects (ADR-6 lifecycle hooks).
const processStripeEvent = supabaseAdmin
  ? createStripeWebhookProcessor({
      supabaseAdmin,
      archiveSnapshot: (userId, meta) => createArchiveSnapshotForUser(userId, meta),
      suspendPlaid: async (userId, { reason }) => {
        await suspendPlaidForUser(userId, { reason });
        await writeAuditLog({
          userId,
          actor: 'webhook',
          action: 'entitlement.downgrade',
          metadata: { trigger: reason }
        });
      },
      restorePlaid: async (userId) => {
        await restorePlaidForUser(userId, {
          enqueueCatchUpSync: ({ userId: uid, itemId, trigger }) =>
            enqueueSyncForItem({ userId: uid, itemId, trigger })
        });
        await writeAuditLog({
          userId,
          actor: 'webhook',
          action: 'entitlement.restore',
          metadata: {}
        });
      }
    })
  : null;

// Stripe webhook endpoint (server-only, no user JWT). Requires raw body for signature verification.
router.post('/api/webhooks/stripe', async (req, res, next) => {
  try {
    if (!stripe || !config.stripe.webhookSecret) {
      return res.status(503).json({ error: 'Stripe webhook is not configured' });
    }
    if (!supabaseAdmin || !processStripeEvent) {
      return res.status(503).json({ error: 'Database admin client unavailable' });
    }

    const requestId = req.requestId || 'unknown';
    const authHeader = req.headers.authorization;
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      console.warn(JSON.stringify({
        type: 'webhook_rejected',
        requestId,
        reason: 'Bearer token not allowed on webhook',
        path: req.path,
        timestamp: new Date().toISOString()
      }));
      return res.status(403).json({ error: 'Webhook endpoint does not accept user authentication' });
    }

    const stripeSignature = String(req.headers['stripe-signature'] || '');
    if (!stripeSignature) {
      return res.status(400).json({ error: 'Stripe signature missing' });
    }

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, stripeSignature, config.stripe.webhookSecret);
    } catch (err) {
      return res.status(400).json({ error: `Invalid Stripe signature: ${err.message}` });
    }

    const result = await processStripeEvent(event);

    console.log(JSON.stringify({
      type: 'webhook_stripe',
      requestId,
      path: req.path,
      eventType: event.type || null,
      eventId: event.id || null,
      outcome: result.outcome,
      detail: result.detail || null,
      timestamp: new Date().toISOString()
    }));
    // 200 for processed/ignored/replayed; genuine handler errors throw and
    // reach the error middleware -> 5xx -> Stripe retries (idempotency-safe).
    return res.status(200).json({ received: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
