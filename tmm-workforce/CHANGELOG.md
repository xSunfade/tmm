# TMM Workforce & Documentation Changelog

This file tracks significant additions and changes to the TMM workforce model, skills, and supporting documentation.

---

## 2026-07-04 — Slack Workspace Channels Defined

**Added:**
- `docs/SLACK_CHANNELS.md` — Complete channel structure, purposes, management rules, and channel-to-role mappings for the TMM Slack workspace
- `docs/SLACK_QUICK_REFERENCE.md` — Quick lookup table for essential channels, domain channels, and AI agent routing logic

**Context:**
Slack channels now mirror the repository architecture:
- **Domain channels** align with `tmm-workforce/roles/` and `.cursor/skills/` (e.g., #simulation, #billing-entitlements, #plaid-integrations)
- **Process channels** support release gates, code reviews, and incident response (#releases, #code-reviews, #incidents)
- **Environment channels** separate dev/staging/prod operations (#dev-ops, #staging-ops, #prod-ops)
- **AI workflow channels** enable agent coordination and error tracking (#ai-agents, #ai-errors)

**Design principles:**
1. Channels match code architecture (ADRs, decision register, domain boundaries)
2. High-stakes channels are alert-only (#incidents, #prod-ops)
3. AI-friendly naming (matches skill and role terminology)
4. Environment isolation (staging/prod have dedicated channels)
5. Public by default (no credentials/PII in any channel)

**Integration points:**
- AI agents route questions/findings to domain channels matching their role
- PR reviews flow through #code-reviews with paired reviewer assignments per `review-gates.md`
- Incidents escalate to #incidents with Incident Commander coordination
- Automated CI/deploy/monitoring alerts post to appropriate channels

**See also:**
- `tmm-workforce/operating-rules.md` §Communication rules (founder email is alert sink)
- `tmm-workforce/review-gates.md` (reviewer pairings now mapped to Slack channels)
- `docs/security/INCIDENT_RESPONSE_PLAN.md` (references #incidents channel)

---

## Previous Changes

(Changelog starts 2026-07-04. For earlier TMM workforce history, see git log on `tmm-workforce/` folder.)
