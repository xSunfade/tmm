# Slack Workspace Setup Checklist

**Use this checklist when creating the TMM Slack workspace channels for the first time.**

**Reference:** [`docs/SLACK_CHANNELS.md`](./SLACK_CHANNELS.md) (full channel descriptions and purposes)

---

## Phase 1: Essential Channels (Create These First)

### Core Project Channels

- [ ] **#general**
  - Description: "Team-wide updates, cross-cutting decisions, weekly progress summaries"
  - Default: All members auto-join
  - Notifications: Default

- [ ] **#announcements**
  - Description: "High-signal founder announcements: launches, security notices, planned downtime (threads only for replies)"
  - Posting permissions: Founder only
  - Default: All members auto-join
  - Notifications: All messages (never mute)

- [ ] **#watercooler**
  - Description: "Off-topic, non-work conversation. Optional participation."
  - Notifications: Muted by default

### Critical Process Channels

- [ ] **#incidents**
  - Description: "🚨 Production incident alerts and coordination. Alert-only during active incidents. See docs/security/INCIDENT_RESPONSE_PLAN.md"
  - Notifications: All messages (never mute)
  - Pin: Link to INCIDENT_RESPONSE_PLAN.md

- [ ] **#releases**
  - Description: "Gate execution (A→B→C→D), deploy notifications, rollback procedures. Every prod deploy gets before/after messages here."
  - Notifications: Default
  - Pin: Link to project-roadmap/10-launch-readiness-gates.md

- [ ] **#code-reviews**
  - Description: "PR review requests, reviewer assignments, gate sign-offs. See tmm-workforce/review-gates.md for pairings."
  - Notifications: Default
  - Pin: Link to tmm-workforce/review-gates.md

---

## Phase 2: Domain Channels (Architecture-Aligned)

### Technical Domain Channels

- [ ] **#simulation**
  - Description: "Ledger engine, domain model (ADR-2), checkpoint/position semantics, property tests, golden fixtures. Owner: Simulation Engineer"
  - Topic: "Skill: tmm-simulation-correctness | Never log: test credentials, user plan data"
  - Notifications: Default

- [ ] **#data-platform**
  - Description: "Supabase schema, migrations, RLS policies, plan persistence, retention sweeps. Owner: Data Platform Engineer"
  - Topic: "Skill: tmm-supabase-migrations | Environments: dev mkhmaqksodfwccheflpw / staging / prod"
  - Notifications: Default

- [ ] **#billing-entitlements**
  - Description: "Stripe webhooks, entitlements, tiers, grace/dunning, waitlist. Owner: Billing Engineer"
  - Topic: "Skill: tmm-stripe-entitlements | Never log: Stripe secret keys, customer emails/cards"
  - Notifications: Default

- [ ] **#plaid-integrations**
  - Description: "Plaid Link, sync worker, item lifecycle (connect→suspend→revoke), webhooks, Google Sheets OAuth. Owner: Plaid Integrations Engineer"
  - Topic: "Skill: tmm-plaid-lifecycle | ADR-6 state machine"
  - Notifications: Default

- [ ] **#frontend-ux**
  - Description: "React app, UI components, save-truth UX, accessibility, Vercel deploys. Owner: Frontend/UX Engineer"
  - Topic: "Vercel previews post here | Silent-failure elimination"
  - Notifications: Default

- [ ] **#security-privacy**
  - Description: "Security reviews, RLS verification, secrets handling, privacy policy, SEC-x audit items. Owner: Security & Privacy Officer"
  - Topic: "Skill: tmm-security-review | Public channel (security by design, not obscurity)"
  - Notifications: Default

- [ ] **#testing-qa**
  - Description: "Test strategy, CI/CD status, property tests, golden fixtures, QA checklists. Owner: QA Engineer"
  - Topic: "CI failures post here | Golden fixture changes require explanation"
  - Notifications: Default

---

## Phase 3: Operations Channels

### Environment Channels

- [ ] **#dev-ops**
  - Description: "Local & dev environment troubleshooting, dependency upgrades, dev Supabase changes, dev tooling"
  - Notifications: Muted by default

- [ ] **#staging-ops**
  - Description: "Staging environment status, integration tests, Stripe test-mode webhooks, Plaid sandbox, rehearsal deploys"
  - Topic: "Supabase staging project | Stripe test mode | Plaid sandbox"
  - Notifications: Default

- [ ] **#prod-ops**
  - Description: "Production observability, monitoring alerts, usage metrics, cost alerts, backup verifications. Founder/on-call only."
  - Topic: "RESTRICTED: Prod-access roles only | Alerts → stephen3miller@gmail.com"
  - Notifications: All messages (for founder/on-call)
  - Members: Founder only initially (add on-call roles as team grows)

