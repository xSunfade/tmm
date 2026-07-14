# Data Model and Migration Plan

How the Supabase schema and the plan document evolve to serve ASOT persistence (ADR-1), the domain model (ADR-2), entitlements (ADR-3), and three environments (ADR-5). Decisions cited by D-number.

## Strategy: clean baseline, not incremental patching

D16 removes the backward-compatibility constraint: the current Supabase project holds only founder dev/testing data (verified 2026-07-03: 4 auth users, 531 transactions, 9 accounts, 3 Plaid tokens). Live inspection also confirmed the schema has **already drifted** from the repo's migrations — `supabase_migrations` tracking is empty (migrations were hand-applied), the legacy `users` table from migration 001 does not exist live, and `plaid_tokens.user_id` FKs to `auth.users` (not the legacy table migration 001 defines). Rebuilding trust in "migrations describe the database" by patching 21 hand-applied files is more work than starting clean.

**Plan:**

1. Author a **new migration baseline** (`0001_baseline.sql` onward) under Supabase CLI management (`supabase/` at repo root with `config.toml`), capturing the *target* schema below — correct FKs from day one (dissolving DATA-4), no legacy `users` table (completing DATA-5), plus the new tables.
2. Dev project: reset and rebuild from the baseline. Founder data worth keeping (Plaid items can be re-linked; the plan lives in localStorage/Sheets anyway) is migrated by a small one-off export/import script — *evaluate whether even that is worth it; re-linking two banks may be cheaper*.
3. Staging and prod projects are **born from the CLI migration set** — they never see hand-applied SQL.
4. From this point, schema changes are only: new migration file → PR review (Data role + reviewer per `tmm-workforce/`) → CI applies to a shadow DB → merge → apply to dev → staging soak → prod.

## Target schema (public schema, all tables RLS-enabled)

### Kept essentially as-is (from the current design, re-expressed in the baseline)

| Table | Notes |
|---|---|
| `profiles` | + `stripe_subscription_id`, `subscription_status`, `current_period_end`, `grace_expires_at`, `role` (admin gating, SEC-4). `plan_tier` becomes a *derived* column maintained by the entitlement resolver |
| `user_onboarding` | unchanged |
| `plaid_tokens` | FK → `auth.users` (correct in baseline); + `retention_expires_at` (D12 30-day window), `sync_suspended_at` |
| `accounts`, `transactions` | unchanged shape; transactions retained indefinitely (D15) |
| `plaid_item_status`, `plaid_link_intents`, `plaid_sync_runs`, `plaid_sync_jobs`, `plaid_webhook_events`, `plaid_connection_events`, `plaid_circuit_breaker`, `usage_counters` | unchanged; retention sweeps added (D15) |
| `google_sheets_tokens` | unchanged; consent flow changes are app-level (D21) |
| `account_balance_snapshots`, `net_worth_points`, `net_worth_points_alt`, `history_reconciliation_overrides` | unchanged |
| `privacy_consents`, `data_deletion_requests` | + soft-delete bookkeeping (D15: 30-day window) |

### New tables

| Table | Purpose | Key columns |
|---|---|---|
| `plans` | ASOT plan document (ADR-1) | `user_id` (unique, FK auth.users), `plan jsonb`, `schema_version text`, `size_bytes int`, `client_saved_at timestamptz`, `updated_at` |
| `plan_revisions` | Rolling last-20 history (D14) | `id`, `user_id`, `plan jsonb`, `schema_version`, `created_at`, `reason` (`save` / `pre_import` / `pre_migration` / `manual`) |
| `plan_catalog` | Stripe price → tier mapping (ADR-3) | `stripe_price_id` (unique), `tier`, `billing_interval`, `active` |
| `tier_entitlements` | Tier → limits mapping (D7/D8) | `tier` (pk), `max_alternatives int` (null = unlimited), `max_horizon_years int` (null = unlimited), `plaid_enabled bool`, `max_plaid_items int`, `extras jsonb` |
| `stripe_events` | Webhook idempotency + audit (PAY-5, 90-day retention) | `event_id` (unique), `type`, `outcome`, `payload jsonb`, `received_at` |
| `waitlist` | TMM+ waitlist + free-overflow waitlist (D1) | `email`, `user_id nullable`, `list` (`tmm_plus` / `free_overflow`), `invited_at`, `redeemed_at` |
| `invites` | Invite issuance/redemption (D2) | `code` (unique), `issued_by`, `tier_granted`, `expires_at`, `redeemed_by` |
| `audit_log` | Security-relevant events, 1-year retention (D15) | `user_id nullable`, `action`, `detail jsonb`, `created_at` |

