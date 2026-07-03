# Billing and Entitlement Architecture

Implements ADR-3. Decisions: D7 (tiers/entitlements), D8 (free limits), D9 (cancellation), D10 (trials), D11 (grace), D12 (Plaid on downgrade), D13 (tax), D1/D2 (waitlist/invites).

## Tier structure at launch

| | Free | TMM+ | TMM+ Pro |
|---|---|---|---|
| Manual accounts & budgeting | Unlimited | Unlimited | Unlimited |
| Alternatives (scenarios) | **3** | Unlimited | Unlimited |
| Projection horizon | **5 years** | Unlimited | Unlimited |
| Plaid bank connections | — | ✔ (3-item cap) | ✔ (6-item cap; 10 = absolute safety ceiling) |
| Future advanced analysis | — | per catalog | per catalog |
| Billing | — | monthly + annual | monthly + annual |
| Recommended price (see §Pricing floor) | $0 | **$12/mo · $120/yr** | **$25/mo · $250/yr** |

Prices are grounded in the real Plaid contract rates analyzed in §Pricing floor and remain founder-confirmable. Exact Pro differentiation beyond the Plaid item limit is a product decision to finalize during Phase 4; the architecture doesn't care — it's rows in `tier_entitlements`.

## Entitlement architecture

```
Stripe (Products/Prices, subscriptions, webhooks)
        │  price_id, status, period_end
        ▼
plan_catalog (price_id → tier)  +  tier_entitlements (tier → limits)
        │
        ▼
resolveEntitlements(userId) → { tier, maxAlternatives, maxHorizonYears,
                                plaidEnabled, maxPlaidItems, ... }
        │
        ├── backend middleware (Plaid routes, plan-save validation)
        └── frontend gating (UI prompts; never trusted alone)
```

Principles:

1. **One resolution function, table-driven.** `(subscription_status, price_id, grace_expires_at) → tier`. Every Stripe status appears explicitly:

| Stripe status | Entitlement |
|---|---|
| `active`, `trialing` | Paid tier per `plan_catalog` (D10 keeps `trialing` entitled) |
| `past_due` | Paid tier until `grace_expires_at` (= entry + **7 days**, D11); then Free |
| `incomplete` | Free (never entitled before first payment) |
| `incomplete_expired`, `canceled`, `unpaid`, `paused` | Free |
| unknown/new status | Free + alert to founder (fail closed) |

