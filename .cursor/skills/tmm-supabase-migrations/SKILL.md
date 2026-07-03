---
name: tmm-supabase-migrations
description: Use when creating or reviewing Supabase schema changes, RLS policies, plan persistence (plans/plan_revisions), retention sweeps, or anything touching TMM's database environments (dev mkhmaqksodfwccheflpw / staging / prod). Encodes migration discipline, the new-table checklist, and environment authority.
---

# TMM Supabase & Migration Discipline

Supabase is TMM's authoritative source of truth (ADR-1). Any environment must be rebuildable from the repo's migrations alone.

## Environment authority (hard rules)

- **dev** (`mkhmaqksodfwccheflpw`, "The Money Machine"): agents may develop freely, but schema changes still go through migration files — no ad-hoc DDL via MCP `execute_sql`, even here.
- **staging**: writes only via merged migrations applied by the pipeline.
- **prod**: never touched directly by agents or MCP tools. Pipeline only. Live data = real users' finances.
- Read-only inspection (`select`, advisors, logs) is always fine everywhere.

## Historical context you must know

- The 21 legacy migrations in `backend/supabase/migrations/` were **hand-applied**; live migration tracking is empty and live schema drifted (legacy `users` table absent live; FKs already point at `auth.users`). The clean baseline (Phase 2.1, `project-roadmap/03-data-model-and-migration-plan.md`) replaces them. After the baseline lands, the CLI migration set is the only truth.
- D16: dev data is founder-only; there is **no backward-compatibility constraint** on the current schema — prefer the clean design.

## Migration rules

1. Never edit an applied migration; always add a new file.
2. Prod-bound migrations must be **backward compatible** with the previous app build (rollback = redeploy old build; DB never rolls back).
3. CI must shadow-apply the full set from zero; if rebuild-from-zero fails, the PR fails.
4. Order per release: dev → staging soak → prod-with-deploy. Never sideways, never rushed mid-incident.

## New-table checklist (all items in the SAME PR)

- [ ] RLS enabled; **strict** user-scoped policy (`auth.uid() = user_id`) + explicit anon-deny — never `USING (true)` (17 such policies exist from the service-role era; don't add more)
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

- Pin `search_path` on all functions, especially SECURITY DEFINER (6 live functions currently violate this — advisor warning).
- Don't expose new objects via GraphQL; the baseline locks `graphql_public` down.

## Verification before handoff

- Shadow-apply green; RLS anon-test green (run against dev/staging); deletion-cascade test includes your table; `supabase migration list` matches the repo.
