# Slack Channels — Quick Reference

**Full documentation:** [`docs/SLACK_CHANNELS.md`](./SLACK_CHANNELS.md)

## Essential Channels (Join These First)

| Channel | Purpose | Mute? |
|---------|---------|-------|
| **#general** | Team-wide updates, cross-cutting decisions | No |
| **#announcements** | Founder announcements, launches, incidents | **Never** |
| **#incidents** | Production incident alerts & coordination | **Never** |
| **#code-reviews** | PR reviews, gate sign-offs | No |
| **#releases** | Deploy notifications, gate execution | No |

## Domain Channels (Join Based on Your Focus)

| Channel | When to Join |
|---------|--------------|
| **#simulation** | Working on ledger engine, domain model, checkpoints, golden tests |
| **#data-platform** | Supabase schema, migrations, RLS, plan persistence |
| **#billing-entitlements** | Stripe, entitlements, tiers, grace/dunning, waitlist |
| **#plaid-integrations** | Plaid Link, sync worker, item lifecycle, Google Sheets OAuth |
| **#frontend-ux** | React app, UI components, save UX, Vercel deploys |
| **#security-privacy** | Security reviews, RLS tests, secrets, privacy policy |
| **#testing-qa** | Test strategy, CI/CD, property tests, QA checklists |

## Operations Channels

| Channel | Who Needs It |
|---------|--------------|
| **#dev-ops** | Everyone (local dev troubleshooting) |
| **#staging-ops** | QA, Release Manager, Integration test watchers |
| **#prod-ops** | Founder, On-call only (monitoring, usage, costs) |

## AI Workflow Channels

| Channel | Purpose | Mute? |
|---------|---------|-------|
| **#ai-agents** | Agent task logs, subagent coordination | Optional (can be noisy) |
| **#ai-errors** | Agent failures, rule violations, skill issues | No (needed for tuning) |

## Optional Channels

- **#watercooler** — Off-topic, unmonitored
- **#postmortems** — Incident retrospectives (low-volume, high-value)
- **#docs** — Documentation changes (future)
- **#performance** — Optimization work (future)
- **#analytics** — Product metrics (post-MVP)
- **#support** — User questions (when support scales beyond email)

---

## Quick Rules

✅ **Do:**
- Route questions to the domain channel (e.g., migration Q → #data-platform)
- Post PR links in #code-reviews when ready for human review
- Use threads for discussions in high-signal channels
- Set Slack status when on-call or OOO

❌ **Don't:**
- Post secrets, tokens, or PII anywhere (even redacted)
- Use @channel in domain channels (reserved for #incidents, #announcements, #prod-ops)
- Chitchat in #incidents during an active incident
- Let #incidents or #announcements notifications go unread

---

## For AI Agents

**Before posting, ask:**
1. Is this a PR ready for review? → #code-reviews
2. Is this a production incident? → #incidents
3. Does this relate to a specific domain (simulation, billing, Plaid, etc.)? → Domain channel
4. Is this an agent error or rule violation? → #ai-errors
5. Is this general coordination? → #general

**Escalation path:** Domain channel → #code-reviews (if PR) → #incidents (if prod impact)

**Never log:** Tokens, plan contents, account numbers, transaction descriptions, encryption keys, raw webhook payloads (see `tmm-workforce/operating-rules.md` §Never-log list)

---

**See full channel list, purposes, and management rules in [`docs/SLACK_CHANNELS.md`](./SLACK_CHANNELS.md)**
