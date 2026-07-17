// Entitlement resolution (ADR-3 / D7 / D8 / D10 / D11, PAY-1/2).
//
// The ONE table-driven function that turns Stripe subscription state into a
// tier and limits:
//
//   (subscription_status, price -> plan_catalog, grace_expires_at)
//     -> tier -> tier_entitlements -> { maxAlternatives, maxHorizonYears,
//                                       plaidEnabled, maxPlaidItems, extras }
//
// Prices, tiers, and limits are ROWS, never inline conditionals. Unknown
// statuses and unknown prices fail closed to Free with a structured alert log
// (the founder-alert channel at MVP is stderr -> host log alerting).

export const FREE_TIER = 'free';
export const PAID_TIERS = new Set(['tmm_plus', 'tmm_pro']);

/** Anti-abuse ceiling (D8): a mis-seeded entitlement row can never exceed this. */
export const PLAID_ITEM_ABSOLUTE_CEILING = 10;

/** Grace window for past_due (D11). */
export const GRACE_PERIOD_DAYS = 7;

// Fallback limits if the tier_entitlements row is missing (fail closed = Free
// limits). Mirrors the seeded 'free' row; never grants Plaid.
const FAIL_CLOSED_ENTITLEMENTS = Object.freeze({
  maxAlternatives: 3,
  maxHorizonYears: 5,
  plaidEnabled: false,
  maxPlaidItems: 0,
  extras: {}
});

const ENTITLED_STATUSES = new Set(['active', 'trialing']);
const FREE_STATUSES = new Set(['incomplete', 'incomplete_expired', 'canceled', 'unpaid', 'paused']);

function alert(logger, payload) {
  (logger?.error || console.error)(
    JSON.stringify({ type: 'entitlement_alert', timestamp: new Date().toISOString(), ...payload })
  );
}

/**
 * Pure status -> tier resolution (the normative matrix from D7/D10/D11).
 *
 * @param {object} params
 * @param {string|null} params.status            Stripe subscription status.
 * @param {string|null} params.catalogTier       Tier from plan_catalog for the
 *                                               subscription's price, or null
 *                                               when the price is unknown (PAY-2).
 * @param {string|Date|null} params.graceExpiresAt
 * @param {Date} [params.now]
 * @param {object} [params.logger]
 * @returns {{ tier: string, reason: string }}
 */
export function resolveTierFromSubscription({ status, catalogTier, graceExpiresAt, now = new Date(), logger = console }) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const tierFromCatalog = catalogTier && PAID_TIERS.has(catalogTier) ? catalogTier : null;

  if (!normalizedStatus) {
    return { tier: FREE_TIER, reason: 'no_subscription' };
  }
  if (!tierFromCatalog) {
    // PAY-2: subscriptions whose price is not in plan_catalog are logged and ignored.
    alert(logger, { alert: 'unknown_price', status: normalizedStatus, catalogTier: catalogTier ?? null });
    return { tier: FREE_TIER, reason: 'unknown_price' };
  }
  if (ENTITLED_STATUSES.has(normalizedStatus)) {
    return { tier: tierFromCatalog, reason: normalizedStatus };
  }
  if (normalizedStatus === 'past_due') {
    const grace = graceExpiresAt ? new Date(graceExpiresAt) : null;
    if (grace && Number.isFinite(grace.getTime()) && grace.getTime() > now.getTime()) {
      return { tier: tierFromCatalog, reason: 'past_due_grace' };
    }
    return { tier: FREE_TIER, reason: 'grace_expired' };
  }
  if (FREE_STATUSES.has(normalizedStatus)) {
    return { tier: FREE_TIER, reason: normalizedStatus };
  }
  // Unknown/new Stripe status: fail closed + alert (D7 matrix, last row).
  alert(logger, { alert: 'unknown_subscription_status', status: normalizedStatus });
  return { tier: FREE_TIER, reason: 'unknown_status' };
}

function mapEntitlementRow(row) {
  return {
    maxAlternatives: row.max_alternatives ?? null,
    maxHorizonYears: row.max_horizon_years ?? null,
    plaidEnabled: !!row.plaid_enabled,
    maxPlaidItems: Math.min(Number(row.max_plaid_items) || 0, PLAID_ITEM_ABSOLUTE_CEILING),
    extras: row.extras && typeof row.extras === 'object' ? row.extras : {}
  };
}

/**
 * Factory: full per-user entitlement resolver against Supabase (injected for
 * unit testing, same pattern as planHandlers).
 *
 * Resolution priority:
 *   1. Subscription on record -> the status matrix above (catalog tier from
 *      profiles.stripe_price_id via plan_catalog).
 *   2. No subscription on record -> stored profiles.plan_tier (founder comps /
 *      manually granted tiers; dev founder account).
 *
 * Note (2) means the resolver also catches grace expiry BETWEEN sweep runs:
 * a past_due profile whose grace_expires_at has passed resolves Free even if
 * the sweep hasn't downgraded plan_tier yet.
 */
export function createEntitlementResolver({ supabaseAdmin, logger = console, now = () => new Date() }) {
  async function resolveEntitlements(userId) {
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('plan_tier, subscription_status, stripe_price_id, stripe_subscription_id, current_period_end, grace_expires_at, is_admin')
      .eq('id', userId)
      .maybeSingle();
    if (profileError) {
      throw new Error(`Failed to load profile for entitlements: ${profileError.message}`);
    }

    let tier = FREE_TIER;
    let reason = 'no_profile';
    if (profile) {
      if (profile.subscription_status) {
        let catalogTier = null;
        if (profile.stripe_price_id) {
          const { data: catalogRow, error: catalogError } = await supabaseAdmin
            .from('plan_catalog')
            .select('tier, active')
            .eq('stripe_price_id', profile.stripe_price_id)
            .maybeSingle();
          if (catalogError) {
            throw new Error(`Failed to load plan_catalog: ${catalogError.message}`);
          }
          if (catalogRow?.active) catalogTier = catalogRow.tier;
        }
        const resolved = resolveTierFromSubscription({
          status: profile.subscription_status,
          catalogTier,
          graceExpiresAt: profile.grace_expires_at,
          now: now(),
          logger
        });
        tier = resolved.tier;
        reason = resolved.reason;
      } else {
        // Manually granted tier (no Stripe subscription on record).
        tier = PAID_TIERS.has(profile.plan_tier) ? profile.plan_tier : FREE_TIER;
        reason = tier === FREE_TIER ? 'no_subscription' : 'manual_grant';
      }
    }

    const { data: entRow, error: entError } = await supabaseAdmin
      .from('tier_entitlements')
      .select('tier, max_alternatives, max_horizon_years, plaid_enabled, max_plaid_items, extras')
      .eq('tier', tier)
      .maybeSingle();
    if (entError) {
      throw new Error(`Failed to load tier_entitlements: ${entError.message}`);
    }

    let entitlements;
    if (entRow) {
      entitlements = mapEntitlementRow(entRow);
    } else {
      alert(logger, { alert: 'missing_tier_entitlements_row', tier, userId });
      entitlements = { ...FAIL_CLOSED_ENTITLEMENTS };
    }

    return {
      tier,
      reason,
      isAdmin: !!profile?.is_admin,
      entitlements,
      subscription: profile
        ? {
            status: profile.subscription_status || null,
            currentPeriodEnd: profile.current_period_end || null,
            graceExpiresAt: profile.grace_expires_at || null,
            hasSubscription: !!profile.stripe_subscription_id
          }
        : { status: null, currentPeriodEnd: null, graceExpiresAt: null, hasSubscription: false }
    };
  }

  return resolveEntitlements;
}
