---
name: tmm-stripe-entitlements
description: Use when changing Stripe webhooks, checkout/portal sessions, the entitlement resolver, tier limits, grace/dunning logic, waitlist/invites, or pricing catalog for TMM. Encodes the table-driven entitlement architecture (ADR-3), the status→tier matrix, and money-path safety rules.
---

# TMM Stripe & Entitlements

Billing bugs destroy trust faster than feature bugs. TMM+ is live at launch (invite-gated), so every rule here is launch-critical.

## Architecture (ADR-3 — do not deviate)

```
Stripe subscription (price_id, status)
  → plan_catalog (price_id → tier)          [data, not code]
  → tier_entitlements (tier → limits)       [data, not code]
  → resolveEntitlements(userId)             [ONE table-driven function]
  → middleware + plan-save validation       [server-side enforcement]
```

- Prices, tiers, and limits are **rows**, never inline conditionals. A PR hardcoding a price or limit in app code is wrong by construction.
- UI gating mirrors entitlements for UX; it is never the security boundary.

## The status→tier matrix (normative, from D7/D10/D11)

| Stripe status | Entitlement |
|---|---|
| `active`, `trialing` | Paid tier per catalog |
| `past_due` | Paid tier until `grace_expires_at` = entry + **7 days**; then Free |
| `incomplete` | Free (never entitled pre-payment) |
| `incomplete_expired`, `canceled`, `unpaid`, `paused` | Free |
| **unknown/new** | **Free + alert to founder (fail closed)** |

Additional rules: price must exist in `plan_catalog` or the subscription is logged-and-ignored (PAY-2). Persist `subscription_id`, `status`, `current_period_end`, `grace_expires_at` on the profile (PAY-3).

## Webhook rules

1. Signature verification first (`constructEvent` with raw body — already correctly scoped; keep it that way).
2. Idempotency: check/record `stripe_events` by event id before acting; replays no-op.
3. Handle: `customer.subscription.created/updated/deleted`, `checkout.session.completed`, `invoice.payment_failed`.
4. Don't trust webhook ordering; resolve from the subscription object's current state, not event sequence.
5. Grace expiry has a **scheduled sweep** — never rely solely on Stripe sending a follow-up event.

## Downgrade rules (D9/D12)

- Never delete or modify user data on downgrade. Over-limit content (extra alternatives, >5y horizon) becomes **read-only**, with an upgrade path.
- Plaid on downgrade follows `project-roadmap/05-plaid-lifecycle-policy.md`: suspend sync immediately, retain tokens 30 days, then revoke.

## Free-tier limits (D8)

3 alternatives, 5-year horizon. Enforced at `PUT /api/plan` (server counts contents) with a structured error the UI turns into an upgrade prompt.

## Testing requirements

- Unit: the resolver over the full status × price × grace matrix (every row explicit).
- Integration (staging, test mode): checkout → flip → gate opens → cancel → period-end downgrade → gate closes.
- **Stripe test clocks** for anything time-dependent (past_due → day-7 downgrade → restore).
- Any handler change updates the test-clock scenario in the same PR.

## Mode boundaries

- Workspace Stripe access is **test mode only**. Live-mode actions (catalog creation, webhook registration, real transactions) are founder-in-dashboard tasks — prepare an exact runsheet instead of attempting them.
- No checkout ships at a price that hasn't passed the pricing-floor analysis (`project-roadmap/04-billing-and-entitlements.md`). The $5/mo test price is confirmed below floor. Real Plaid rates: Transactions bills **$0.30 per connected _account_/month** (per-account, not per-item), Balance $0.10/call on-demand, Auth/Identity unused. Item caps: **TMM+ 3, Pro 6** (ceiling 10). Recomputed floor: TMM+ ~$8.50 typical / ~$12 worst; Pro ~$13.50 / ~$19 → **recommended TMM+ $12/mo · $120/yr, Pro $25/mo · $250/yr** (founder to confirm; re-verify vs first real Plaid invoice).
