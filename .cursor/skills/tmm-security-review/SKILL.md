---
name: tmm-security-review
description: Use when reviewing any TMM change that adds/modifies endpoints, auth tiers, OAuth flows, webhooks, secrets handling, RLS policies, logging, or user-input trust boundaries — and when performing scheduled security verification (RLS anon-tests, secret scans, dependency triage). Encodes TMM's security review procedure and never-log list.
---

# TMM Security Review

Assume real financial data and paid users; assume adversaries. This skill is the procedure for security-relevant reviews and verifications. Sign-off on these surfaces is non-delegable (see `tmm-workforce/review-gates.md`).

## Review procedure

1. **Map the surface first.** List every endpoint/flow the diff touches with its auth tier: unauthenticated / JWT / JWT+entitlement / admin. The builder must have declared these; verify against code (`requireAuth`, `requireEntitlement`, admin checks), not the PR description.
2. **Anything unauthenticated gets maximum skepticism.** New unauthenticated surface requires explicit justification. Diagnostic/debug endpoints are removed or admin-gated (SEC-2 lesson: `/api/diag/*` could create real Plaid link tokens anonymously).
3. **Webhooks:** signature/JWT verification precedes all processing (Stripe `constructEvent`, Plaid `Plaid-Verification`). Raw-body parsing stays route-scoped. Bearer tokens rejected on webhook routes.
4. **OAuth:** `state` must be signed, single-use, TTL-bound, and user-bound (SEC-3 lesson: raw UUID state = account-linking CSRF). Scopes minimal; Sheets scopes only in the separate consent flow (ADR-8).
5. **User-controlled data is never a trust input** (SEC-6 lesson: `plaidConfig.backendApiUrl` from an imported plan could redirect authenticated traffic). Any URL, key, or config read from plan documents/imports must be same-origin or allowlisted.
6. **Secrets:** none in code, fixtures, tests, or logs. Anything pasted anywhere = leaked = rotate. Env vars documented in `.env.example` + config validator in the same PR.
7. **Errors:** anonymous callers get generic errors; no stack traces, table names, or infra state.
8. **Fail closed:** unknown auth states, unknown webhook signers, unknown Stripe statuses → deny + alert.

## The never-log list (enforce in every review)

Tokens (any kind) · plan contents · account numbers · transaction descriptions · raw webhook payloads at info level · encryption keys. Allowed: userId, institution names, error codes, correlation IDs.

## Scheduled verifications (own the calendar)

- **RLS anon-test** weekly against staging; against prod before every gate. All user tables: strict user-scoped policies + anon-deny; no `USING (true)`.
- **Secret scan** (gitleaks-class, includes `*.ts/tsx` — the old script missed the entire frontend) in CI; full-history pass at Phase 0.4.
- **Dependency triage** weekly (npm audit / Dependabot / CodeQL): fix-now vs accept-with-reason, logged. `xlsx` parses untrusted uploads — treat its advisories as elevated.
- **Deletion cascade:** full-footprint user → delete → zero rows across all user tables. Every new table joins this test.
- **Supabase advisors** after any migration: no new warnings without an accepted-with-reason note (current baseline debt: always-true policies, GraphQL exposure, mutable search_path, leaked-password protection off — being cleared in Phases 2/5).

## Verdict format

Per checklist item: pass / fail / n-a with reason. Findings carry severity + concrete exploit path + suggested fix. End with an explicit approve/block. Security findings are not overridable by builder roles — disagreements escalate to the founder with both positions stated.
