// Stripe webhook processing (Phase 4.2/4.3/4.4 — PAY-3/4/5, WH-S1, D11).
//
// Contract (project-roadmap/04-billing-and-entitlements.md §3c), in order:
//   VERIFY (route does constructEvent) -> DEDUPE (stripe_events by event id)
//   -> ROUTE -> PRICE (plan_catalog, PAY-2) -> STATE (profiles, PAY-3)
//   -> TIER (resolveTierFromSubscription; the ONLY writer of plan_tier)
//   -> DONE (outcome recorded).
//
// Ordering rule: never trust event sequence — state is resolved from the
// subscription object's current contents. Deps injected for unit testing.

import { resolveTierFromSubscription, GRACE_PERIOD_DAYS, PAID_TIERS } from './entitlements.js';

function nowPlusGraceIso(now) {
  return new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function getStripeSubscriptionCustomerId(subscriptionObject) {
  const customer = subscriptionObject?.customer;
  if (typeof customer === 'string') return customer;
  if (customer && typeof customer === 'object' && typeof customer.id === 'string') return customer.id;
  return null;
}

function extractPrice(subscriptionObject) {
  const item = subscriptionObject?.items?.data?.[0] || null;
  const price = item?.price || subscriptionObject?.plan || null;
  if (!price) return { priceId: null, lookupKey: null };
  return {
    priceId: typeof price.id === 'string' ? price.id : null,
    lookupKey: typeof price.lookup_key === 'string' ? price.lookup_key : null
  };
}

function periodEndIso(subscriptionObject) {
  const raw = subscriptionObject?.current_period_end;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return new Date(raw * 1000).toISOString();
  }
  return null;
}

