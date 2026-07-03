# Environments and Hosting

Implements ADR-4 (topology) and ADR-5 (environment separation). Decisions: D17 (three Supabase projects), D18 (hosting), D19 (domains).

## Target topology

```
                     ┌──────────────────────────────┐
  users ───────────► │ tmm.finance (Vercel, static) │   Vite build, VITE_* config
                     └──────────────┬───────────────┘
                                    │ HTTPS (CORS allowlist)
                                    ▼
                     ┌──────────────────────────────┐
  Stripe webhooks ─► │ api.tmm.finance              │   Express monolith (routers),
  Plaid webhooks ──► │ (Render, 1 always-on node)   │   in-process sync worker,
  Google OAuth  ───► │                              │   schedulers, entitlements,
                     └──────────────┬───────────────┘   service-role Supabase access
                                    │
                                    ▼
                     ┌──────────────────────────────┐
                     │ Supabase (auth + Postgres)   │   RLS, PITR (prod)
                     └──────────────────────────────┘
```

The stable `api.tmm.finance` domain is the contract with third parties (webhook URLs, OAuth redirect URIs, HSTS, cookies). The backend host behind it can change (Render → Railway/Fly) without re-registering anything (D19).

**Why always-on, restated:** the Plaid sync worker polls a Postgres job queue in-process and the daily/weekly schedulers are `setInterval` in the web process. Serverless kills both. The current Vercel-hosted backend (see `08-infrastructure-inventory.md`) is therefore not a valid production home; it remains useful for dev previews only.

## Environment matrix

| Axis | dev | staging | prod |
|---|---|---|---|
| Frontend | Vercel previews / localhost Vite | Vercel preview or a staging alias | Vercel prod → **tmm.finance** |
| Backend | localhost / existing Vercel project (`tmm-backend`) | Render staging service (small instance) | Render prod service → **api.tmm.finance** |
| Supabase | `mkhmaqksodfwccheflpw` ("The Money Machine", existing) | new project (Phase 5.1) | new project (Phase 5.2), **Pro + PITR** |
| Stripe | test mode | test mode (own webhook endpoint) | **live mode** |
| Plaid | sandbox | sandbox | **production** (approved, D20) |
| Google OAuth | dev consent config | same client, staging redirect URIs | verified app for Sheets scopes (post-launch OK, D21) |
| Turnstile | test keys | test keys | production site key (D22) |
| CORS_ORIGIN | localhost:5173 etc. | staging frontend URL | `https://tmm.finance` |
| Webhook URLs | tunneled (ngrok) as today | `https://<staging-api-host>/api/webhooks/*` | `https://api.tmm.finance/api/webhooks/*` |
| Data | founder dev data; resettable | synthetic/seeded test users only | real users only; nothing else ever |

Hard rules:

1. **Secrets never cross environments.** Separate `TOKEN_ENCRYPTION_KEY`, Stripe keys, Plaid credentials, Supabase service keys per environment. A leaked staging key must be worthless in prod.
2. **Prod credentials live only in the prod host's secret store** (Render env vars) — never in `.env` files on disk, never in CI logs. `I_ACK_PROD`-style guards stay.
3. **Live Stripe keys and production Plaid credentials appear nowhere until Gate B.**
4. Migrations flow dev → staging → prod, never sideways or backward (see `03-data-model-and-migration-plan.md`).

## What exists today vs. this target

| Component | Today (inspected 2026-07-03) | Action |
|---|---|---|
| `tmm.finance` | Attached to Vercel `tmm-frontend` ✔ | Keep; becomes prod frontend |
| `api.tmm.finance` | Does not exist | DNS + TLS at Phase 5.4 |
| Backend hosting | Vercel `tmm-backend` (serverless, Express preset; last deploy Jan 2026) | Provision Render staging+prod (5.3); demote Vercel project to dev |
| Supabase | 1 project = de-facto dev | Keep as dev; create staging (5.1) + prod (5.2) |
| Stripe | Test mode; 1 product ($5/mo) | Rebuild catalog per pricing floor (4.6); live mode at Gate B |
| Deploy pipeline | None (manual deploys inferred) | GitHub Actions: CI green → deploy backend → smoke → deploy frontend (5.5) |
| Rollback | None | Previous-build redeploy, rehearsed (5.5); DB migrations backward-compatible per release |

## Deploy pipeline (Phase 5.5)

- **CI (already partially exists):** CodeQL, npm audit, validation harness + (new from Phase 0) unit tests, (Phase 4) money-path tests, one Playwright smoke.
- **CD:** on tag/main merge → build backend → deploy to Render staging → smoke (`/api/health`, webhook self-test) → manual promote to prod → deploy frontend. Keep it boring; no blue/green, no canaries at this scale.
- **Rollback:** redeploy previous build (both tiers); migrations for any release must tolerate the previous app version (additive-first discipline).
- **Kill switches (documented in the runbook):** `RUN_PLAID_WORKER=false`, scheduler interval envs, unset Stripe env → clean 503s, circuit breaker, signup soft-cap flag (D1), maintenance banner.

## Environment variables

The startup config validator (ENV-1, Phase 0.5) is the enforcement point: it prints a single table of missing/invalid vars and refuses to boot in production. `.env.example` files become complete and authoritative for both tiers, including the previously missing `GOOGLE_*`, `PLAID_WEBHOOK_URL`, `PLAID_SYNC_*`, and `VITE_AUTH_CAPTCHA_SITE_KEY` entries, plus new ones introduced by this roadmap (grace sweep config, soft-cap flag, admin allowlist, entitlement defaults).

## Cost picture (updated from the audit's cost plan)

| Item | Monthly |
|---|---|
| Vercel frontend | $0–20 |
| Render staging + prod backend | ~$14–50 (two small instances; staging can sleep on Railway/Fly if cheaper) |
| Supabase: dev (free) + staging (free) + prod (Pro) | $25+ |
| Domain/monitoring/Sentry free tiers | $5–20 |
| Plaid | per-item, bounded by ADR-6 lifecycle + caps |
| **Fixed floor** | **~$45–115/month** before Plaid |

Supabase usage alerts at 70%/90% of quota back the D1 soft-cap decision.
