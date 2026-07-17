---
name: tmm-supabase-migrations
description: Use when creating or reviewing Supabase schema changes, RLS policies, plan persistence (plans/plan_revisions), retention sweeps, or anything touching TMM's database environments (dev mkhmaqksodfwccheflpw / staging / prod). Encodes migration discipline, the new-table checklist, and environment authority.
---

# TMM Supabase & Migration Discipline

Supabase is TMM's authoritative source of truth (ADR-1). Any environment must be rebuildable from the repo's migrations alone.

## Environment authority (hard rules)

- **dev** (`mkhmaqksodfwccheflpw`, "The Money Machine"): agents may develop freely, but schema changes still go through migration files — no ad-hoc DDL via MCP `execute_sql`, even here.
- **staging** (`wekawukfpdqinesbltnx`, "tmm-staging", created 2026-07-17): writes only via merged migrations applied by the pipeline.
- **prod**: never touched directly by agents or MCP tools. Pipeline only. Live data = real users' finances.
- Read-only inspection (`select`, advisors, logs) is always fine everywhere.

## Historical context you must know

- The 21 legacy hand-applied migrations (`backend/supabase/migrations/`) were **deleted 2026-07-17** (git history only). `supabase/migrations/` starting at `20260706185451_baseline.sql` is the **sole** migration source; it was verified to rebuild the full schema from zero (staging `wekawukfpdqinesbltnx` was built from it and schema-fingerprint-matched dev exactly; residual dev drift converged by `20260717025906_converge_legacy_dev_drift.sql`). Both dev's and staging's `supabase_migrations.schema_migrations` match the repo — keep it that way (apply via `apply_migration` MCP tool or `supabase db push`, then commit the identical file).
- The baseline is **idempotent** (create-if-not-exists / drop-then-create) because it had to converge the drifted dev schema without a destructive reset. Follow-up migrations already applied: `drop_legacy_permissive_policies` (removed all 17 `USING (true)` policies), `harden_grants` (anon fully revoked from `public`; trigger/RPC functions not executable), `lock_token_tables` (`plaid_tokens` / `google_sheets_tokens` / `plaid_circuit_breaker` are service-role-only — no authenticated policy or grants), `retention_sweeps` (pg_cron nightly `run_retention_sweeps()` at 03:30 UTC).
- D16: dev data is founder-only; there is **no backward-compatibility constraint** on the current schema — prefer the clean design.

## Migration rules

1. Never edit an applied migration; always add a new file.
2. Prod-bound migrations must be **backward compatible** with the previous app build (rollback = redeploy old build; DB never rolls back).
3. CI must shadow-apply the full set from zero; if rebuild-from-zero fails, the PR fails.
4. Order per release: dev → staging soak → prod-with-deploy. Never sideways, never rushed mid-incident.

## New-table checklist (all items in the SAME PR)

- [ ] RLS enabled; **strict** user-scoped policy (`auth.uid() = user_id`) + explicit anon-deny — never `USING (true)` (the 17 service-role-era permissive policies were dropped 2026-07-06; don't reintroduce any)
- [ ] Secrets/token tables get NO authenticated policy at all (service-role only, like `plaid_tokens`)
- [ ] FK to `auth.users(id) ON DELETE CASCADE` (or a deliberate, documented exception)
- [ ] Added to the deletion-cascade verification test
- [ ] Row added to the retention table in `project-roadmap/06-security-privacy-and-retention.md` (even if "indefinite")
- [ ] Indexes for the query patterns you're introducing
- [ ] If it can grow unboundedly: a sweep in the retention job

## Plan persistence specifics (ADR-1 / D14)

- `plans`: one row per user, jsonb + `schema_version` + `client_saved_at`. `PUT /api/plan`: warn ≥1 MB, reject >5 MB (route-scoped body limit), validate schema version, echo `client_saved_at` for conflict detection.
- `plan_revisions`: rolling 20, pruned on insert; `reason` ∈ save / pre_import / pre_migration / manual. Destructive flows (imports, schema migrations) snapshot **before** acting.
- jsonb plan schema bumps: migration function + fixture tests for every prior supported shape; `pre_migration` revision on first load; corrupt parses preserve the raw blob (never silent reset).

## Function/security hygiene

- Pin `search_path` on all functions, especially SECURITY DEFINER (all live functions comply as of the baseline; keep it that way).
- Revoke `execute` from anon/authenticated/public on trigger and internal functions (they're otherwise callable via `/rest/v1/rpc/...`).
- Anon has zero table privileges in `public` (revoked wholesale + default privileges); new tables inherit that, but still add the explicit anon-deny policy.

## Verification before handoff

- Shadow-apply green; RLS anon-test green (run against dev/staging); deletion-cascade test includes your table; `supabase migration list` matches the repo.
