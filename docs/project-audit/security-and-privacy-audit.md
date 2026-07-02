# Security and Privacy Audit

Assume real financial data and paid users. This doc lists what's solid, what must change before public release, and the minimum bar.

## What is already solid (confirmed from code — keep)

- Supabase JWT auth on all user routes; webhooks explicitly reject Bearer tokens.
- Plaid + Google tokens encrypted at rest with AES-256-GCM; key format validated; **fail-closed in production** if `TOKEN_ENCRYPTION_KEY` missing.
- Stripe webhook signature verification.
- TOTP MFA with a 30-day step-up gate before Plaid-sensitive actions.
- CORS allowlist (throws in prod if unset), 256 KB body limit, 30 s request timeout, security headers (nosniff, DENY framing, no-referrer, optional HSTS), rate limiting (in-memory), correlation IDs, structured logging that does not log raw tokens.
- RLS policies on user-facing tables with explicit anon-deny; frontend uses anon key only; service-role key confined to backend.
- Privacy plumbing: consent recording, deletion request cascade, retention policy docs.
- CI: CodeQL + weekly npm audit + Dependabot.

This is a notably better baseline than most pre-launch projects. The issues below are specific and fixable.

## Must fix before public release

### SEC-1: Plaid webhook accepts unauthenticated POSTs — Critical

No `Plaid-Verification` JWT check. Forged revocation webhooks can trigger cleanup (data deletion vector); forged sync webhooks burn Plaid quota. Full detail + acceptance criteria in `webhooks-and-events-audit.md` (WH-P1). **Effort:** 1–2 days.

### SEC-2: Unauthenticated diagnostic endpoints — High

`GET /api/diag/supabase` (DB probe) and `GET /api/diag/plaid` (can create real link tokens) are open to the internet. Remove or admin-gate. **Effort:** 1 hour. **Acceptance:** anonymous access returns 401/404 in production.

### SEC-3: Google OAuth `state` is the raw user UUID — High

`server.js` (~1436, ~1983): callback trusts `state` as the user id with no signing, expiry, or session binding → account-linking CSRF/fixation risk (attacker links a victim's TMM account to an attacker-controlled Google account, or vice versa). Use a signed single-use nonce (stored server-side with TTL, bound to the user). **Effort:** 0.5–1 day. **Acceptance:** replayed/expired/foreign state rejected; test added.

### SEC-4: Ops endpoints gated by paid tier, not admin role — High

`/api/ops/plaid/*` and `POST /api/auth/mfa/remove-factor` use tier/user checks. Ops data is mostly user-scoped but the circuit-breaker state is global; more importantly, the pattern invites future mistakes. Introduce an explicit admin allowlist (e.g., `ADMIN_USER_IDS` env or `profiles.role`) for ops routes. **Effort:** 0.5 day.

### SEC-5: Secrets hygiene verification — High (process)

`scripts/verify-no-secrets.sh` scans only `*.js` and misses the entire TypeScript frontend; `run-audit-verification.sh` checks wrong paths. Fix scripts, run a proper scan (e.g., gitleaks) once over the repo, and — because history is a single commit — this is the cheapest possible moment to rotate anything that was ever pasted into a file. **Unknown:** whether any real keys exist in local `.env` files that were ever committed elsewhere. **Effort:** 0.5 day.

### SEC-6: Client trust boundary for entitlements — Medium

Tier gating is enforced server-side (good). But `plan.plaidConfig.backendApiUrl` is user-editable plan data used as an API base URL in places — a crafted imported plan/sheet could point a victim's client at an attacker's API host (token exfiltration via Bearer header). Verify every use of `plaidConfig.backendApiUrl` and restrict to same-origin or an allowlist. **Inferred from code — verify exact call sites.** **Effort:** 0.5 day. **Acceptance:** imported plans cannot redirect authenticated traffic.

### SEC-7: `TLS_INSECURE_SKIP_VERIFY` — Medium

Dev-only by construction (`isDevelopment &&`), but it sets `NODE_TLS_REJECT_UNAUTHORIZED=0` process-wide. Keep, but add a startup refusal if `NODE_ENV=production` ever sees it set, so a copy-pasted env file can't disable TLS verification in prod. **Effort:** 15 min.

## Should fix soon after launch

| ID | Item | Priority |
|---|---|---|
| SEC-8 | Rate limiting is per-process memory — fine for a single instance; revisit with scale (see architecture plan). Also add per-user (not just per-IP) limits on expensive routes (Sheets writes, history posts — history POST already has one). | Medium |
| SEC-9 | CSP header absent. A strict CSP is hard with Google Picker + Plaid Link CDNs but valuable; start with `frame-ancestors`, `object-src`, and a report-only policy. | Medium |
| SEC-10 | Finnhub API key stored in plan → exported to Sheets/XLSX (see API audit). Strip secrets from exports or proxy Finnhub. | Medium |
| SEC-11 | Per-request `supabase.auth.getUser` — availability coupling to Supabase Auth on every request. Local JWKS verification later. | Low |
| SEC-12 | Dependency surface: `xlsx` (SheetJS) has a history of prototype-pollution advisories; it parses untrusted user uploads. Keep pinned + audited; parse imports defensively (already goes through migrate/normalize). | Medium |
| SEC-13 | Logging: telemetry includes userId, institution names, error text. No token logging observed (good). Write a one-page "never log" list (tokens, plan contents, account numbers) and enforce in review. | Low |

## Privacy posture

- Consent + deletion tables and endpoints exist (`backend/models/privacy.js`, migration 014). **Verify the deletion cascade actually covers all user tables added after 014** (net_worth_points_alt, connection events, link intents, etc.) — **needs verification**; add a test that creates a full-footprint user and asserts zero rows remain post-deletion. (High, 1 day.)
- `docs/security/PRIVACY_POLICY.md` and retention policy are **templates** — they need real entity names, contact addresses, and legal review before public users. Plaid production access also requires the security questionnaire packet (drafted, dated 2026-02-09) to reflect reality.
- Data minimization: transactions and balances are stored server-side for TMM+ users; the plan (after DATA-1) will be too. Say so plainly in the privacy policy; offer XLSX export + deletion as the user's controls (both exist).

## Minimum security bar before public release (checklist)

1. SEC-1 Plaid webhook verification ✅ required
2. SEC-2 diag endpoints removed/gated ✅ required
3. SEC-3 OAuth state hardened ✅ required
4. BUG-2/BUG-3 token lifecycle fixes (see stability audit) ✅ required
5. SEC-5 secret scan + rotation pass ✅ required
6. Deletion-cascade verification test ✅ required
7. HSTS enabled (`ENABLE_HSTS=true`) behind TLS-terminating host ✅ required
8. Supabase: confirm RLS enabled on every table containing user data (run `tests/security/rls-anon-test.js` against prod project) ✅ required
9. Real privacy policy + terms published ✅ required
10. Admin gating (SEC-4) — strongly recommended
