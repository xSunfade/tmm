# TMM Validation Harness

**→ [How to run the validation tests (step-by-step)](./HOW_TO_RUN_VALIDATION.md)** — when to run what, prerequisites, and options.

This directory is the canonical home for deterministic validation of:

- Plaid lifecycle and idempotent sync behavior
- Stripe upgrade/webhook contract behavior (opt-in live checks)
- CFA/node mapping integrity
- simulation math and precision rules
- drift/reconciliation accountability
- UX parity expectations

## Modes

- `mock` (default): deterministic, no live Plaid/Supabase calls
- `sandbox` (optional): explicit opt-in
- `production` (explicit opt-in + guardrails)

## Commands

From repo root:

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:validation`

## Core flags

- `CHAOS_MODE=true|false`
- `CHAOS_SEED=<int>`
- `CHAOS_ITERATIONS=<int>`
- `SIM_PROP_RUNS=<int>`
- `SIM_PROP_SEED=<int>`
- `PRODUCTION_GUARD=true|false`
- `PLAID_ENV=mock|sandbox|production`
- `I_ACK_PROD=true` (required for production mode)
- `VALIDATION_MODE=true|false` (backend serves deterministic scenario packs through real API routes)
- `VALIDATION_SCENARIO=<scenario_id>` (defaults to `baseline`)
- `RUN_DB_VALIDATION=true|false` (stress/DB suites are opt-in)
- `RUN_STRIPE_VALIDATION=true|false` (Stripe suite is opt-in)
- `STRIPE_VALIDATE_LIVE=true|false` (enables live checkout/portal/webhook checks)
- `STRIPE_ENV=sandbox|production`
- `STRIPE_TEST_USER_JWT=<jwt>`
- `STRIPE_TEST_USER_ID=<uuid>` (optional; derived from JWT `sub` when omitted)
- `PLAYWRIGHT_BASE_URL=<url>`

## Artifacts

Generated docs and fail-fast outputs:

- `tests/validation/CHAOS_REPORT.md`
- `tests/validation/SIMULATION_PROPERTY_TESTS.md`
- `tests/validation/DRIFT_FORENSICS_REPORT.md`
- `tests/validation/TIME_BOUNDARY_TESTS.md`
- `tests/validation/STRIPE_VALIDATION_REPORT.md`
- `tests/validation/ROUNDING_POLICY.md`
- `tests/validation/UI_PARITY_REPORT.md`
- `tests/validation/STRESS_TEST_RESULTS.md`
- `tests/validation/artifacts/*`
