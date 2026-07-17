# Security, Privacy, and Retention Plan

Implements ADR-7. Decisions: D15 (retention), D21–D24 (auth/MFA/deletion), D25–D27 (ops/legal identity), D30 (analytics). The audit's `security-and-privacy-audit.md` remains the finding-level evidence; this document is the post-decision plan.

## Security posture summary

TMM's baseline is genuinely strong for a pre-launch product (JWT auth everywhere, AES-256-GCM token encryption fail-closed in prod, Stripe signature verification, RLS with anon-deny, CORS allowlist, security headers, structured logging without token leakage). The plan below closes the specific gaps and locks the posture in with tests and process.

## Launch-blocking security work (all in Phases 1/4/5; Gate C blockers)

| Item | Ref | Phase |
|---|---|---|
| Plaid webhook `Plaid-Verification` JWT verification (key cache + rotation) | SEC-1/WH-P1 | 4.9 |
| Diagnostic endpoints removed or admin-gated | SEC-2 | 1.6 |
| Google OAuth `state` → signed, single-use, TTL, user-bound nonce | SEC-3 | 4.10 |
| Admin role (`profiles.role`) for ops routes + MFA-removal endpoint | SEC-4 | 4.11 |
| Secret scan over full repo + history (gitleaks-class, TS included) + rotation of anything found | SEC-5 | 0.4 |
| Deletion-cascade verification test (full-footprint user → zero rows) | privacy audit | 4.12 |
| HSTS enabled behind TLS host; prod refuses to boot with `TLS_INSECURE_SKIP_VERIFY` | SEC-7 | 5.4 |
| RLS anon-test green against **prod** project | audit min-bar 8 | Gate C |
| Privacy policy + ToS published with real operator identity | D26 | 5.8 |
| `plaidConfig.backendApiUrl` restricted to same-origin/allowlist; Finnhub key stripped from exports | SEC-6/10 | 4.13 |
| Turnstile production site key live on signup/login | D22 | 5.9 |

## Additional items from live infrastructure inspection (2026-07-03)

The Supabase security advisors on the dev project reported 70 warnings. These fold into Phase 5.9 and the clean baseline (Phase 2.1):

1. **Leaked-password protection disabled** — enable in Auth settings (all three projects).
2. **17 "RLS policy always true" warnings** — permissive service-role-era policies; the clean baseline rewrites them strictly (see `03-data-model-and-migration-plan.md` §RLS).
3. **GraphQL schema exposure** (public + signed-in can see all objects) — disable `pg_graphql` exposure for `anon`/`authenticated` or remove the extension if unused.
4. **6 functions with mutable `search_path`** (including `SECURITY DEFINER` ones) — pin `search_path` in the baseline.

## Auth policy (D22, D23)

- Methods: Google Sign-In (openid/email/profile) + Email OTP. Both stay; neither is removed.
- CAPTCHA: Cloudflare Turnstile on signup, login, and high-risk unauthenticated endpoints.
- MFA: TOTP optional for general access; **step-up required** for Plaid connect/reconnect, credential changes, future API-key management, and security-sensitive account actions. Not required for TMM+ subscription alone.
- Google **Sheets** OAuth is a separate consent flow with narrow scopes, beta-labeled until Google verification completes (D21/ADR-8). Never required for core product use.

## Data retention schedule (D15) — the single authoritative table

