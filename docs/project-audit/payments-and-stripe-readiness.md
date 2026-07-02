# Payments and Stripe Readiness

TMM already has a working skeleton of subscription billing: a single paid tier (`tmm_plus`) that gates Plaid features. This doc assesses what exists and what must be added before charging real users.

## What exists (confirmed from code)

| Piece | State | Where |
|---|---|---|
| Stripe SDK + API version pin | Yes (`stripe@^20.3.1`, `2026-01-28.clover`) | `backend/server.js` ~110 |
| Checkout Session (subscription mode) | Yes — `POST /api/stripe/create-checkout-session`, JWT-authed, price from `STRIPE_PRICE_ID_TMM_PLUS` | `server.js` |
| Customer records | Lazy `getOrCreateStripeCustomerIdForUser` → `profiles.stripe_customer_id` (migration 016) | `server.js` ~1618 |
| Billing Portal | Yes — `POST /api/stripe/create-portal-session` | `server.js` |
| Webhook + signature verification | Yes (`constructEvent`) | `server.js` ~1741 |
| Entitlement flip | `customer.subscription.created/updated` active/trialing → `plan_tier='tmm_plus'`; `deleted`/`canceled`/`unpaid`/`incomplete_expired` → `'free'` + archive snapshot | `server.js` |
| Enforcement | `requireTmmPlus` middleware on all Plaid + ops routes; frontend `PlanProvider`/`AuthProvider` read tier for UI gating | `backend/middleware/auth.js` |
| Test tooling | `tests/validation/scenarios/stripe/stripe-upgrade-validation.test.ts` + JWT helper script; a committed local sandbox validation report | `tests/validation/` |
| Graceful degradation | All Stripe routes 503 cleanly when env unset | `server.js` |

This is a sound foundation. The gaps are in the unhappy paths.

## Gaps before charging real users

### PAY-1: Handle failed/incomplete payment states — High

No handling for `past_due`, `incomplete`, or `invoice.payment_failed`. Today a subscription that enters `past_due` keeps `tmm_plus` indefinitely (until Stripe finally cancels), and the user gets no dunning communication beyond Stripe's own emails.

- **Priority:** High · **Effort:** 1–2 days
- **Files:** `backend/server.js` (webhook), possibly a `billing_state` column on `profiles`
- **Decision needed (open-questions):** grace-period policy — recommend: keep entitlement during `past_due` for N days, show a "payment issue" banner, downgrade on `unpaid`.
- **Acceptance criteria:** each subscription status maps to an explicit entitlement decision in one table-driven function; unit-tested for every Stripe status.

### PAY-2: Verify the subscription price in the webhook — High

The tier flips for *any* active subscription on the customer. If a second product/price is ever added, or a manipulated subscription appears, entitlement is wrong.

- **Effort:** ~2 hours. **Acceptance:** only subscriptions containing `STRIPE_PRICE_ID_TMM_PLUS` flip the tier; others are logged and ignored.

### PAY-3: Persist `stripe_subscription_id` (and status) on the profile — Medium

Only the customer id is stored. Storing subscription id + status + current_period_end enables support debugging, entitlement reconciliation, and a "your plan renews on X" UI.

- **Effort:** 0.5 day incl. migration. **Acceptance:** profile reflects live subscription state after each webhook; a reconcile script can compare Stripe ↔ DB.

### PAY-4: Handle `checkout.session.completed` — Medium

Currently entitlement waits for `customer.subscription.created`. Usually near-simultaneous, but handling the session event too (and redirect success page polling `plan_tier`) tightens the upgrade UX and covers metadata propagation explicitly. **Effort:** 0.5 day.

### PAY-5: Webhook event log + idempotency (shared with WH-S1/S4) — Medium

Record processed Stripe `event.id`s and outcomes. **Effort:** 0.5 day.

### PAY-6: Cancellation / refund policy — Medium (product + light code)

Portal handles self-serve cancellation (good). Define: immediate vs end-of-period downgrade (code currently downgrades on `deleted`, which fires at period end for standard cancellations — verify), refund policy text, and what happens to Plaid connections on downgrade (today: archive snapshot + tier flip; Plaid items remain and keep accruing Plaid costs — **decide whether to disconnect items on downgrade**, see cost-control doc).

### PAY-7: Entitlement reconciliation job — Low (post-MVP)

A daily sweep comparing active Stripe subscriptions to `plan_tier` catches missed webhooks. Cheap insurance once there are >100 subscribers.

## Test-mode rollout plan (recommended)

1. Fix PAY-1/2/3 in test mode; extend the existing validation scenario to cover `past_due` → grace → `unpaid` → downgrade using Stripe test clocks.
2. Register the production webhook endpoint only after deployment topology exists (see release checklist); confirm signing secret per environment.
3. Run a full loop in test mode: signup → checkout (test card) → tier flip → Plaid gate opens → cancel via portal → downgrade → Plaid gate closes.
4. Then flip to live keys with a founder-only price, dogfood one real billing cycle, and only then open signup.

## Explicitly fine to defer

- Multiple tiers/prices, metered billing, coupons, tax (enable Stripe Tax when jurisdictionally required — decision in open-questions), invoicing customization, proration logic beyond Stripe defaults.