---

## Phase 4: AI Workflow Channels

- [ ] **#ai-agents**
  - Description: "AI agent task logs, subagent launches, handoff summaries, skill invocations, multi-agent coordination"
  - Topic: "Can be noisy — mute if preferred, but useful for async visibility"
  - Notifications: Muted by default

- [ ] **#ai-errors**
  - Description: "AI agent failures, skill misapplications, hallucinations, operating-rule violations. Use for workforce tuning."
  - Topic: "Patterns here → rule additions or skill refinements"
  - Notifications: Default

- [ ] **#postmortems**
  - Description: "Completed incident postmortems, bug retrospectives, near-miss analyses, lessons learned. Use threads for discussion."
  - Notifications: Default

---

## Phase 5: Optional / Future Channels (Create As Needed)

- [ ] **#docs** — Documentation updates, runbook changes, policy drafts
  - When: Docs changes frequent enough to clutter #general

- [ ] **#performance** — Performance profiling, optimization PRs, bundle size tracking
  - When: Performance becomes a focus area (Phase 4+)

- [ ] **#analytics** — Product usage metrics, funnel analysis, A/B tests
  - When: Analytics tooling added (post-MVP)

- [ ] **#support** — User questions, support tickets, FAQ updates
  - When: Stephen's email is no longer the support channel (post-public-launch growth)

---

## Bot Integrations (Configure After Channel Creation)

### GitHub Integration

- [ ] Configure GitHub app for TMM workspace
- [ ] Route PR open/merge events → **#code-reviews**
- [ ] Route CI failures → **#testing-qa**
- [ ] Suppress noisy events (comments, PR reviews) — those stay in GitHub

### Vercel Integration

- [ ] Configure Vercel app for TMM workspace
- [ ] Route deploy preview URLs → **#frontend-ux**
- [ ] Route production deploy success/failure → **#releases**

### Monitoring / Alerting (When Set Up)

- [ ] Route PagerDuty/UptimeRobot alerts → **#incidents**
- [ ] Route Supabase usage/health alerts → **#prod-ops**
- [ ] Route Stripe live-mode webhook failures → **#billing-entitlements**
- [ ] Route cost threshold alerts (Supabase/Vercel/Plaid) → **#prod-ops**

### Supabase (If Webhook Support Exists)

- [ ] Route migration status (dev/staging/prod) → **#data-platform**

---

## Workspace Settings

### General Settings

- [ ] Workspace name: "TMM" or "The Money Machine"
- [ ] Workspace URL: `tmm.slack.com` (or similar)
- [ ] Default channels for new members: #general, #announcements, #code-reviews

### Permissions

- [ ] **#announcements:** Posting restricted to admins/founder only
- [ ] **#prod-ops:** Private channel, founder + on-call only (or public with restricted posting)
- [ ] All other channels: Public, any member can post

### Notifications Best Practices

- [ ] Document in workspace pinned message: "Never mute #incidents or #announcements"
- [ ] Suggest muting #watercooler, #dev-ops, #ai-agents for focus

### Channel Topic Templates

Use these templates for consistent channel topics:

```
Domain channel template:
"Owner: [Role Name] | Skill: [skill-name] | See docs/SLACK_CHANNELS.md for full purpose"

Ops channel template:
"Environment: [dev/staging/prod] | Authority: [per operating-rules.md §1]"

Process channel template:
"See [doc-path] for procedures | [Key constraint or never-log reminder]"
```

---

## Post-Setup Verification

- [ ] All Phase 1 channels created and configured
- [ ] All Phase 2 domain channels created (7 channels)
- [ ] All Phase 3 ops channels created (3 channels)
- [ ] All Phase 4 AI workflow channels created (3 channels)
- [ ] GitHub integration posting to correct channels
- [ ] Vercel integration posting to correct channels
- [ ] Founder can post to #announcements; others cannot
- [ ] #prod-ops restricted to founder/on-call
- [ ] All channel descriptions match SLACK_CHANNELS.md
- [ ] Pinned messages added to #incidents, #releases, #code-reviews

---

## Maintenance

**Review channel structure:**
- After each phase completion (project-roadmap phases 0–6)
- When new roles added to `tmm-workforce/roles/`
- When usage patterns reveal missing/redundant channels

**Archive channels when:**
- Domain deprecated
- Phase complete and no ongoing work
- Inactive for 90+ days

**Update this checklist when:**
- New channels added to SLACK_CHANNELS.md
- Bot integrations change
- Workspace grows and new roles/teams need dedicated channels

---

**Completed:** [ ] Initial workspace setup complete (Phases 1–4)

**Date completed:** ___________

**Completed by:** ___________

**See:** `docs/SLACK_CHANNELS.md` for full documentation and management rules
