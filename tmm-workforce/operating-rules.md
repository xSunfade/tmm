# Operating Rules — Binding on Every Agent

Read this before doing anything else in a TMM session. These rules exist because TMM handles other people's financial data and money. When a rule conflicts with speed, the rule wins. When a task genuinely requires breaking a rule, stop and get founder sign-off first.

## 1. Environment authority

| Environment | Read | Write |
|---|---|---|
| **dev** (Supabase `mkhmaqksodfwccheflpw`, localhost, Vercel previews) | Any agent, any time | Any agent, via normal development |
| **staging** | Any agent | Only via merged migration/deploy pipeline. No ad-hoc MCP writes. |
| **prod** | Read-only inspection only (logs, advisors, metrics) | **Never directly.** Only the deploy pipeline touches prod. No MCP `execute_sql`/`apply_migration` against prod, ever. Live Stripe operations are founder-in-dashboard only. |

- The workspace Stripe MCP is test-mode; treat any live-mode need as a founder task.
- Destructive operations anywhere (dropping tables, deleting users, resetting dev) require an explicit founder instruction in the current session — never inferred.

## 2. Money-path rules (Stripe, entitlements, Plaid billing)

1. Every change to webhook handlers, the entitlement resolver, tier limits, grace logic, or Plaid lifecycle transitions requires a paired review (see `review-gates.md`) and tests in the same PR.
2. The entitlement resolution function stays **table-driven**; no inline tier conditionals scattered in routes. New Stripe statuses fail closed (Free + alert).
3. Never grant entitlements client-side; UI gating is UX, not security.
4. Idempotency is not optional: webhook handlers check the event log before acting.
5. Prices, tiers, and limits are data (`plan_catalog`, `tier_entitlements`) — a PR that hardcodes a price or limit in application code is wrong by construction.
6. No checkout goes live at a price that hasn't passed the pricing-floor analysis (`project-roadmap/04-billing-and-entitlements.md`).

## 3. Simulation and domain-model rules

1. The engine's numeric substrate (integer cents, ppm rates, banker's rounding with residual carry) is inviolable. Any PR introducing floating-point arithmetic into money math is rejected.
2. The property-test suite (conservation, transfer symmetry, `cumulativeRoundingLossCents === 0`) must run and pass on every PR that touches `frontend/src/lib/simulation/` or the domain model.
3. **Golden fixtures freeze the product's output.** Changing a golden fixture requires: a dedicated commit, an explanation of *why the number changed*, and Simulation Engineer sign-off. A golden change hidden inside a feature PR is a launch-blocking review failure.
4. Determinism is a feature: same plan + same seed = same output, always. Anything time-dependent uses the injected clock/seed, never `Date.now()` inside the engine.
5. Domain model boundaries (ADR-2): the engine consumes the domain model; nothing outside the simulation package imports engine internals; the domain model imports nothing from the engine.
6. v1 domain-model scope is closed (no dividends, splits, tax lots, capital gains, rebalancing, withdrawal strategies). PRs adding them without a design doc are rejected regardless of quality.

## 4. Data and migration rules

1. **All schema changes are CLI migrations.** No hand-applied SQL on any environment, including dev. If you ran ad-hoc SQL to explore, it must not have mutated schema.
2. Never edit an applied migration; add a new one.
3. Prod migrations must be backward-compatible with the previous app build (rollback = redeploy old build, no DB rollback).
4. Every new user-data table ships with: RLS user-scoped policy + anon-deny, `ON DELETE CASCADE` to `auth.users`, inclusion in the deletion-cascade test, and a line in the retention table (`project-roadmap/06-security-privacy-and-retention.md`) — even if the line says "indefinite".
5. Plan documents are versioned; any `schemaVersion` bump ships with a migration function + fixture tests for every prior supported shape, and triggers an automatic `pre_migration` revision on first load.

## 5. Security rules

1. **Never-log list:** tokens of any kind, plan contents, account numbers, transaction descriptions, raw webhook payloads at info level, encryption keys. Telemetry may include userId, institution names, error codes, correlation IDs.
2. Secrets live in env/secret stores only. Any secret pasted into a file, test, or chat is treated as leaked → rotate.
3. New endpoints declare their auth tier explicitly (unauthenticated / JWT / JWT+entitlement / admin). Unauthenticated endpoints require Security Officer review, no exceptions.
4. Webhooks verify signatures before any other processing. A webhook route that does work before verification is a review-blocking defect.
5. Encryption: AES-256-GCM for tokens at rest stays fail-closed in production. Never weaken to warn-and-continue.
6. User-editable data is never a trust input: anything from the plan document (URLs, keys, config) is validated/allowlisted before use (SEC-6 lesson).

## 6. UX trust rules

1. **No silent failures.** Every catch block either surfaces a user-visible state or logs to the error tracker with a comment explaining why the user shouldn't see it. `.catch(() => {})` is banned.
2. Never lie about save state: indicators reflect reality (*Saved locally · Backed up · Not saved*). If a write failed, the user knows.
3. Destructive actions (import-replace, unlink, delete) always: confirm → snapshot → act → report what changed.
4. Data recovery over amnesia: parse failures preserve the raw blob and offer recovery; never silently reset to defaults.

## 7. Process and evidence rules

1. All work happens on branches via PRs; main is protected. Every bug fix includes its regression test in the same PR.
2. Use the audit's evidence vocabulary in all analysis: **Confirmed from code** (cite file), **Inferred** (say from what), **Unknown** (say what would resolve it). Never present inference as fact.
3. Cite decisions by D-number and findings by audit ID. If a task contradicts a D-decision, stop and flag it — decisions are changed by the founder editing the decision register, not by drift.
4. Scope discipline: do the task; no drive-by refactors in money paths or the engine. Opportunistic cleanup is fine in low-risk code, in separate commits.
5. Handoffs follow `handoff-protocol.md`; reviews follow `review-gates.md`. A PR without its required reviewer role's checklist is not mergeable.
6. When you discover a new hazard, add the rule here (or propose it) in the same PR as the fix.

## 8. Communication rules

1. Report outcomes faithfully: failing tests, skipped steps, and unknowns are stated plainly, never smoothed over.
2. Every session that changes behavior ends with: what changed, what was verified (with evidence), what remains, and any new risks.
3. The founder's email (stephen3miller@gmail.com) is the alert sink; agents don't configure additional recipients.