2. **Price verification (PAY-2).** Only subscriptions whose price exists in `plan_catalog` grant a tier. Unknown prices are logged and ignored.
3. **Persisted state (PAY-3).** `stripe_subscription_id`, `subscription_status`, `current_period_end`, `grace_expires_at` on the profile; enables support debugging, renewal UI, and reconciliation.
4. **Idempotent webhooks (PAY-5/WH-S1).** `stripe_events` table records every event id + outcome; replays no-op. Handle `customer.subscription.*`, `checkout.session.completed` (PAY-4), `invoice.payment_failed` (dunning banner trigger).
5. **Enforcement points.**
   - Plaid routes: `requireEntitlement('plaidEnabled')` + item-count checks against `maxPlaidItems`.
   - Plan save (`PUT /api/plan`): server counts alternatives and horizon in the submitted plan; free-tier saves exceeding limits are rejected with a structured error the UI converts to an upgrade prompt. Existing over-limit content after a downgrade is **read-only, never deleted** (D9's data-preservation principle): the user can view but must trim or upgrade to save changes that add more.
   - UI: mirrors limits for good UX; never the security boundary.

## Grace period and dunning (D11)

```
payment fails → status past_due → grace_expires_at = now + 7 days
  ├─ user keeps paid entitlements
  ├─ in-app banner: "payment issue — update your card" (portal link)
  └─ day 7 sweep: still past_due/unpaid → downgrade to Free
        └─ Plaid lifecycle: suspend sync immediately (see 05-plaid-lifecycle-policy.md)
restore any time: subscription becomes active → entitlements return instantly
```

A scheduled sweep (same scheduler family as retention sweeps) enforces expiry; don't rely solely on Stripe's eventual `customer.subscription.updated`/`deleted` events. Test with Stripe test clocks (Phase 4.4).

## Cancellation and refunds (D9)

- Portal self-serve cancellation → `cancel_at_period_end`; access persists to period end; `customer.subscription.deleted` fires at period end → downgrade to Free.
- All user data retained on downgrade; premium features lock without deleting or modifying plans.
- Refunds: manual-only via founder (accidental purchase, duplicate charge, billing error). Policy text published (Phase 5.8).

## Pricing floor (must be completed in Phase 4 before setting live prices)

Rule from D7: every paid tier profitable under **worst-case legitimate usage**.

### Real Plaid contract rates (from the founder's Plaid dashboard, contract created 2026-01-07)

| Plaid product | Rate | Billing shape | Used by TMM? |
|---|---|---|---|
| **Transactions** | **$0.30 per connected account / month** | Recurring, flat per account (covers all syncs) | **Yes** — the primary flow; `linkTokenCreate` requests `['transactions']` (`server.js:2428`) |
| **Balance** | **$0.10 per call** | On-demand per call | **Yes, on-demand** — `POST /api/plaid/balance` → `accountsBalanceGet` (`server.js:3538`); not scheduled |
| **Auth** | $1.50 per initial call | One-time per item | **No** in production — only appears in the `/api/diag/plaid` diagnostic endpoint (`server.js:1381`), which SEC-2 removes |
| **Identity** | $1.50 per initial call | One-time per item | **No** — never called in the codebase |

**The load-bearing correction:** Transactions bills **per connected _account_**, not per _item_. A Plaid *item* is one bank login (capped at 3 for TMM+ / 6 for Pro per the decision below); each item commonly holds 2–5 *accounts* (checking, savings, credit). So worst-case cost scales with account count, and the item cap alone does **not** bound it — but a lower item cap is still the cheapest way to shrink the worst case. Good news: the $0.30/account/month is a flat fee that covers syncing — daily `/transactions/sync` adds no per-call charge, so sync frequency is free to tune.

### Item-cap decision (2026-07-03)

The Plaid item cap is set to **3 for TMM+ and 6 for TMM+ Pro** (down from the code's current `PLAID_ITEM_CAP=5`). The absolute anti-abuse safety ceiling stays **10**. Because Transactions bills per connected account, lowering the item cap is the cheapest lever to bound worst-case cost. This is an entitlement/config change (`tier_entitlements.max_plaid_items`), implemented in Phase 4.5; `PLAID_ITEM_CAP` moves from a global constant to per-tier entitlement rows.

### Floor computation

```
floor(tier) > (connected_accounts × $0.30)          # Transactions, recurring
            + (balance_calls × $0.10)               # Balance, on-demand/controllable
            + stripe_fee(price)                     # ≈ 2.9% + $0.30 monthly; once/yr for annual
            + infra_allocation                      # ≈ $1–2/user at MVP scale
            + margin                                # target ≥ 30%  → price > cost ÷ 0.70
```

**TMM+ (3-item cap):**

| Accounts (3 items) | Transactions | Balance (est.) | Stripe (~$12) | Infra | **Cost** | **Floor (÷0.70)** |
|---|---|---|---|---|---|---|
| 6 (light, ~2/item) | $1.80 | ~$1.00 | ~$0.70 | ~$1.50 | ~$5.00 | **~$7** |
| 9 (typical, ~3/item) | $2.70 | ~$1.00 | ~$0.70 | ~$1.50 | ~$5.90 | **~$8.50** |
| 15 (worst case in cap) | $4.50 | ~$1.50 | ~$0.70 | ~$1.50 | ~$8.20 | **~$12** |

**TMM+ Pro (6-item cap):**

| Accounts (6 items) | Transactions | Balance (est.) | Stripe (~$25) | Infra | **Cost** | **Floor (÷0.70)** |
|---|---|---|---|---|---|---|
| 18 (typical, ~3/item) | $5.40 | ~$1.50 | ~$0.90 | ~$1.50 | ~$9.30 | **~$13.50** |
| 30 (worst case in cap) | $9.00 | ~$2.00 | ~$0.90 | ~$1.50 | ~$13.40 | **~$19** |

**Red flag confirmed:** the only Stripe price today is **$5/month** (test mode) — below even the 3-item light-usage floor (~$7). It is a placeholder; do not launch on it.

### Recommended prices (2026-07-03; founder to confirm final)

| Tier | Item cap | Monthly | Annual | Typical margin | Worst-case margin |
|---|---|---|---|---|---|
| **TMM+** | 3 | **$12** | **$120** (2 mo free) | ~51% | ~32% |
| **TMM+ Pro** | 6 | **$25** | **$250** (2 mo free) | ~63% | ~46% |

- Both monthly prices clear the ≥30% margin rule even in the absolute worst case within the cap.
- **Annual caveat:** annual gives up some per-user cushion (Stripe's $0.30 fee hits once, but the per-account cost is unchanged), so a *worst-case-usage TMM+ user on annual* lands near ~22% margin — a small, rare population; accepted. If ≥30% must hold even there, price TMM+ annual at **$130** instead of $120.
- Pro = 6 items is a clean "connect more banks" differentiator (double TMM+) and keeps the highest-cost users comfortably profitable.

### Remaining unknowns (watch in the monthly cost review)

Two inputs are still estimates until real users connect: **average accounts per item** and **Balance-endpoint call frequency** (estimated conservatively here; if the app rarely calls `/api/plaid/balance`, the floor drops ~$1–2). Reconcile against real Plaid invoices at the first monthly cost review.

### Action items

1. ✅ Real Plaid rates obtained.
2. ✅ Item caps decided (TMM+ 3, Pro 6, ceiling 10) and prices recommended ($12/$120, $25/$250) — pending founder's final confirmation of the exact numbers.
3. Implement caps as per-tier entitlements in Phase 4.5 (`PLAID_ITEM_CAP` → `tier_entitlements.max_plaid_items`).
4. Rebuild the Stripe catalog (test mode first): `TMM+` and `TMM+ Pro` products × (monthly, annual) prices; populate `plan_catalog`.
5. Re-verify the floor against the first real Plaid invoice; adjust before opening the TMM+ waitlist broadly (Gate D).

## Catalog build-out (turnkey — Phase 4.6)

Concrete recipe to stand up the four prices and the entitlement tables. **Run in Stripe test mode first**; repeat in live mode at Gate D. The `$5/mo` test price is retired (archive it, don't delete — historical subscriptions may reference it).

### 1. Stripe products + prices (test mode)

Two products, four recurring prices. Amounts are in **cents**; `usd`. Store the returned `price_...` ids for the `plan_catalog` seed.

```bash
# --- TMM+ ---
stripe products create \
  --name="TMM+" \
  --description="Unlimited scenarios & horizon, Plaid (3 bank connections)"

stripe prices create \
  --product=prod_TMMPLUS \
  --currency=usd --unit-amount=1200 \
  --recurring.interval=month \
  --nickname="TMM+ Monthly" \
  --lookup-key="tmm_plus_monthly"

stripe prices create \
  --product=prod_TMMPLUS \
  --currency=usd --unit-amount=12000 \
  --recurring.interval=year \
  --nickname="TMM+ Annual" \
  --lookup-key="tmm_plus_annual"

# --- TMM+ Pro ---
stripe products create \
  --name="TMM+ Pro" \
  --description="Everything in TMM+, plus 6 bank connections and advanced analysis"

stripe prices create \
  --product=prod_TMMPRO \
  --currency=usd --unit-amount=2500 \
  --recurring.interval=month \
  --nickname="TMM+ Pro Monthly" \
  --lookup-key="tmm_pro_monthly"

stripe prices create \
  --product=prod_TMMPRO \
  --currency=usd --unit-amount=25000 \
  --recurring.interval=year \
  --nickname="TMM+ Pro Annual" \
  --lookup-key="tmm_pro_annual"
```

Notes:
- **`lookup-key`** lets the app resolve prices by stable name instead of hardcoding `price_...` ids across environments — the recommended pattern for test/live parity.
- Do **not** set `unit-amount` with a trailing decimal; Stripe expects the smallest currency unit (cents).
- Annual = 10× monthly (2 months free); confirmed above floor for typical usage.

### 2. `plan_catalog` seed

Maps each Stripe price to a tier + interval. Replace `price_...` with the ids returned above (or resolve via `lookup_key`).

```sql
insert into plan_catalog (stripe_price_id, tier, billing_interval, active) values
  ('price_tmm_plus_monthly',  'tmm_plus', 'month', true),
  ('price_tmm_plus_annual',   'tmm_plus', 'year',  true),
  ('price_tmm_pro_monthly',   'tmm_pro',  'month', true),
  ('price_tmm_pro_annual',    'tmm_pro',  'year',  true);
```

Retire the legacy test price (keep the row for historical resolution, mark inactive):

```sql
update plan_catalog set active = false where stripe_price_id = 'price_LEGACY_5_MONTH';
-- if the $5 price was never in plan_catalog, no action needed; just archive it in Stripe.
```

### 3. `tier_entitlements` seed

The single source of truth for limits (D7/D8). `null` = unlimited. This is what makes `PLAID_ITEM_CAP` obsolete as a constant.

```sql
insert into tier_entitlements
  (tier, max_alternatives, max_horizon_years, plaid_enabled, max_plaid_items, extras)
values
  ('free',     3,    5,    false, 0,  '{}'::jsonb),
  ('tmm_plus', null, null, true,  3,  '{"advanced_analysis": false}'::jsonb),
  ('tmm_pro',  null, null, true,  6,  '{"advanced_analysis": true}'::jsonb);
```

Absolute anti-abuse ceiling (10) is enforced in code as a hard `min(max_plaid_items, 10)` guard, independent of these rows, so a mis-seeded entitlement can never exceed it.

### 3b. `stripe_events` idempotency table

The idempotency + audit ledger (PAY-5 / WH-S1). Every webhook is recorded before its side effects; a replayed `event_id` short-circuits. 90-day retention (`06-security-privacy-and-retention.md`).

```sql
create table stripe_events (
  event_id      text primary key,            -- Stripe's evt_... id; the idempotency key
  type          text not null,               -- e.g. customer.subscription.updated
  outcome       text not null default 'received',  -- received | processed | ignored | error
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);
create index on stripe_events (received_at);   -- supports the retention sweep
```

### 3c. Webhook handler contract (reference skeleton)

Not shipping code — the contract Phase 4.3 implements. Order matters: **verify → deduplicate → route → update state → re-resolve tier → mark processed.** The endpoint must read the **raw request body** (signature verification fails on parsed/re-serialized JSON) and must be exempt from any CSRF/auth middleware.

```
POST /api/stripe/webhook
1. VERIFY   stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET)
            → on failure: 400, log, do NOT trust payload. (WH-S1)
2. DEDUPE   insert stripe_events(event_id, type, payload, outcome='received')
            → on unique-violation (replay): return 200 immediately, no side effects. (PAY-5)
3. ROUTE    switch(event.type):
              checkout.session.completed        → link customer↔user, set subscription_id       (PAY-4)
              customer.subscription.created/updated → upsert status, price_id, current_period_end
              customer.subscription.deleted     → status=canceled
              invoice.payment_failed            → status=past_due, grace_expires_at=now()+7d      (D11 dunning)
              invoice.paid / payment_succeeded  → clear grace_expires_at, refresh current_period_end
              (unhandled type)                  → outcome='ignored', return 200
4. PRICE    resolve price_id via plan_catalog; unknown/inactive price → log + treat as Free       (PAY-2)
5. STATE    persist to profiles: stripe_subscription_id, subscription_status,
            current_period_end, grace_expires_at                                                  (PAY-3)
6. TIER     tier = resolveEntitlements(status, price_id, grace_expires_at); write derived plan_tier
7. DONE     stripe_events.outcome='processed', processed_at=now(); return 200
   ERROR    any step 3–6 throws → outcome='error'; return 5xx so Stripe retries (idempotency-safe)
```

Guardrails:
- **Always 200 on success and on ignored/replayed events**; only return non-2xx when you genuinely want Stripe to retry. Returning 5xx on an unknown *event type* would cause pointless retry storms — ignore-and-200 instead.
- **Fail closed on tier.** Unknown/new subscription status → Free + founder alert (matches the resolver table above).
- Step 6 is the *only* place `plan_tier` is written — never set it from the client.
- Local testing: `stripe listen --forward-to localhost:PORT/api/stripe/webhook` and `stripe trigger <event>` cover every branch above.

### 4. Verification checklist before enabling checkout

- [ ] Four prices exist in Stripe test mode with the amounts above; legacy $5 price archived.
- [ ] `plan_catalog` has exactly the four active rows; the resolver returns the right tier for each `price_id`/`lookup_key`.
- [ ] `tier_entitlements` seeded; `resolveEntitlements` returns `maxPlaidItems` 3/6 and unlimited scenarios/horizon for paid tiers.
- [ ] A test checkout on each price yields the correct tier via the webhook path (PAY-4); an unknown price is logged and ignored (PAY-2).
- [ ] Webhook signature verification rejects a tampered/unsigned payload (WH-S1); a **replayed** `event_id` returns 200 with no duplicate side effects (PAY-5).
- [ ] `invoice.payment_failed` sets `past_due` + `grace_expires_at = now()+7d`; a later `invoice.paid` clears grace (D11) — verify with `stripe trigger`.
- [ ] Repeat 1–3 in **live mode** as part of Gate D; live `price_...` ids differ from test — use `lookup_key` to avoid code changes.

## Waitlist and invites (D1, D2)

- **TMM+ waitlist:** any user can join (email + user id). Founder issues invites (`invites` table: code, tier granted, expiry). Redemption unlocks the checkout flow for that user. Cohort releases at Gate D.
- **Free-overflow waitlist:** free signup stays open until a **soft cap** (configurable env/DB setting keyed to Supabase capacity). Crossing it flips signup to waitlist mode (feature flag checked by the signup flow). This is the cost-reactive rollout D1 requires.
- Supabase free tier has no hard auto-cutoff that gracefully degrades — the correct mechanism is our own soft cap + Supabase usage alerts (and the Pro plan's spend cap once upgraded). Set alerts at 70%/90% of DB size and MAU quotas.
- Waitlist notification = plain email from the founder account at MVP (D29 — no marketing automation).

## Stripe Tax (D13)

Deferred. Checkout without automatic tax at launch (U.S. customers). The entitlement layer never touches tax, so enabling Stripe Tax later is a Checkout-configuration change plus registration work with a CPA. Revisit when approaching state nexus / international thresholds.

## Test plan (money paths — Gate C blockers where TMM+ is live at launch, per D2)

1. Unit: resolution function over the full status × price × grace matrix.
2. Integration (staging): checkout (test card) → entitlement flip → Plaid gate opens → cancel → period-end downgrade → gate closes; test-clock run for past_due → day-7 downgrade → restore.
3. Live-mode dogfood: founder pays real money through one full billing cycle before Gate D opens TMM+ beyond invitees.
