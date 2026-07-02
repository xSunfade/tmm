# How to Run the TMM Validation Suite

This guide explains how to run the validation tests, when to run them, and what you need set up.

---

## Quick start (one command)

From the **repo root**:

```bash
npm run test:validation
```

- **No database or Plaid keys required.** All suites run deterministically with mocks.
- **Runs in under a minute.** You’ll see pass/fail per suite and a list of generated reports.
- **Stress/DB suite is skipped by default** unless you opt in (see [Optional: stress & DB](#optional-stress--db)).

---

## When to run what

| Situation | What to run | Why |
|-----------|-------------|-----|
| **Daily local check** | `npm run test:validation` | Fast, full deterministic coverage (Plaid chaos, ledger, drift, time, guards). |
| **Before a PR** | `npm run test:validation` | Same as above; CI will run this too. |
| **After changing Plaid/sync logic** | `npm run test:integration` | Runs injectable workflow + workflow-boundary chaos only. |
| **After changing simulation/ledger math** | `npm run test:unit` (frontend) or full `npm run test:validation` | Unit runs frontend sim tests; full validation includes ledger invariants and property-based tests. |
| **UI / dashboard parity** | `npm run test:e2e` (see [Playwright (E2E)](#playwright-e2e-ui-parity)) | Needs app running; verifies displayed values and test IDs. |
| **CI (GitHub Actions)** | Automatic on PR via `validation-harness` workflow | Runs validation with `VALIDATION_MODE=true`; can run Playwright if configured. |

---

## Prerequisites

- **Node.js** (v18+).
- **Dependencies installed** at root and in `frontend` / `backend`:
  - From root: `npm install`, and `npm install` in `frontend` and `backend` (or use your usual setup).
- **Playwright browsers** (only if you run E2E / UI parity):
  - From repo root: `npx playwright install`  
  - Or with system deps: `npx playwright install --with-deps`

---

## Commands reference (all from repo root)

| Command | What it runs |
|---------|------------------|
| `npm run test:validation` | Full validation harness: Plaid chaos, ledger invariants, property-based sim, drift, time boundaries, production guard. Stress suite skipped unless opted in. |
| `npm run test:validation:ci` | Same as `test:validation`; CI sets env (e.g. `VALIDATION_MODE`, `RUN_PLAYWRIGHT_PARITY`). |
| `npm run test:validation:stripe` | Stripe validation scenario only (baseline contract checks + optional live checkout/portal/webhook checks). |
| `npm run test:plaid:live` | Opt-in live Plaid webhook/sync validation against your running stack (production-focused, sandbox-compatible). |
| `npm run test:unit` | Backend unit tests + frontend simulation tests. |
| `npm run test:integration` | Plaid injectable workflow + workflow-boundary chaos tests. |
| `npm run test:e2e` | Playwright E2E (UI parity). **Requires app running** (or set `PLAYWRIGHT_BASE_URL`). |

---

## Optional: Plaid live webhook/sync validation

Use this only when you want to validate real webhook delivery + sync execution with your current tunnel URL and running backend.

- Command: `npm run test:plaid:live`
- Full instructions and troubleshooting: [PLAID_LIVE_VALIDATION.md](./PLAID_LIVE_VALIDATION.md)

---

## Playwright (E2E / UI parity)

The UI parity test hits the real app to check dashboard values and tooltips. Tests run in an **authenticated** context using a saved storage state (no manual login).

### One-time: auth setup (test user + env)

1. **Create a test user in Supabase** with **Email** provider and a **password**:
   - In [Supabase Dashboard](https://supabase.com/dashboard) → your project → Authentication → Users, either create a user with email/password or ensure “Email” is enabled and add a user with a password (e.g. “Test user for Playwright”).
2. **Set these env vars** (in repo-root `.env` or `frontend/.env`; do not commit real passwords):
   - `PLAYWRIGHT_TEST_USER` – email of the test user (e.g. `playwright@example.com`)
   - `PLAYWRIGHT_TEST_PASSWORD` – that user’s password  
   The frontend already uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; the auth setup reads those too.
3. **If sign-in fails with “captcha verification process failed”**: your Supabase project has CAPTCHA enabled. Either set `SUPABASE_SERVICE_ROLE_KEY` (from Dashboard → Settings → API → `service_role`; auth setup uses it only to perform sign-in, which bypasses CAPTCHA—do not commit), or turn off CAPTCHA in Dashboard → Authentication → Bot and Abuse Protection.
4. **First time you run Playwright**, the global setup will sign in as that user and save auth state to `tests/validation/.auth/user.json` (gitignored). Every later test run reuses that state so the app sees you as logged in.

### Running the E2E / UI parity tests

1. **Start the app** (frontend dev server, e.g. on `http://localhost:5173`; and backend if the test hits API).
2. **Install Playwright browsers once** (from root):
   ```bash
   npx playwright install
   ```
3. **Run E2E:**
   ```bash
   npm run test:e2e
   ```
4. **Or run it as part of validation** (with app still running):
   - **Windows (PowerShell):** `$env:RUN_PLAYWRIGHT_PARITY="true"; npm run test:validation`
   - **Linux/macOS:** `RUN_PLAYWRIGHT_PARITY=true npm run test:validation`

If the saved session expires, the next run will get a sign-in error; fix the test user or re-run so the setup can refresh the auth file.

If the app runs on a different URL, set it before running:

- **Windows (cmd):** `set PLAYWRIGHT_BASE_URL=http://localhost:3000`
- **Windows (PowerShell):** `$env:PLAYWRIGHT_BASE_URL="http://localhost:3000"`
- **Linux/macOS:** `export PLAYWRIGHT_BASE_URL=http://localhost:3000`

`PLAYWRIGHT_BASE_URL` is **not** in any `.env` by default; it’s optional and defaults to `http://localhost:5173`.

---

## Optional: stress & DB

The stress test (and any DB-dependent scenarios) are **skipped by default** so normal runs stay fast and don’t require a database.

To include them:

```bash
RUN_DB_VALIDATION=true npm run test:validation
```

Use this when you intentionally want to run stress or DB-backed validation (e.g. before a release or in a scheduled job).

---

## Optional: Stripe validation (sandbox + prod-safe)

Stripe validation is **opt-in** so normal validation runs stay fast and deterministic.

### What it covers

- **Baseline contract checks** (safe by default):
  - backend health check
  - unauthenticated access blocked for checkout/portal endpoints
  - invalid Stripe signature handling
- **Live checks** (only when enabled):
  - authenticated checkout session creation
  - authenticated portal session creation
  - signed webhook simulation for upgrade + downgrade
  - optional `profiles.plan_tier` verification via Supabase (if admin env vars are present)

### Run baseline Stripe checks only

- **PowerShell**
  ```powershell
  npm run test:validation:stripe
  ```

### Include Stripe in full harness run

- **PowerShell**
  ```powershell
  $env:RUN_STRIPE_VALIDATION="true"
  npm run test:validation
  ```

### Get STRIPE_TEST_USER_JWT by code

From repo root, run:

```bash
npm run test:stripe:get-jwt
```

The script signs in with a test user and prints the JWT and user id. It reads credentials from:

- `STRIPE_TEST_USER_EMAIL` + `STRIPE_TEST_USER_PASSWORD`, or
- `PLAYWRIGHT_TEST_USER` + `PLAYWRIGHT_TEST_PASSWORD`

and Supabase from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (e.g. in `frontend/.env`). If your project has CAPTCHA enabled, set `SUPABASE_SERVICE_ROLE_KEY` (same as Playwright auth setup). Copy the printed token into `STRIPE_TEST_USER_JWT` when running live Stripe validation.

### Run live Stripe checks (sandbox recommended)

Required env:
- `STRIPE_VALIDATE_LIVE=true`
- `STRIPE_TEST_USER_JWT=<jwt>` (e.g. from `npm run test:stripe:get-jwt`)
- `STRIPE_WEBHOOK_SECRET=whsec_...`
- `BACKEND_URL` (defaults to `http://localhost:3000`)

- **PowerShell**
  ```powershell
  $env:RUN_STRIPE_VALIDATION="true"
  $env:STRIPE_VALIDATE_LIVE="true"
  $env:STRIPE_ENV="sandbox"
  $env:STRIPE_TEST_USER_JWT="<jwt>"
  $env:STRIPE_WEBHOOK_SECRET="whsec_..."
  $env:BACKEND_URL="http://localhost:3000"
  npm run test:validation
  ```

### Run live Stripe checks in production

Production live checks are guarded. You must explicitly acknowledge:
- `I_ACK_PROD=true` (or `STRIPE_I_ACK_PROD=true`)

- **PowerShell**
  ```powershell
  $env:STRIPE_VALIDATE_LIVE="true"
  $env:STRIPE_ENV="production"
  $env:I_ACK_PROD="true"
  npm run test:validation:stripe
  ```

### Stripe artifact

Stripe runs generate:
- `tests/validation/STRIPE_VALIDATION_REPORT.md`

---

## Environment variables (when you need them)

You usually **don’t** need to set any of these for the default `npm run test:validation` run.

| Variable | Default | When to set |
|----------|---------|-------------|
| `PLAYWRIGHT_BASE_URL` | `http://localhost:5173` | When your app is served at a different URL for E2E. |
| `PLAYWRIGHT_TEST_USER` | (none) | **Required for E2E.** Email of the Supabase test user (email/password). |
| `PLAYWRIGHT_TEST_PASSWORD` | (none) | **Required for E2E.** Password for that test user. Set in `.env` (do not commit). |
| `SUPABASE_SERVICE_ROLE_KEY` | (none) | Optional. If CAPTCHA is enabled in Supabase, set this (Dashboard → API → service_role) so auth setup can sign in; do not commit. |
| `RUN_PLAYWRIGHT_PARITY` | `false` | Set to `true` to run Playwright as part of `test:validation`. |
| `RUN_DB_VALIDATION` | `false` | Set to `true` to include stress/DB suites. |
| `RUN_STRIPE_VALIDATION` | `false` | Set to `true` to include Stripe scenario in `test:validation`. |
| `STRIPE_VALIDATE_LIVE` | `false` | Set to `true` to run live Stripe checks (checkout, portal, signed webhooks). |
| `STRIPE_ENV` | `sandbox` | `sandbox` or `production` for Stripe validation safety gating. |
| `STRIPE_TEST_USER_JWT` | (none) | Required when `STRIPE_VALIDATE_LIVE=true`; JWT for the Stripe validation user. |
| `STRIPE_TEST_USER_ID` | (none) | Optional override for user UUID; otherwise derived from JWT `sub`. |
| `STRIPE_WEBHOOK_SECRET` | (none) | Required when `STRIPE_VALIDATE_LIVE=true`; used to sign test webhook payloads. |
| `STRIPE_TEST_ORIGIN` | `http://localhost:5173` | Optional request origin used by Stripe validation route calls. |
| `VALIDATION_MODE` | (unset) | Set to `true` in CI or when you want the backend to serve fixture data on real API routes. |
| `VALIDATION_SCENARIO` | `baseline` | Which scenario pack to use when `VALIDATION_MODE=true`. |
| `CHAOS_SEED` | e.g. `1337` | Fix seed for reproducible chaos runs. |
| `SIM_PROP_SEED` | e.g. `424242` | Fix seed for property-based simulation tests. |
| `PRODUCTION_GUARD` | `true` | Keeps production Plaid usage gated; set `I_ACK_PROD=true` only when you intend production. |
| `PLAID_ENV` | `sandbox` | `mock` / `sandbox` / `production`; production requires guard acknowledgment. |

---

## Where results and artifacts go

After a run you’ll see something like:

```
Validation artifacts:
- tests/validation/CHAOS_REPORT.md
- tests/validation/SIMULATION_PROPERTY_TESTS.md
- tests/validation/DRIFT_FORENSICS_REPORT.md
- tests/validation/TIME_BOUNDARY_TESTS.md
- tests/validation/STRIPE_VALIDATION_REPORT.md
- tests/validation/ROUNDING_POLICY.md
- tests/validation/UI_PARITY_REPORT.md
- tests/validation/STRESS_TEST_RESULTS.md
```

- **Reports (`.md`)** live in `tests/validation/` and describe what was tested and outcomes.
- **Structured artifacts (e.g. JSON)** are under `tests/validation/artifacts/` (e.g. `plaid_final_state_snapshot.json`, `ui_parity_expected.json`). CI can upload this folder for diffing.

---

## Troubleshooting

- **“Validation step failed: …”**  
  One of the scripts in the harness failed. Run that script alone with `npx tsx tests/validation/scenarios/…/….test.ts` to see the full error.

- **Playwright can’t connect**  
  Start the frontend (and backend if the test needs API). Set `PLAYWRIGHT_BASE_URL` if the app isn’t on `http://localhost:5173`.

- **“Playwright auth setup: sign-in failed” or “needs PLAYWRIGHT_TEST_USER”**  
  Create a test user in Supabase (Authentication → Users) with Email provider and a password. Set `PLAYWRIGHT_TEST_USER` and `PLAYWRIGHT_TEST_PASSWORD` in `.env` or `frontend/.env`. Ensure `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set (frontend already needs these).

- **“captcha verification process failed”**  
  Supabase CAPTCHA is enabled. Set `SUPABASE_SERVICE_ROLE_KEY` in `.env` or `backend/.env` (from Dashboard → Settings → API → service_role; do not commit), or disable CAPTCHA in Dashboard → Authentication → Bot and Abuse Protection.

- **Browsers not found**  
  From repo root: `npx playwright install` (or `npx playwright install --with-deps`).

- **Stress or DB suite fails**  
  Those are opt-in. Run with `RUN_DB_VALIDATION=true` only when you intend to run them and have the required DB/env.

- **Stripe validation was skipped**  
  Set `RUN_STRIPE_VALIDATION=true` for `npm run test:validation`, or run `npm run test:validation:stripe` directly.

- **Stripe live checks failed immediately**  
  Live checks require `STRIPE_VALIDATE_LIVE=true`, plus `STRIPE_TEST_USER_JWT` and `STRIPE_WEBHOOK_SECRET`. For production runs, also set `I_ACK_PROD=true`.

---

## Summary

- **Default:** From repo root, run **`npm run test:validation`**. No env or DB needed; fast and self-contained.
- **UI checks:** Install Playwright once, start the app, then **`npm run test:e2e`** or **`RUN_PLAYWRIGHT_PARITY=true npm run test:validation`**.
- **Heavy/stress runs:** **`RUN_DB_VALIDATION=true npm run test:validation`** when you need stress/DB coverage.

For a short overview and flag list, see [README.md](./README.md) in this directory.
