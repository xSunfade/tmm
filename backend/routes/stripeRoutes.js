// Stripe checkout/portal sessions and the Stripe webhook (money path — see
// tmm-stripe-entitlements skill before changing). Moved verbatim from
// server.js (Phase 2.9 router split).

import express from 'express';
import Stripe from 'stripe';
import config from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { supabaseAdmin } from '../supabaseClient.js';
import { createArchiveSnapshotForUser } from '../lib/historyService.js';

const stripe = config.stripe.secretKey
  ? new Stripe(config.stripe.secretKey, { apiVersion: '2026-01-28.clover' })
  : null;
const STRIPE_UPGRADE_STATUSES = new Set(['active', 'trialing']);
const STRIPE_DOWNGRADE_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

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

function getStripeSubscriptionCustomerId(subscriptionObject) {
  const customer = subscriptionObject?.customer;
  if (typeof customer === 'string') return customer;
  if (customer && typeof customer === 'object' && typeof customer.id === 'string') return customer.id;
  return null;
}

async function resolveStripeUserIdFromEventObject(object) {
  const metadata = object?.metadata || {};
  const metadataUserId = metadata.user_id || metadata.supabase_user_id || null;
  if (metadataUserId) return metadataUserId;

  const customerId = getStripeSubscriptionCustomerId(object);
  if (!customerId) return null;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (error) throw new Error(`Failed to resolve Stripe customer mapping: ${error.message}`);
  return data?.id || null;
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

const router = express.Router();

router.post('/api/stripe/create-checkout-session', requireAuth, async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe is not configured on the backend' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Database admin client unavailable' });
    }
    if (!config.stripe.tmmPlusPriceId) {
      return res.status(503).json({ error: 'STRIPE_PRICE_ID_TMM_PLUS is not configured' });
    }

    const origin = getFallbackAppOrigin(req);
    const body = req.body || {};
    const successUrl = resolveAbsoluteUrl(body.success_url, `${origin}?stripe=success`);
    const cancelUrl = resolveAbsoluteUrl(body.cancel_url, `${origin}?stripe=cancel`);
    const customerId = await getOrCreateStripeCustomerIdForUser(req.userId, req.user?.email || null);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: config.stripe.tmmPlusPriceId, quantity: 1 }],
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

// Stripe webhook endpoint (server-only, no user JWT). Requires raw body for signature verification.
router.post('/api/webhooks/stripe', async (req, res, next) => {
  try {
    if (!stripe || !config.stripe.webhookSecret) {
      return res.status(503).json({ error: 'Stripe webhook is not configured' });
    }
    if (!supabaseAdmin) {
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

    const eventType = event.type || null;
    const object = event.data?.object || {};
    const candidateUserId = await resolveStripeUserIdFromEventObject(object);
    const status = String(object.status || '').toLowerCase();
    const isSubscriptionUpdate = eventType === 'customer.subscription.updated';
    const shouldUpgrade = candidateUserId && (
      eventType === 'customer.subscription.created' ||
      (isSubscriptionUpdate && STRIPE_UPGRADE_STATUSES.has(status))
    );
    const shouldDowngrade = candidateUserId && (
      eventType === 'customer.subscription.deleted' ||
      (isSubscriptionUpdate && STRIPE_DOWNGRADE_STATUSES.has(status))
    );

    if (shouldUpgrade) {
      const { error: upgradeError } = await supabaseAdmin
        .from('profiles')
        .update({ plan_tier: 'tmm_plus' })
        .eq('id', candidateUserId);
      if (upgradeError) {
        throw new Error(`Stripe upgrade profile update failed: ${upgradeError.message}`);
      }
    }

    if (shouldDowngrade) {
      try {
        await createArchiveSnapshotForUser(candidateUserId, {
          pointSource: 'plaid_archived',
          metadata: { trigger: 'stripe_downgrade', event_type: eventType }
        });
      } catch (archiveErr) {
        console.error(`Stripe downgrade archive hook failed for ${candidateUserId}:`, archiveErr.message);
      }

      const { error: downgradeError } = await supabaseAdmin
        .from('profiles')
        .update({ plan_tier: 'free' })
        .eq('id', candidateUserId);
      if (downgradeError) {
        throw new Error(`Stripe downgrade profile update failed: ${downgradeError.message}`);
      }
    }

    console.log(JSON.stringify({
      type: 'webhook_stripe',
      requestId,
      path: req.path,
      eventType,
      candidateUserId,
      status,
      timestamp: new Date().toISOString()
    }));
    return res.status(200).json({ received: true });
  } catch (err) {
    return next(err);
  }
});

export default router;
