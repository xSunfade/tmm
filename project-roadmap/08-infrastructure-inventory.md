# Infrastructure Inventory — What Actually Exists (2026-07-03)

Read-only inspection of the Supabase, Vercel, and Stripe environments connected to this Cursor workspace, performed 2026-07-03. **Nothing was modified.** This is the ground truth the environment-separation work (Phase 5) starts from.

## Supabase

**One project** (confirms the audit's inference and D17's starting point):

| Property | Value |
|---|---|
| Name / ID | "The Money Machine" / `mkhmaqksodfwccheflpw` |
| Org | `ouzftkvgnskwgxjtewsc` |
| Region | us-east-1 |
| Postgres | 17.6 (GA channel) |
| Status | ACTIVE_HEALTHY |
| Created | 2026-01-10 |
| DB host | `db.mkhmaqksodfwccheflpw.supabase.co` |

**Data volume (dev-scale, matches D16's "founder data only"):** 4 auth users, 4 profiles, 9 accounts, 531 transactions, 3 Plaid tokens, 30 balance snapshots, 43 sync jobs, 164 usage-counter rows. 20 tables in `public`, all with RLS enabled.

**Key findings:**

1. **Migration tracking is empty.** The MCP `list_migrations` call returns `[]` — the 21 repo migrations were applied by hand, outside any runner. This confirms DATA-7 and means *no environment can currently be rebuilt from the repo*. The clean-baseline strategy (`03-data-model-and-migration-plan.md`) fixes this.
2. **Live schema has drifted from the repo migrations — in the good direction.** The legacy `users` table (migration 001) does not exist live, and every user FK (including `plaid_tokens.user_id`) points at `auth.users(id) ON DELETE CASCADE` (verified via `pg_constraint`). So DATA-4's feared integrity problem is *already resolved live*; the repo migrations are what's wrong. The baseline migration set makes the repo agree with (and improve on) live reality.
3. **No `plans` table exists** — server-side plan persistence (ADR-1) is confirmed unbuilt.
4. **Security advisors: 70 warnings** (all WARN level, none ERROR):
   - 17 × "RLS Policy Always True" (permissive policies on service-role-era tables)
   - 20 + 20 × GraphQL schema visibility to public/signed-in roles
   - 6 × mutable `search_path` functions (incl. `plaid_apply_transactions_sync`, `increment_usage_counter` — 3 are SECURITY DEFINER, executable by public/signed-in)
   - 1 × leaked-password protection disabled
   These are folded into Phase 2.1 (baseline policies) and Phase 5.9 (project config).
5. **Plan tier / backups:** the project is on the free tier posture assumed by the audit (Pro + PITR is a Gate B requirement for the *prod* project; the dev project can stay free).

**Gap to target:** staging and prod projects do not exist; no CLI migration management; advisor cleanup pending. All planned (Phases 2, 5).

## Vercel

**Team:** "Stephen Miller's projects" (`team_9Z9YdHNHr6IGbbSrJ6ScjVQh`). Two projects:

| Project | ID | Framework | Latest prod deploy | Domains |
|---|---|---|---|---|
| `tmm-frontend` | `prj_KF615efVZnMrRoWFgrfzRKuCWeb5` | (none set) | 2026-01-22, READY | **tmm.finance**, tmm-frontend-seven.vercel.app, + 2 team URLs |
| `tmm-backend` | `prj_tpF5jj8PcacIvnfFVvCeocFEycX9` | express | 2026-01-22, READY | tmm-backend-seven.vercel.app, + 2 team URLs |

**Key findings:**

1. **`tmm.finance` is already attached to `tmm-frontend`** — D19's canonical domain needs no acquisition, only the `api.` subdomain work.
2. **The backend runs on Vercel serverless.** This is the deployment the audit couldn't find in the repo (root `vercel.json` is stale; the deploys were evidently done from elsewhere/CLI). On serverless, the in-process Plaid sync worker and `setInterval` schedulers **do not run persistently** — queued sync jobs are only processed while a request happens to be executing, and scheduled daily syncs/weekly snapshots effectively don't happen. This validates ADR-4's always-on requirement and explains why the answers doc calls the Vercel URL temporary.
3. **Deploys are stale (Jan 2026)** and both projects show `live: false` — the deployed code predates ~6 months of repo work. Treat currently-deployed behavior as unrepresentative; the repo is the truth.
4. No deploy pipeline connects the repo to these projects (no deploy workflow in `.github/workflows/`).

**Gap to target:** Render (or equivalent) staging+prod services; `api.tmm.finance`; CI/CD pipeline; demote `tmm-backend` to dev/preview.

## Stripe

**Access mode: test/sandbox** (all objects `livemode: false`). Live-mode data is not visible through this workspace — verify live-mode state in the Stripe dashboard before Gate B.

| Object | State |
|---|---|
| Products | 1: **"TMM+ (Plus)"** (`prod_U16Jkca76SSwZ1`), active, service type, created 2026-02-20 |
| Prices | 1: `price_1T346URr8FJu4D4dZFOOPzXu` — **$5.00 USD/month**, licensed, no trial config |
| Subscriptions | 0 (none active in test mode) |
| Customers | 1 test customer (`tmm.testuser1@gmail.com`) with `supabase_user_id`/`user_id` metadata — confirms the metadata-linking pattern in the webhook code works |
| Webhook endpoints | **Not inspectable via this MCP** (the tool's API spec doesn't expose webhook-endpoint listing). Check the dashboard: the backend expects `STRIPE_WEBHOOK_SECRET` for `POST /api/webhooks/stripe`; whatever endpoint exists likely points at the stale Vercel backend URL and must be re-registered to `api.tmm.finance` (Phase 5.4) |

**Key findings:**

1. **The catalog is one monthly price for one product.** D7 requires: TMM+ and TMM+ Pro, each monthly + annual → at least 4 prices, plus the `plan_catalog` mapping. Build in test mode during Phase 4.6.
2. **$5/month is confirmed below the pricing floor.** With the real Plaid rates (below), the TMM+ floor is ~$11/mo typical / ~$17/mo worst case; $5 loses money even on light users. Recommended prices: TMM+ ~$12–15/mo, Pro ~$25–30/mo (see `04-billing-and-entitlements.md` §Pricing floor). Treat the current price as a placeholder.
3. The Stripe API version pinned in code (`2026-01-28.clover`) is recent; no upgrade work needed for MVP.

## Plaid

**Access mode: production approved** (D20). Contract created 2026-01-07. Rates obtained from the founder's Plaid dashboard (2026-07-03):

| Active product | Rate | Billing shape | Used in production code? |
|---|---|---|---|
| Transactions | **$0.30 / connected account / month** | Recurring, flat per account (covers syncs) | **Yes** — `linkTokenCreate` requests `['transactions']` (`server.js:2428`) |
| Balance | **$0.10 / call** | On-demand | **Yes, on-demand** — `accountsBalanceGet` via `POST /api/plaid/balance` (`server.js:3538`) |
| Auth | $1.50 / initial call | One-time per item | **No** — only in the `/api/diag/plaid` endpoint (`server.js:1381`) that SEC-2 removes |
| Identity | $1.50 / initial call | One-time per item | **No** — not called anywhere |

**Key finding:** Transactions is billed **per connected _account_, not per _item_.** `PLAID_ITEM_CAP` is currently `5` in code, but each login carries multiple accounts, so cost scales with accounts and the item cap alone does not bound it. Decision (2026-07-03): drop caps to **TMM+ 3 / Pro 6** (safety ceiling 10) and move them to per-tier entitlements — the cheapest lever to bound worst-case cost. The flat per-account Transactions fee covers syncing, so `/transactions/sync` frequency is cost-free to tune. Auth and Identity carry no production cost today because the real link flow requests only `transactions`.

## Environment-separation readiness summary

| Prepared | Missing |
|---|---|
| Supabase dev project healthy, RLS on, FKs correct live | Staging + prod projects; CLI migrations; advisor cleanup; Pro+PITR (prod) |
| `tmm.finance` owned and attached | `api.tmm.finance`; always-on backend hosts; deploy pipeline |
| Stripe test mode wired to code patterns (customer metadata linking); pricing floor computed with real Plaid rates | Full catalog (2 products × 2 intervals); founder-confirmed final prices; live-mode setup; webhook re-registration |
| Plaid production approved (D20); real contract rates known | Webhook URL registration to stable domain; SEC-1 verification before prod traffic; account-cap / item-cap decision |
| Repo has strong CI skeleton (CodeQL, audit, validation harness) | Unit tests in CI (Phase 0.6); money-path CI (4.14); CD (5.5) |

## Access notes for the AI workforce

- This workspace's MCP integrations: Supabase (full management API for the org — treat `apply_migration`/`execute_sql` writes as **dev-project-only** until staging exists), Vercel (team-scoped read/deploy), Stripe (**test mode only**; live keys are not exposed here, which is correct and should stay that way — live-mode operations remain a founder-in-dashboard task).
- Standing rule for all agents (mirrored in `tmm-workforce/operating-rules.md`): read-only inspection of any environment is always allowed; writes to staging require a passing migration PR; writes to prod happen only through the deploy pipeline, never through MCP tools directly.