### Removed relative to current live/migration state

- Legacy `users` table and `backend/models/user.js` path (DATA-5) — already absent live; the baseline makes the repo agree.
- The dropped-then-recreated history prune function saga (migrations 019/021) is replaced by one coherent retention-sweep design (below).

## The plan document: schema v3

The plan stays a **versioned jsonb document** (no per-entity relational explosion — the audit's anti-goals stand). Phase 3 raises `schemaVersion` to `3.0` with the domain-model shape (ADR-2):

- **Entities:** `accounts` (banking/credit), `positions` (market holdings: `instrumentRef`, `quantity`, `assumedAnnualReturn`, acquisition events), `cashFlows` (income/expense, recurring/one-time, replaces separate income/expense rows conceptually — keep familiar UI grouping), `debts`, `checkpoints` (observed ground truth, D3), `assumptions`, plus existing `alternatives`, `pipeline`, `goals`, `augments`.
- **Compatibility:** `migratePlan()` gains a v2→v3 step with fixture tests for every historical shape still supported (DATA-2 discipline). Ticker-mode assets map to positions (balance ÷ current price = initial quantity, flagged for user review); plain APY assets stay balance-based accounts.
- **Hygiene:** `lastRun.series` (cached simulation output) is **excluded** from persistence — it bloats every save and revision.
- **Secrets:** `assumptions.finnhubKey` is removed from the exportable document (SEC-10) — moved to user-scoped local settings or a backend proxy.

Size budget (D14): warn at 1 MB, hard-reject at 5 MB, enforced in `PUT /api/plan`; the route's body limit is raised accordingly (route-scoped, not global).

## RLS posture

- All user tables: user-scoped policies (`auth.uid() = user_id`), explicit anon-deny.
- The live advisor scan (2026-07-03) flags 17 **"RLS policy always true"** warnings — service-role-era permissive policies. In the baseline, policies are written strictly; the backend keeps using the service-role key (bypasses RLS) so strict policies cost nothing and protect the anon/browser path.
- GraphQL exposure (`graphql_public`) and leaked-password protection are fixed at the project-config level (Phase 5.9).
- `SECURITY DEFINER` functions get pinned `search_path` (advisor warning; 6 functions today).
- The RLS anon-test runs in CI against staging weekly and against prod before launch (Gate C).

## Retention sweeps (D15)

One scheduled sweep (host cron hitting an admin endpoint, or `pg_cron` on Supabase — decide in Phase 5; prefer `pg_cron` to keep it DB-local):

| Data | Policy |
|---|---|
| Plans, transactions, history, user financial data | Indefinite (user-deleted only) |
| `plan_revisions` | Keep newest 20 per user |
| `stripe_events`, `plaid_webhook_events` | 90 days |
| `plaid_sync_runs`, sync logs | 30 days |
| `audit_log` | 1 year |
| Soft-deleted plans/accounts | Purge 30 days after deletion request |
| `plaid_tokens` past `retention_expires_at` | Revoke at Plaid + delete (ADR-6) |

## Migration sequencing across environments

```
dev (mkhmaqksodfwccheflpw, existing)
  Phase 2: baseline authored → dev reset/rebuilt from baseline
  Phases 2–4: feature migrations land on dev via PR + CI shadow-apply
staging (new, Phase 5.1 — created mid-Phase 4 when integration tests need it)
  receives the full migration set from zero (proves reproducibility)
  hosts Stripe test-mode + Plaid sandbox integration runs, RLS scheduled tests
prod (new, Phase 5.2, Gate B)
  born from the migration set; Supabase Pro (base) on before any real user; PITR deferred to the first real Plaid invoice (DATA-8)
  every release: staging soak → prod apply; migrations additive/backward-compatible per release
```

Rules:
- Never edit an applied migration; always add.
- Prod migrations for a release must be **backward compatible** with the previous app build (rollback = redeploy previous build without DB rollback).
- Restore runbook (DATA-8) written at 5.2 and rehearsed once into a scratch project before Gate C.

## Deletion cascade (D24)

The baseline defines `ON DELETE CASCADE` FKs from every user table to `auth.users` (already true live for the 20 existing tables — verified via FK inspection 2026-07-03; new tables follow suit). The deletion flow: revoke Plaid items → delete auth user (cascades) → verify. A **full-footprint deletion test** (create user with rows in every table → delete → assert zero rows) runs in CI against staging (Phase 4.12) and is a Gate C blocker.