export function createStripeWebhookProcessor({
  supabaseAdmin,
  logger = console,
  archiveSnapshot = null, // async (userId, meta) — history archive on downgrade
  suspendPlaid = null, // async (userId, { reason }) — ADR-6 downgrade hook
  restorePlaid = null, // async (userId) — ADR-6 restore hook
  now = () => new Date()
}) {
  async function resolveUserId(object) {
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

  async function loadProfile(userId) {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, plan_tier, subscription_status, stripe_price_id, stripe_subscription_id, grace_expires_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load profile: ${error.message}`);
    return data || null;
  }

  async function catalogTierForPrice({ priceId, lookupKey }) {
    if (priceId) {
      const { data, error } = await supabaseAdmin
        .from('plan_catalog')
        .select('tier, active')
        .eq('stripe_price_id', priceId)
        .maybeSingle();
      if (error) throw new Error(`Failed to load plan_catalog: ${error.message}`);
      if (data?.active) return data.tier;
    }
    if (lookupKey) {
      const { data, error } = await supabaseAdmin
        .from('plan_catalog')
        .select('tier, active')
        .eq('lookup_key', lookupKey)
        .maybeSingle();
      if (error) throw new Error(`Failed to load plan_catalog: ${error.message}`);
      if (data?.active) return data.tier;
    }
    return null;
  }

  /**
   * Apply a tier transition: persist derived plan_tier and fire the paid<->free
   * side effects (archive + Plaid suspend on downgrade; Plaid restore on
   * upgrade). This is the ONLY code path that writes plan_tier.
   */
  async function applyTier(userId, previousTier, nextTier, { updates = {}, trigger }) {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ ...updates, plan_tier: nextTier })
      .eq('id', userId);
    if (error) throw new Error(`Failed to persist subscription state: ${error.message}`);

    const wasPaid = PAID_TIERS.has(previousTier);
    const isPaid = PAID_TIERS.has(nextTier);
    if (wasPaid && !isPaid) {
      if (archiveSnapshot) {
        try {
          await archiveSnapshot(userId, { pointSource: 'plaid_archived', metadata: { trigger } });
        } catch (err) {
          logger.error?.(`Stripe downgrade archive hook failed for ${userId}: ${err.message}`);
        }
      }
      if (suspendPlaid) {
        await suspendPlaid(userId, { reason: trigger });
      }
    } else if (!wasPaid && isPaid) {
      if (restorePlaid) {
        await restorePlaid(userId);
      }
    }
  }

  async function handleSubscriptionEvent(eventType, object) {
    const userId = await resolveUserId(object);
    if (!userId) return { outcome: 'ignored', detail: 'no_user_mapping' };
    const profile = await loadProfile(userId);
    if (!profile) return { outcome: 'ignored', detail: 'no_profile' };

    const status = eventType === 'customer.subscription.deleted'
      ? 'canceled'
      : String(object?.status || '').toLowerCase() || null;
    const { priceId, lookupKey } = extractPrice(object);
    const catalogTier = await catalogTierForPrice({ priceId, lookupKey });

    // Grace stamping (D11): entering past_due starts the 7-day clock exactly
    // once; leaving past_due (cured or terminal) clears it.
    let graceExpiresAt = profile.grace_expires_at || null;
    if (status === 'past_due') {
      if (profile.subscription_status !== 'past_due' || !graceExpiresAt) {
        graceExpiresAt = nowPlusGraceIso(now());
      }
    } else {
      graceExpiresAt = null;
    }

    const { tier } = resolveTierFromSubscription({
      status,
      catalogTier,
      graceExpiresAt,
      now: now(),
      logger
    });

    await applyTier(userId, profile.plan_tier, tier, {
      trigger: eventType,
      updates: {
        stripe_subscription_id: object?.id || profile.stripe_subscription_id || null,
        subscription_status: status,
        stripe_price_id: priceId,
        current_period_end: periodEndIso(object),
        grace_expires_at: graceExpiresAt
      }
    });
    return { outcome: 'processed', detail: `tier=${tier} status=${status}` };
  }

  async function handleCheckoutCompleted(object) {
    // PAY-4: bind customer + subscription to the user who paid. Entitlement
    // itself lands via the subscription events (state from the subscription
    // object, not event order).
    const userId = object?.client_reference_id || object?.metadata?.user_id || null;
    if (!userId) return { outcome: 'ignored', detail: 'no_client_reference' };
    const updates = {};
    const customerId = getStripeSubscriptionCustomerId(object);
    if (customerId) updates.stripe_customer_id = customerId;
    if (typeof object?.subscription === 'string') updates.stripe_subscription_id = object.subscription;
    if (Object.keys(updates).length === 0) return { outcome: 'ignored', detail: 'nothing_to_link' };
    const { error } = await supabaseAdmin.from('profiles').update(updates).eq('id', userId);
    if (error) throw new Error(`Failed to link checkout session: ${error.message}`);
    return { outcome: 'processed', detail: 'customer_linked' };
  }

  async function handleInvoicePaymentFailed(object) {
    // Dunning trigger (D11): past_due + grace clock. The user KEEPS the paid
    // tier during grace — no tier write needed unless grace already lapsed
    // (handled by the sweep / resolver).
    const userId = await resolveUserId(object);
    if (!userId) return { outcome: 'ignored', detail: 'no_user_mapping' };
    const profile = await loadProfile(userId);
    if (!profile) return { outcome: 'ignored', detail: 'no_profile' };
    if (!profile.stripe_subscription_id && !object?.subscription) {
      return { outcome: 'ignored', detail: 'no_subscription_on_record' };
    }
    const graceExpiresAt =
      profile.subscription_status === 'past_due' && profile.grace_expires_at
        ? profile.grace_expires_at
        : nowPlusGraceIso(now());
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ subscription_status: 'past_due', grace_expires_at: graceExpiresAt })
      .eq('id', userId);
    if (error) throw new Error(`Failed to record payment failure: ${error.message}`);
    return { outcome: 'processed', detail: `grace_until=${graceExpiresAt}` };
  }

  async function handleInvoicePaid(object) {
    // Payment cured: clear the grace clock. Status/tier corrections arrive via
    // customer.subscription.updated; we only clear dunning state here.
    const userId = await resolveUserId(object);
    if (!userId) return { outcome: 'ignored', detail: 'no_user_mapping' };
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ grace_expires_at: null })
      .eq('id', userId);
    if (error) throw new Error(`Failed to clear grace state: ${error.message}`);
    return { outcome: 'processed', detail: 'grace_cleared' };
  }

  /**
   * Process one verified Stripe event. Returns { outcome, detail }.
   * outcome: 'processed' | 'ignored' | 'replay' | 'error'
   */
  return async function processStripeEvent(event) {
    const eventId = event?.id || null;
    const eventType = event?.type || 'unknown';
    if (!eventId) return { outcome: 'ignored', detail: 'missing_event_id' };

    // DEDUPE (PAY-5): record before side effects; a replayed id no-ops.
    const { error: insertError } = await supabaseAdmin.from('stripe_events').insert({
      event_id: eventId,
      type: eventType,
      outcome: 'received',
      payload: { id: eventId, type: eventType } // never store raw payloads (never-log list)
    });
    if (insertError) {
      if (insertError.code === '23505' || /duplicate key/i.test(insertError.message || '')) {
        return { outcome: 'replay', detail: 'event_already_processed' };
      }
      throw new Error(`Failed to record stripe event: ${insertError.message}`);
    }

    let result;
    try {
      const object = event?.data?.object || {};
      switch (eventType) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          result = await handleSubscriptionEvent(eventType, object);
          break;
        case 'checkout.session.completed':
          result = await handleCheckoutCompleted(object);
          break;
        case 'invoice.payment_failed':
          result = await handleInvoicePaymentFailed(object);
          break;
        case 'invoice.paid':
        case 'invoice.payment_succeeded':
          result = await handleInvoicePaid(object);
          break;
        default:
          result = { outcome: 'ignored', detail: 'unhandled_event_type' };
      }
    } catch (err) {
      await supabaseAdmin
        .from('stripe_events')
        .update({ outcome: 'error', error_message: String(err?.message || err).slice(0, 500), processed_at: new Date().toISOString() })
        .eq('event_id', eventId);
      throw err; // route returns 5xx so Stripe retries (idempotency-safe)
    }

    await supabaseAdmin
      .from('stripe_events')
      .update({
        outcome: result.outcome === 'processed' ? 'processed' : 'ignored',
        processed_at: new Date().toISOString()
      })
      .eq('event_id', eventId);
    return result;
  };
}
