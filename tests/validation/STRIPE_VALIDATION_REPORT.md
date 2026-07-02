# Stripe Validation Report

## Run configuration

- BACKEND_URL: `http://localhost:3000`
- STRIPE_ENV: `sandbox`
- STRIPE_VALIDATE_LIVE: `true`

## Baseline contract checks

- Health check: `200`
- Unauthenticated checkout blocked: `401`
- Unauthenticated portal blocked: `401`
- Invalid webhook signature response: `400`

## Live Stripe flow checks

- Test user id: `38360f16-5de3-4c39-8cdf-12ccf08b188f`
- Checkout session created: `200`
- Portal session created: `200`
- Signed upgrade webhook accepted: `200`
- Signed downgrade webhook accepted: `200`
- Supabase verification skipped (SUPABASE_URL / SUPABASE_SECRET_KEY not both present).

## Result

- Stripe validation completed successfully.
