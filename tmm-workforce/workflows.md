# Collaboration Workflows

End-to-end sequences for TMM's recurring work types. Each names the roles involved, the order, and the artifacts exchanged (per `handoff-protocol.md`). Roles are defined in `roles/`; checklists in `review-gates.md`.

## W1 — Standard feature

```
Product Strategist (scope + DONE MEANS, cites roadmap item)
  → Builder role (domain-appropriate) implements on a branch, tests included
  → Paired reviewer(s) per review-gates.md run checklists on the diff
  → QA verifies CI + any manual-script impact
  → Technical Writer reviews doc updates (if behavior/config changed)
  → merge → Release Manager notes it for the next release
```

Small tasks collapse steps (builder self-drafts scope from the roadmap item), but the reviewer step never collapses for money/engine/data/auth changes.

## W2 — Schema/data migration

```
Data Platform Engineer drafts migration + rollback note (backward-compat statement)
  → CI shadow-applies from zero (rebuild proof)
  → Security Officer reviews RLS/policies/cascade
  → merge → auto-apply to dev
  → staging apply + soak (integration tests run against it)
  → Release Manager schedules prod apply with the next deploy (never mid-release)
```

Plan-document (jsonb) schema changes additionally involve the Simulation Engineer (domain shape) and Frontend/UX Engineer (migration UX: `pre_migration` revision, recovery paths).

## W3 — Billing/entitlement change

```
Product Strategist states the commercial intent (tier, limit, price, promo)
  → Billing Engineer maps it to catalog/entitlement rows + resolver changes (if any)
  → Pricing floor re-checked if any price/limit moved (04-billing §floor)
  → Billing review checklist + Security Officer if auth surface moved
  → Staging: test-mode loop + test clocks for any state-machine change
  → Founder executes any live-mode Stripe dashboard steps (agents prepare exact click-path)
  → Release Manager includes in release notes; post-release: one reconciliation spot-check
```

## W4 — Simulation/domain-model change

```
Simulation Engineer writes a short semantics note first (what number changes and why,
  citing D3/D4/spec) — even 5 lines; this is the review anchor
  → implement with property suites green throughout
  → golden changes in a dedicated commit with the semantics note referenced
  → Simulation review (if author ≠ owner) + QA fixture review
  → Frontend/UX Engineer checks that UI copy still describes the model truthfully
```

## W5 — Release (Gates B/C cadence and routine releases after)

```
Release Manager assembles: change list, migration order, env-var diffs, risk deltas
  → runs the relevant gate checklist (or the routine-release subset:
     CI green, staging soak, manual smoke, rollback confirmed current)
  → founder go/no-go
  → deploy backend → smoke (health, worker liveness, webhook self-test) → deploy frontend
  → post-deploy verification (founder end-to-end for gates; smoke for routine)
  → 48h watch (gates) / 24h watch (routine) against abort thresholds
  → gate log / release notes appended
```

## W6 — Incident

```
Detection (alert to founder email / user report)
  → Release Manager (or first responder agent) triages: severity, blast radius,
     is a kill switch applicable? (RUN_PLAID_WORKER, Stripe 503, breaker, soft-cap, banner)
  → Stabilize first (kill switch / rollback) — diagnose second
  → Domain role investigates with evidence discipline (confirmed/inferred/unknown)
  → Fix via W1 with regression test; expedited review, never skipped review
  → Post-incident: ≤1 page — timeline, cause, fix, and the rule/alert/test that
     would have prevented it → added to operating-rules.md / monitoring / CI in the same PR
  → user comms if impact: plain email per D27
```

## W7 — Security-sensitive change (new endpoint, OAuth, webhook, secrets)

```
Builder declares the auth tier and data exposure in the PR description up front
  → Security Officer review is non-delegable; checklist output required
  → If unauthenticated surface or token handling changed: manual probe on staging
     (anonymous request → expect 401/404) recorded as evidence
  → merge only with Security sign-off
```

## W8 — Dependency/platform upgrade

```
QA Engineer snapshots current green baseline
  → upgrade on a branch; full suite + smoke
  → domain roles spot-check their surfaces (xlsx → import paths; stripe SDK → webhook
     construct; plaid SDK → sync/verification; supabase-js → auth flows)
  → normal review; release with routine cadence, never bundled with feature releases
```

## W9 — Waitlist cohort release (Gate D onward)

```
Product Strategist proposes cohort size (Plaid cost projection + capacity check)
  → Billing Engineer issues invites (batch)
  → 1-week health review: sync health, entitlement corrections (target: 0),
     support volume, unit economics vs floor
  → Release Manager logs the review → next cohort or pause
```

## Cross-cutting habits

- **Rule capture:** any workflow that surfaces a new hazard ends by updating `operating-rules.md`, the risk register, or a checklist — in the same PR.
- **Evidence over assertion:** "verified" always names the test/command/screenshot.
- **One writer per artifact:** concurrent agent sessions never edit the same file family (engine, migrations, webhook handlers) in parallel; the Architect arbitrates splits.
