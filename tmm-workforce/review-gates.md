# Review Gates and Check Systems

Which changes require which reviewer, and what each review checks. A "review" here means: launch the paired role (fresh session/subagent) on the diff with its checklist; findings go in the PR; the builder resolves or the founder accepts. Reviews are adversarial by design — the reviewer's job is to find the way the change breaks trust, not to approve it.

## Pairing matrix — who must review what

| Change touches… | Required reviewer(s) | Optional |
|---|---|---|
| `frontend/src/lib/simulation/**`, domain model, plan schema/migrations (client) | **Simulation Engineer** (if not author) + QA (goldens) | Architect |
| Supabase migrations, RLS, retention sweeps, plan persistence backend | **Data Platform Engineer** + **Security Officer** (RLS/policies) | |
| Stripe webhooks, entitlement resolver, tiers/limits, waitlist/invites | **Billing Engineer** + **Security Officer** (if auth surface changes) | Product Strategist (limits/pricing) |
| Plaid routes, sync worker, lifecycle sweeps, Plaid webhooks | **Integrations Engineer** + **Security Officer** (webhook/verification changes) | |
| Any new/changed endpoint auth tier; any unauthenticated endpoint; secrets handling; OAuth flows | **Security Officer** (non-delegable) | |
| Frontend screens, error states, save indicators, import/export UX | **Frontend/UX Engineer** + QA (manual script impact) | Writer (copy) |
| CI workflows, test infrastructure, fixtures | **QA Engineer** | |
| Deploy pipeline, env config, hosting, domains | **Release Manager** + Security Officer (secrets) | |
| Policy/legal docs, runbooks, user-facing copy about promises | **Technical Writer** + Security Officer (truthfulness vs implementation) | |
| ADR changes, cross-cutting structure, new dependencies | **Chief Architect** (non-delegable) | |

Self-review is never sufficient for: money paths, engine numerics, RLS/auth, migrations, unauthenticated surface. For trivial changes elsewhere (copy, comments, dead-code deletion), builder + CI is enough.

## Domain review checklists

Reviewers run the relevant checklist and answer each item explicitly (pass / fail / n-a with reason).

### Simulation / domain model
- [ ] Property suites green (conservation, transfer symmetry, zero rounding loss); goldens unchanged — or changed in a dedicated, explained commit with sign-off
- [ ] No floats in money math; no `Date.now()`/randomness outside injected seed/clock
- [ ] ADR-2 boundaries intact (engine ↛ outside; domain ↛ engine)
- [ ] Checkpoint semantics per D3 (state seeds from latest checkpoint); positions per D4 (qty × price, DCA buys at `price(t)`)
- [ ] New behavior has a golden or property test; edge cases (negative cash, zero-quantity, horizon boundaries) considered
- [ ] v1 scope respected (no un-scoped domain concepts)

### Data / migrations
- [ ] Migration is additive/backward-compatible for the current release; never edits an applied file
- [ ] RLS: user-scoped policy + anon-deny; not "always true"; verified by the RLS test
- [ ] FK to `auth.users` with correct cascade; table added to deletion-cascade test and retention table
- [ ] Rebuild-from-zero works (CI shadow apply); no hand-applied SQL implied anywhere
- [ ] jsonb plan changes: schema version bumped, migration fn + fixtures for old shapes, `pre_migration` revision triggered
- [ ] Indexes for new query patterns; no unbounded-growth table without a sweep

### Billing / entitlements
- [ ] Resolution stays table-driven; every Stripe status explicitly mapped; unknown → Free + alert
- [ ] Price verified against `plan_catalog` before entitlement changes (PAY-2)
- [ ] Event idempotency: `stripe_events` checked/recorded; replay is a no-op
- [ ] Grace logic: 7-day window (D11); sweep covers the no-webhook case; test-clock test updated
- [ ] Downgrade preserves all user data (D9); over-limit content becomes read-only, never deleted
- [ ] No hardcoded prices/limits in app code; UI gating mirrors but never replaces server enforcement

### Plaid / integrations
- [ ] Webhook verification precedes all processing; unsigned rejected in prod paths; validation-mode bypass is explicit and prod-off
- [ ] Lifecycle transitions match the ADR-6 state machine; every exit from ACTIVE ends in REVOKED eventually; sweeps idempotent
- [ ] Tokens: encrypted at rest, deleted on revoke (BUG-3 class), never logged
- [ ] Job queue: dedupe keys intact; work is idempotent; webhook handler stays enqueue-fast (WH-P3)
- [ ] Item caps/velocity limits enforced via entitlements; MFA step-up preserved on sensitive actions

### Security (applied to any reviewed change)
- [ ] Auth tier of every touched endpoint stated and correct; no accidental unauthenticated surface
- [ ] Never-log list respected; no secret in code, fixture, or test output
- [ ] Input from users/plans/webhooks validated; no user-controlled URLs/keys trusted (SEC-6 class)
- [ ] OAuth flows: state signed/single-use/TTL/user-bound (SEC-3 class)
- [ ] Errors don't leak internals to anonymous callers

### Frontend / UX trust
- [ ] No new silent catch; failures have visible states with a next action
- [ ] Save/backup indicator remains truthful across the change's failure modes
- [ ] Destructive flows: confirm → snapshot → act → report
- [ ] Loading/empty/error states exist for new async UI; error boundary still catches the screen
- [ ] Copy: numbers/claims match what the engine actually computes (no overpromising; UX-F spirit)

### QA / CI
- [ ] New tests actually fail when the behavior regresses (mutation sanity check on at least the core assertion)
- [ ] CI runtime impact acceptable; no flaky patterns (sleeps, real network in unit tests)
- [ ] Fixtures deterministic; seeds pinned; goldens tracked

### Release / ops
- [ ] Env vars added to `.env.example`s + config validator + runbook in the same PR
- [ ] Kill-switch behavior preserved (clean 503s, worker flag, breaker)
- [ ] Deploy/rollback story unaffected or updated; migration ordering vs deploy documented

## Scheduled (calendar) checks — not tied to PRs

| Check | Cadence | Owner |
|---|---|---|
| RLS anon-test vs staging | Weekly (CI schedule) | Security Officer |
| Stuck Plaid jobs / failed sweeps | Daily (automated alert) | Integrations Engineer |
| Stripe ↔ DB entitlement reconciliation (post-MVP job PAY-7; manual spot-check until then) | Weekly | Billing Engineer |
| Dependency audit triage (npm audit/Dependabot/CodeQL) | Weekly | Security Officer |
| Cost review (Plaid items, Supabase usage, host spend, Stripe fees) | Monthly | Product Strategist |
| Risk-register walk | Phase boundaries + gates | Release Manager |
| Docs-truthfulness spot check (pick one doc, verify against code) | Monthly | Technical Writer |