| Data class | Retention | Mechanism |
|---|---|---|
| Financial plans, transactions, imported history, alternatives, pipeline layouts, categories, goals | **Indefinite** — until user deletes it or their account | — |
| Plan revisions | Newest **20** per user | Prune on insert (live, `backend/lib/planHandlers.js`) |
| Stripe webhook events (`stripe_events`) | **90 days** | ✅ `run_retention_sweeps()` |
| Plaid webhook events | **90 days** | ✅ `run_retention_sweeps()` (pg_cron, daily 03:30 UTC) |
| Sync execution logs (`plaid_sync_runs`, finished `plaid_sync_jobs`) | **30 days** | ✅ `run_retention_sweeps()` |
| Plaid link intents | **90 days** | ✅ `run_retention_sweeps()` |
| Rate-limit buckets (`usage_counters`) | **30 days** | ✅ `run_retention_sweeps()` |
| Connection audit events (`plaid_connection_events`) | **1 year** | ✅ `run_retention_sweeps()` |
| Audit/security logs (`audit_log`) | **1 year** | ✅ `run_retention_sweeps()` |
| OAuth state nonces (`oauth_states`) | **Expiry + 1 day** (10-min TTL) | ✅ `run_retention_sweeps()` |
| Waitlist entries (`waitlist`) | Indefinite until served/removed; cascade on account deletion | — |
| Invite codes (`invites`) | Indefinite (redemptions are billing evidence); `redeemed_by` nulls on account deletion (documented exception) | — |
| Catalog/entitlement config (`plan_catalog`, `tier_entitlements`, `app_settings`) | Indefinite (operational config, no user data) | — |
| User-deleted plans/accounts | **30-day soft delete**, then permanent purge | Soft-delete flag + sweep |
| Plaid access tokens | **30 days after premium access ends**; immediately on account deletion | Lifecycle sweep (ADR-6) |
| Encrypted infrastructure backups (Supabase Pro daily backups; PITR once enabled at first Plaid invoice) | Provider's normal window; never used for account restoration | Supabase-managed |

This table feeds the privacy policy verbatim and replaces the template's placeholders in `docs/security/DATA_RETENTION_AND_DELETION_POLICY.md`.

## Account deletion (D24)

Processed **immediately on confirmation**:

1. Account becomes inaccessible; active sessions invalidated.
2. Plaid items revoked, tokens deleted (immediate, not 30-day path).
3. User data enters the deletion workflow (cascade via FKs; 30-day soft-delete window applies to recoverable artifacts only where the policy says so — the privacy policy language must match what the code does; verify during 5.8).
4. Backup copies expire on the provider's normal schedule and are never used operationally.

Verification: the full-footprint cascade test (Phase 4.12) is the evidence this promise is true.

## Logging and telemetry rules

- **Never log:** tokens (any kind), plan contents, account numbers, transaction descriptions, webhook raw payload bodies at info level.
- Telemetry may include: userId, institution *names*, error codes/text, correlation IDs (existing middleware).
- These rules move into `tmm-workforce/operating-rules.md` and are enforced in code review.
- Analytics: privacy-respecting **pageviews only** (D30); disclosed in the privacy policy. No session replay, no funnels, no third-party ad pixels.

## Legal and operational identity (D25–D28)

- Operator: **Stephen Miller** (individual), contact **stephen3miller@gmail.com** — used in privacy policy, ToS, security contact, Stripe and Plaid registrations. Documents structured so an LLC can be substituted later without substantive rewrites.
- All alerts (Sentry, uptime, Stripe, Plaid, Supabase usage) route to the founder email. No 24/7 SLA published; critical incidents ASAP, support first-response 2–4 business days.
- Incident comms: email at launch; `status.tmm.finance` planned post-growth (D27) — the incident runbook references "the status channel" abstractly so the page can slot in later.

## Fill-the-templates checklist (Phase 5.8)

`docs/security/` currently holds intended-control **templates**. Each needs: real operator identity, the D15 retention table, the D24 deletion SLA, the ADR-6 Plaid token story, MFA policy (D23), and removal of controls we do not actually implement (honesty rule: policy documents describe reality). Priority order: `PRIVACY_POLICY.md`, ToS, `SECURITY_CONTACTS.md`, `DATA_RETENTION_AND_DELETION_POLICY.md`, `INCIDENT_RESPONSE_PLAN.md`, then the Plaid questionnaire packet refresh (production is approved, but the packet should reflect shipped reality for future reviews).
