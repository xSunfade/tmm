---
name: tmm-release-gates
description: Use when preparing, executing, or auditing a TMM release or launch gate (A–D), deploying to staging/prod, rehearsing rollback, or responding to a production incident. Encodes gate procedure, deploy/rollback doctrine, kill switches, and the incident flow.
---

# TMM Release Gates & Operations

Shipping is a controlled act. This skill operationalizes `project-roadmap/10-launch-readiness-gates.md` and `project-roadmap/07-environments-and-hosting.md`.

## Gate execution procedure

1. Open the gate's checklist; create a dated gate-log entry.
2. For each item, attach **evidence**: test run link/output, command output, screenshot, or dashboard state. "Done" without evidence is not done.
3. Deviations are logged with reason and require founder sign-off — a gate never passes silently or partially by omission.
4. Walk the risk register (`project-roadmap/09-risk-register.md`): re-score, close mitigated rows, add new ones.
5. Founder makes go/no-go explicitly. Record it.

## Deploy doctrine

- Order: deploy backend → smoke → deploy frontend. Smoke = `/api/health` + **worker liveness** (a queued job processes — serverless silently kills the worker; this check exists because of that) + webhook self-test.
- Prod migrations apply with the deploy, are backward-compatible with the previous build, and never mid-incident.
- Post-deploy watch: abort thresholds (error rate, signup failures, webhook failures) are written down **before** deploying. Gates get 48 h; routine releases 24 h.
- Nothing reaches prod outside the pipeline — including "tiny" config changes.

## Rollback doctrine

- Rollback = redeploy previous build (both tiers). The DB never rolls back — which is why migrations must be additive/backward-compatible.
- Rollback is rehearsed before Gate B and quarterly after. If the rehearsal is stale, the release waits.
- A failed smoke check → roll back first, investigate second.

## Kill-switch inventory (know these cold)

| Switch | Effect |
|---|---|
| `RUN_PLAID_WORKER=false` | Stops sync processing (jobs queue safely) |
| Scheduler interval envs | Pause daily sync / weekly snapshots |
| Unset Stripe env | Billing routes 503 cleanly |
| Circuit breaker | Auto-halts Plaid retry storms |
| Signup soft-cap flag | Free signup → waitlist mode (D1) |
| Maintenance banner | User-facing notice |

## Incident flow (W6 summary)

1. Triage severity + blast radius. Is a kill switch applicable? **Stabilize first, diagnose second.**
2. Evidence discipline in diagnosis: confirmed (cite) / inferred / unknown.
3. Fix ships with its regression test; review is expedited, never skipped.
4. Post-incident (≤1 page): timeline, cause, fix, and the rule/alert/test that would have prevented it — added to `tmm-workforce/operating-rules.md`, monitoring, or CI in the same PR.
5. User impact → plain email from the founder account (D27); no status page exists yet.

## Environment couplings to double-check on any deploy

- Webhook URLs + OAuth redirects hang off `api.tmm.finance` (D19); Plaid items need `item/webhook/update` backfill if the URL changed (WH-P2).
- CORS matrix per environment (`07-environments-and-hosting.md`); staging and prod secrets never overlap.
- Stripe live-mode configuration is founder-in-dashboard; verify the live webhook signing secret matches the prod env var.
- Supabase prod = Pro + PITR; confirm before any release that touches data shape.
