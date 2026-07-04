# TMM Slack Channels — Structure and Purpose

This document defines the Slack workspace channel structure for The Money Machine project. Channels are organized to match TMM's technical architecture, AI workforce roles, and operational procedures.

## Design Principles

1. **Channels mirror the code architecture** — technical channels align with the repository structure, ADRs, and domain boundaries.
2. **Separate signal from noise** — high-stakes channels (#incidents, #releases, #prod-ops) are alert-only; discussion happens in dedicated threads or #dev channels.
3. **AI-friendly naming** — channels match the language in `tmm-workforce/` role files and `.cursor/skills/` so AI agents can route information correctly.
4. **Environment isolation** — staging and prod operations have dedicated channels to prevent accidental cross-environment actions.
5. **Public by default** — all channels are public unless they handle credentials, PII, or sensitive business strategy.

---

## Core Project Channels

### #general
- **Purpose:** Team-wide announcements, weekly updates, cross-cutting decisions, and casual coordination that doesn't fit elsewhere.
- **Who posts:** Anyone. The founder posts weekly progress summaries here.
- **Example posts:** "ADR-7 updated: annual billing added to roadmap", "Switching from Render to Railway this week", "Foundation day 1 complete — here's what shipped"
- **Keep out:** Bug reports (→ #bugs), incident alerts (→ #incidents), long technical debates (→ domain channel or thread)

### #announcements
- **Purpose:** High-signal, low-volume founder/leadership announcements: launches, policy changes, security notices, planned downtime.
- **Who posts:** Founder only. Everyone subscribed by default.
- **Posting rules:** 
  - Only announcements that affect the entire team or all users
  - No replies in-channel; use threads for discussion
  - Examples: "TMM+ waitlist opens Monday", "Gate C passed — public launch live", "Security patch deployed to prod"

### #watercooler
- **Purpose:** Off-topic, non-work conversation. Design inspiration, industry news, weekend plans, memes.
- **Unmonitored, optional participation.**

---

## Technical / Domain Channels

These channels align with TMM's architectural domains (from `project-roadmap/01-architecture-decisions.md`) and the AI workforce roles (`tmm-workforce/roles/`).

### #simulation
- **Purpose:** Discussion of the ledger engine, domain model (ADR-2), checkpoint/position semantics, numeric invariants, property tests, golden fixtures.
- **Owner role:** Simulation Engineer
- **Related skill:** `tmm-simulation-correctness`
- **Example posts:** "Property test failing on new DCA path", "Golden fixture change proposal: checkpoint advance now resets drift", "Reviewing D4 position model PR"
- **Never post here:** Hardcoded prices, test credentials, raw user plan data

### #data-platform
- **Purpose:** Supabase schema, migrations, RLS policies, plan persistence (`plans`/`plan_revisions`), retention sweeps, database performance.
- **Owner role:** Data Platform Engineer
- **Related skill:** `tmm-supabase-migrations`
- **Example posts:** "Migration 0008 applied to staging", "RLS anon-deny test failed on dev", "Considering composite index on (user_id, updated_at)", "Retention sweep deleted 847 old webhook events"
- **Environment alerts:** Automated migration status (dev/staging/prod) post here

### #billing-entitlements
- **Purpose:** Stripe webhooks, checkout/portal flows, entitlement resolver, tier limits, grace/dunning, waitlist/invites, pricing catalog changes.
- **Owner role:** Billing Engineer
- **Related skill:** `tmm-stripe-entitlements`
- **Example posts:** "PAY-2 idempotency fix deployed to staging", "Pricing floor analysis updated with real Plaid invoice", "Webhook signature verification failed — investigating", "TMM+ waitlist at 23 signups"
- **Never post here:** Live Stripe secret keys, real customer emails, card details

### #plaid-integrations
- **Purpose:** Plaid Link, sync worker/job queue, item lifecycle (connect → sync → grace → suspend → revoke), Plaid webhooks, Google Sheets OAuth, transaction import.
- **Owner role:** Plaid Integrations Engineer
- **Related skill:** `tmm-plaid-lifecycle`
- **Example posts:** "Sync worker migrated to tmux-backed session on Render", "Item state machine: added SUSPENDED state per ADR-6", "Plaid sandbox item_id abc123 stuck in PENDING_EXPIRATION — debugging", "Google token refresh failed for user xyz — circuit breaker opened"
- **Automated posts:** Plaid webhook delivery failures (error rate > threshold)

### #frontend-ux
- **Purpose:** React app, UI components, state management (flowState), save-truth UX, accessibility, silent-failure elimination, Vercel frontend deployments.
- **Owner role:** Frontend/UX Engineer
- **Example posts:** "Save indicator now shows 'Backed up to cloud' after server confirms", "Onboarding flow: added skip-tour option per UX-3", "Chart rendering slow with 50+ accounts — profiling", "Vercel preview deployed: cursor-123-add-waitlist-ui"

### #security-privacy
- **Purpose:** Security reviews, RLS verification, secrets handling, never-log compliance, privacy policy updates, SEC-x audit item remediation, penetration test results.
- **Owner role:** Security & Privacy Officer
- **Related skill:** `tmm-security-review`
- **Example posts:** "SEC-6 closed: URL validation added to plan import", "New endpoint `/api/admin/metrics` requires Security Officer review", "Scheduled: RLS anon-test sweep tonight", "Privacy policy updated for Plaid production launch"
- **Never post here:** Actual secrets/tokens (even redacted examples can leak structure)
- **Access:** Public (we practice security by design, not obscurity), but no PII/credentials ever

### #testing-qa
- **Purpose:** Test strategy execution, CI/CD status, golden fixture reviews, property test failures, manual pre-release QA checklists, validation reports.
- **Owner role:** QA Engineer
- **Example posts:** "Gate B QA checklist: 14/18 passed, 4 blocked on PAY-3", "Property test conservation failure reproduced locally", "Chaos test report: 3 new failures from transaction rounding edge case", "CI red on main — flaky Plaid mock, investigating"
- **Automated posts:** CI failures on main/staging, nightly property-test runs

---

## Process / Workflow Channels

### #releases
- **Purpose:** Gate execution (A → B → C → D), deploy announcements, rollback procedures, release notes, go/no-go decisions.
- **Owner role:** Release Manager
- **Related skill:** `tmm-release-gates`
- **Example posts:** "Gate B entry criteria met — starting staging burn-in", "Deploying Phase 3 to prod: migrations 0007–0012", "Rollback triggered: entitlement resolver 500s on new Stripe status", "Gate C checklist: 22/24 green, waiting on SEC-1 final sign-off"
- **Posting discipline:** Every prod deploy gets a message here *before* and *after*; include commit SHA, what changed, and rollback plan.

### #incidents
- **Purpose:** Real-time production incident coordination. Incident commander announcements, escalation, resolution, postmortem links.
- **Owner role:** Incident Commander (founder or delegate)
- **Related:** `docs/security/INCIDENT_RESPONSE_PLAN.md`
- **Alert-only during incidents:** No chitchat; open a thread for updates. After resolution, link the postmortem.
- **Example posts:** "🚨 INCIDENT OPEN: Stripe webhooks timing out (P1)", "Mitigation deployed: circuit breaker engaged, billing degraded to read-only", "Incident resolved: root cause = Supabase RLS query plan regression, fixed via index"
- **Automated posts:** PagerDuty/UptimeRobot alerts, error rate spikes

### #code-reviews
- **Purpose:** PR review requests, reviewer assignments (per `tmm-workforce/review-gates.md`), review checklist completions, blocking feedback.
- **Example posts:** "PR #47 ready for Billing Engineer review (PAY-2 idempotency)", "Security Officer sign-off required: new unauthenticated endpoint in PR #51", "Review gate failed: golden fixture changed without explanation — see PR #49 comments"
- **Workflow:** Builder posts PR link + required reviewer role; reviewer posts checklist or approval.

### #postmortems
- **Purpose:** Links to completed incident postmortems, bug retrospectives, near-miss analyses, lessons-learned summaries.
- **Not for real-time discussion** — use threads.
- **Example posts:** "Postmortem: 2026-06-15 Plaid sync outage (95 min downtime)", "Retrospective: Why BUG-7 made it to staging (test gap identified)", "Near-miss: dev Supabase credentials almost committed"

---

## Environment / Operations Channels

### #dev-ops
- **Purpose:** Local and dev environment troubleshooting, dependency upgrades, dev Supabase changes, localhost workflow improvements, dev tooling.
- **Example posts:** "Dev Supabase project reset — re-run migrations locally", "Node 20.15.0 now required (lockfile updated)", "Added Vite proxy fix for WebSocket HMR", "Cursor skill auto-load verified"

### #staging-ops
- **Purpose:** Staging environment status, integration test runs, Stripe test-mode webhooks, Plaid sandbox item management, rehearsal deploys.
- **Automated posts:** Staging deploy notifications, nightly integration test results, Stripe test-clock sim completions
- **Example posts:** "Staging migration 0009 applied — RLS verified", "Plaid sandbox: created 5 test items for Gate B scenarios", "Test-clock scenario: subscription dunning (7-day grace) completed"

### #prod-ops
- **Purpose:** Production observability, monitoring alerts, usage metrics, Supabase/Vercel/Render health, cost alerts, backup verifications.
- **Restricted discussion:** Only prod-access roles post here (founder, on-call engineer).
- **Example posts:** "Prod Supabase CPU 85% — investigating", "Daily backup verified: 142 user plans, 8,293 revisions", "Stripe live webhook delivery 99.97% last 24h", "Plaid production usage: 47 items, $14.10 billed this cycle"
- **Automated posts:** Cost threshold alerts (Supabase/Vercel/Plaid usage), uptime checks, daily health summaries

---

## AI Agent / Workforce Channels

### #ai-agents
- **Purpose:** AI agent task logs, subagent launches, handoff summaries, skill invocation logs, multi-agent coordination.
- **Example posts:** "Launched Data Platform Engineer subagent: migrate dev schema to ADR-2 target", "Simulation Engineer + QA Engineer paired review on PR #52", "Skill `tmm-plaid-lifecycle` invoked: adding SUSPENDED state", "Chief Architect escalation: D4 implementation diverging from spec"
- **Who posts:** Founder (when launching agents), agents themselves (summarizing work), or integration bots
- **Optional:** May be noisy; mute if preferred, but useful for async visibility into agent work

### #ai-errors
- **Purpose:** AI agent failures, skill misapplications, hallucinations, incorrect citations, operating-rule violations.
- **Example posts:** "Agent ignored `never-log` rule: plan contents in commit message", "Skill `tmm-security-review` not invoked on new endpoint PR", "Subagent proposed migration edit (violates rule: never edit applied migrations)", "Golden fixture changed without Simulation Engineer sign-off"
- **Use for workforce tuning** — patterns here → rule additions or skill refinements

---

## Optional / Future Channels

### #docs
- **Purpose:** Documentation updates, runbook changes, policy drafts, API reference additions.
- **Owner role:** Technical Writer
- **Create when:** Docs changes frequent enough to clutter #general

### #performance
- **Purpose:** Frontend/backend performance profiling, optimization PRs, lighthouse scores, bundle size tracking, query plan analysis.
- **Create when:** Performance becomes a focus area (Phase 4+)

### #analytics
- **Purpose:** Product usage metrics, user behavior insights, funnel analysis, A/B test results.
- **Create when:** Analytics tooling added (post-MVP)

### #support
- **Purpose:** User questions, support tickets (when support system exists), FAQ updates.
- **Create when:** Stephen's email is no longer the support channel (post-public-launch growth)

---

## Channel Management Rules

### Naming conventions
- **Lowercase, hyphens only** (e.g., `#plaid-integrations`, not `#PlaidIntegrations` or `#plaid_integrations`)
- **Match repository language** — use terms from ADRs, decision register, role files, skills
- **No redundant prefixes** — `#dev-ops` not `#tmm-dev-ops` (the workspace is already TMM)

### Archiving policy
- Archive a channel when: its domain is deprecated, the phase is complete, or it's been inactive for 90+ days
- **Never delete** — archive preserves history

### Notification defaults
- **High-urgency (mention @channel sparingly):** #incidents, #announcements, #prod-ops
- **Medium (default notifications):** Domain channels, #releases, #code-reviews
- **Low (muted by default):** #watercooler, #ai-agents, #dev-ops

### Bots and integrations
- **GitHub:** Post PR opens/merges to #code-reviews; CI failures to #testing-qa
- **Vercel:** Deploy previews to #frontend-ux; prod deploys to #releases
- **Stripe (test mode):** Webhook events to #staging-ops
- **Supabase:** Migration status to #data-platform; usage alerts to #prod-ops
- **PagerDuty/monitoring:** Alerts to #incidents
- **No bots in #general or #announcements**

---

## Appendix: Channel-to-Role Mapping

| Channel | Primary Owner Role | Reviewer/Monitor Roles |
|---|---|---|
| #simulation | Simulation Engineer | QA Engineer, Chief Architect |
| #data-platform | Data Platform Engineer | Security Officer (for RLS), Chief Architect |
| #billing-entitlements | Billing Engineer | Security Officer, Product Strategist |
| #plaid-integrations | Plaid Integrations Engineer | Billing Engineer (for cost), Security Officer |
| #frontend-ux | Frontend/UX Engineer | QA Engineer, Product Strategist |
| #security-privacy | Security & Privacy Officer | All roles (security is everyone's job) |
| #releases | Release Manager | Chief Architect, QA Engineer |
| #incidents | Incident Commander (founder) | All on-call roles |
| #code-reviews | (Rotates per PR) | Paired reviewer per `review-gates.md` |
| #prod-ops | Release Manager | Founder (alerts routed to stephen3miller@gmail.com) |

---

## Getting Started

### For humans
1. Join all domain channels relevant to your focus areas
2. Mute #ai-agents and #dev-ops if too noisy
3. **Never mute #incidents or #announcements**
4. Set Slack status when on-call or unavailable for reviews

### For AI agents
1. Route findings/questions to the channel matching your role (see table above)
2. Cross-post to #code-reviews when a PR is ready for human review
3. Escalate to #incidents only if user-impacting or security-critical
4. Log operating-rule violations to #ai-errors, not #general
5. When uncertain which channel, default to the domain channel or ask in #general

---

**Effective:** 2026-07-04  
**Maintained by:** Chief Architect + Founder  
**Review cadence:** After each phase completion or when channel usage patterns shift  
**Source of truth:** This document (`docs/SLACK_CHANNELS.md`)
