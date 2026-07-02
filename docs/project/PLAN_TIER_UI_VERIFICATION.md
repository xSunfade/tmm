# Plan Tier UI and Account Modal — Verification Checklist

Use this checklist to verify the Plan Tier UI, Account modal, and tier-refetch behaviour. The feature is mostly state wiring; this guards against jank and half-working behaviour.

## New signup and tier display

- [ ] **New signup** creates a `profiles` row (via existing bootstrap trigger) and shows **Free** immediately in the sidebar and modal, with **no flicker** (no brief "Plan: …" then "Free" for new users; loading state only when tier is genuinely not yet fetched).

## Manual tier flip in DB to `tmm_plus`

After flipping `profiles.plan_tier` to `tmm_plus` for a user (e.g. in Supabase SQL), **refetch** (e.g. open Account modal or reload with `?upgrade=success`):

- [ ] **Sidebar badge** updates to **TMM+** after refetch.
- [ ] **Account modal** content updates to **TMM+** after refetch.
- [ ] **Plaid UI** (frontend) is unblocked — e.g. Account Integration / Connect flow is available.
- [ ] **Plaid endpoints** (backend) return 200 for that user (no 403).

## Loading and robustness

- [ ] **No duplicate triggers:** only one place (AuthProvider) writes `planTier` to app state from `profiles.plan_tier`; no competing fetches.
- [ ] **No broken UI** when `planTier` is temporarily `null`: sidebar and modal show a loading-safe label ("Plan: …" or skeleton), never a wrong tier or crash.

## Security

- [ ] **No frontend-accessible route** accepts `plan_tier`; no Supabase service role in frontend; any admin path requires a server-only secret.

## Quick refs

- Sidebar plan label: 3-state (Plan: … / Free / TMM+) in `AppLayout.tsx`.
- Account modal: ACCOUNT button → modal with refetch on open; Escape and backdrop close; focus trap.
- Refetch: `refreshPlanTier()` from `useAuth()`, called on modal open and on `?upgrade=success` or `?stripe=success`.
- Webhook: `POST /api/webhooks/stripe` stub (rejects Bearer auth; logs; signature check placeholder).
