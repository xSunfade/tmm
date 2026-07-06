# Current State Map

What the repository actually contains as of July 2026. Everything below is **confirmed from code** unless labeled otherwise.

## Repo layout

```
tmm/
├── frontend/            # Vite + React 19 + TypeScript (strict) + Tailwind 4 SPA
├── backend/             # Express 4 monolith (server.js ~4,300 lines) + Supabase migrations
├── tests/               # Validation harness, e2e scripts, security tests, fixtures
├── docs/                # project/, backend/, security/, tests/ documentation
├── scripts/             # audit shell scripts (bash)
├── assets/              # branding images
├── .github/workflows/   # codeql, security-audit, validation-harness
├── vercel.json          # STALE — references files that do not exist
├── package.json         # "tmm-validation-root" — test orchestration only
└── baseline-history.sql # manual seed script
```

Git history: **a single commit** ("Initial commit!"). There is uncommitted work in progress: Google Sheets retry/backoff on the backend, a new `valuesBatchUpdate` endpoint, a 45s frontend Sheets timeout, and an untracked `tests/unit/sheets-diff.test.ts` already referenced by `package.json`.

## The three tiers

### Frontend (`frontend/`)

- **Stack:** React 19.2, Vite 7, TypeScript 5.9 strict, Tailwind CSS 4, `@supabase/supabase-js`, `react-plaid-link`, `xlsx`. Hand-rolled routing (`src/app/routing.ts`, `pushState` + custom `tmm:navigate` events) — no react-router.
- **State:** two React reducer stores — `src/state/appState.tsx` (auth, onboarding, overlays, sync status) and `src/lib/plan/planStore.tsx` (the financial plan).
- **Plan model** (`src/lib/plan/types.ts`): `PlanState` with named alternatives (each holding income/expense/asset/debt rows keyed by UUID), assumptions, pipeline edges + layout, goals, augments (scenario overlays), checkpoints, forecast seed/fingerprint, `schemaVersion: '2.0'`.
- **Persistence:** user-scoped localStorage (`mm-plan::{userId}` via `src/lib/storage/userScopedStorage.ts`). **The plan body is not stored in Supabase.** Optional manual Google Sheets sync (UUID-based diff in `src/lib/sheets/sync.ts`, ~1,200 lines) with an offline retry queue. XLSX import/export via `src/lib/plan/xlsx.ts`.
- **Auth:** Supabase (Google OAuth + email OTP, optional Turnstile CAPTCHA), TOTP MFA with a 30-day step-up gate before Plaid actions. `src/lib/api/authFetch.ts` attaches Bearer tokens with 401-retry.

### Backend (`backend/`)

- **Stack:** Express 4, ES modules, all ~55 routes in one `server.js` file (~4,300 lines with uncommitted changes). Zod validation on some routes. Models in `backend/models/*` over Supabase via a service-role client (bypasses RLS).
- **Route groups:** health/diag (unauthenticated), Stripe (checkout, portal, webhook), Plaid (~20 routes, gated to `tmm_plus` tier), Google Sheets proxy (~10 routes), history/net-worth, privacy/consent/deletion, MFA factor removal.
- **Plaid engineering (substantial):** link-intent idempotency, AES-256-GCM encrypted access tokens (`tokenStore.js`), `/transactions/sync` cursor persistence, DB-backed job queue with dedupe keys, in-process polling worker, DB-backed circuit breaker, webhook event dedupe by content hash, atomic apply via a Postgres RPC.
- **Schedulers:** `setInterval`-based daily transaction sync and weekly history snapshots inside the web process.

### Database (Supabase Postgres, `backend/supabase/migrations/001–021`)

~20 tables: legacy `users`, `plaid_tokens` (encrypted), `accounts`, `transactions`, `profiles` (plan_tier, stripe_customer_id, sheets prefs), `user_onboarding`, `google_sheets_tokens` (encrypted), Plaid ops tables (webhook events, item status, sync runs/jobs, link intents, connection events, circuit breaker, usage counters), history tables (`account_balance_snapshots`, `net_worth_points`, `net_worth_points_alt`, reconciliation overrides), and privacy tables (consents, deletion requests). A signup trigger bootstraps `profiles` + `user_onboarding`. RLS policies exist per table but the backend always uses the service-role key.

## Simulation engine (the product core)

One engine (the legacy float engine `simulation.ts` was deleted in Phase 1.5; all tests run against the ledger):

- **Production:** `frontend/src/lib/simulation/ledger.ts` — daily stepping over the full horizon, integer `bigint` cents, ppm fixed-point rates, banker's rounding with residual carry (documented zero cumulative rounding loss), seeded Monte Carlo (mulberry32; 20 runs, refined to 80 on idle) for probabilistic augments, P10/P50/P90 output. Seeds state from the latest checkpoint (D3/BUG-5) via a deterministic `checkpoint_adjust:<alt>:<date>` adjustment; drift compares today's actuals to today's projection from that baseline (BUG-4). Runs in a per-request web worker with a main-thread fallback and a 16-entry result cache.

Known engine gaps (confirmed): Ticker-mode assets are collapsed to balance+APY (BUG-6, deferred to the D4 domain-model workstream).

## Feature maturity

| Feature | Maturity | Notes |
|---|---|---|
| Dashboard + net worth chart | Complete | Monte Carlo, historical overlay, reconciliation modal |
| Accounts (income/expense/asset/debt CRUD) | Complete | Alternatives managed here |
| Account Integration (Plaid) | Complete | 2,100-line screen; tmm_plus gated; MFA step-up |
| Pipeline builder | Complete | DAG rules; edges write back into entity fields |
| Simulation screen + augments | Complete | XLSX import/export, sample data |
| Settings | Complete | MFA, Sheets, Stripe billing, delete account |
| Goals | Partial | CRUD works; heavy `any` typing |
| Onboarding / Tour / Weekly check-in | Partial | Working but with empty index modules |
| Alternatives panel | Dead code | Never imported |
| Legacy iframe bridge / adapters | Dead code | `restoreBridge`, `embeddedMode`, most `legacyAdapters`, `VITE_LEGACY_*` env vars unused |
| Import/export | Complete | XLSX + Google Sheets |
| Stripe billing (TMM+ tier) | Functional, gaps | See `payments-and-stripe-readiness.md` |

## Primary data flows

1. **Plan editing:** UI → `planStore` reducer → localStorage on every change (`PlanPersistenceGate`). Optional: user clicks "Sync Now" → UUID diff → Google Sheets via backend proxy.
2. **Simulation:** plan → pipeline edges applied → ledger scenario (cents) → daily loop × Monte Carlo runs in worker → percentile series → chart. Cached by full input fingerprint.
3. **Plaid:** Link → link-intent → token exchange → encrypted storage → webhook `SYNC_UPDATES_AVAILABLE` → job queue → worker → `/transactions/sync` → atomic RPC apply → accounts/transactions tables → frontend polls → connected-account `autoValue` on plan rows.
4. **Billing:** checkout session → Stripe → webhook (`customer.subscription.*`) → `profiles.plan_tier` flip → tier gate on Plaid routes.
5. **History:** weekly snapshots + per-alternative net worth points in Supabase; merged with local checkpoints for the chart (TMM+ only).

## Deployment (currently undefined)

- Root `vercel.json` references `scripts/inject-env.js`, `splash.html`, `auth-callback.html` — **none exist** (verified). This is a leftover from a pre-React static-HTML architecture.
- `backend/.ebignore` + a postdeploy hook reference an obsolete SQLite-era Elastic Beanstalk setup.
- No deploy workflow in `.github/workflows/`. Docs mention Vercel/Render/Fly/Railway options but nothing is wired.
- **Inferred:** the app has been run locally (Vite proxy → `localhost:3000`) and possibly manually deployed; there is no reproducible production deployment in the repo.

## CI (what actually runs)

- **CodeQL** (JS/TS) on push/PR; **npm audit** weekly + on PR; **validation harness** on PR (Plaid chaos mocks, ledger invariants, property tests, time-boundary, production guard — all offline/mocked).
- **Not in CI:** unit tests (`test:unit`), RLS/service-role security tests, Stripe validation (skipped by flag), live e2e scripts, stress tests. The Playwright parity job is enabled but has no server startup or secrets, so it cannot pass as configured.

## Documentation posture

Extensive docs exist under `docs/`. `docs/project/ARCHITECTURE.md` (dated 2026-02-11) is broadly accurate. Several others are stale (`PLAID_PRODUCTION_GAP_ANALYSIS.md` lists tests as "Open" that now exist; `docs/tests/README.md` omits half the test tree; `IMPLEMENTATION_SUMMARY.md` cites wrong paths). `docs/security/*` is mostly policy **templates** with placeholders — intended controls, not evidence of implementation.
