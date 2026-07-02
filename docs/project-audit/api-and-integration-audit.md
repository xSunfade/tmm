# API and Integration Audit

Covers the backend API surface, external services (Plaid, Google Sheets, Stripe, Finnhub, Supabase), environment variables, and failure modes. Webhooks and payments have dedicated docs.

## API surface (confirmed from `backend/server.js`)

~55 routes, all registered flat in one file. Auth tiers:

| Tier | Routes |
|---|---|
| **Unauthenticated** | `/`, `/api/health`, `/api/diag/supabase`, `/api/diag/plaid`, `/api/google/oauth/callback`, both webhooks |
| **JWT (`requireAuth`)** | Stripe checkout/portal, all Google Sheets routes, history routes, privacy routes, MFA removal |
| **JWT + TMM+ (`requireTmmPlus`)** | All ~20 Plaid routes, `/api/ops/plaid/*` |

Auth = Supabase Bearer JWT verified via `supabase.auth.getUser(token)` per request (`backend/middleware/auth.js`). No server-side sessions. Tier read from `profiles.plan_tier` via service-role client.

### Findings

1. **Unauthenticated diagnostics — High.** `/api/diag/supabase` probes DB tables; `/api/diag/plaid` can create a real Plaid link token. These leak infrastructure state and consume Plaid quota anonymously. *Recommendation:* remove, or gate behind an admin secret. Effort: 1 hour. Acceptance: anonymous requests get 401/404 in production.
2. **`optionalAuth` is exported but never used** (`middleware/auth.js` lines 120–139) — dead code.
3. **Per-request `getUser` call to Supabase** — every authenticated request costs a round-trip to Supabase Auth. Acceptable at MVP scale; consider local JWT verification (JWKS) later. *Priority: Low.*
4. **Error shape is mostly consistent** (`{ error, message?, code? }`, zod issues array, Plaid error passthrough with request_id). Good. Document it once and freeze it.
5. **Validation coverage is uneven** — zod on newer Plaid routes; manual checks on Google/Stripe/history routes. Body size capped at 256 KB, request timeout 30 s (good).

## Plaid (confirmed)

- Client credentials via env; environment defaults `sandbox`.
- Link flow: `create-link-token` (item caps: 5 default, safety ceiling 10, weekly velocity limit) → Link → `exchange-token` with **link-intent idempotency** (required by default) and duplicate-institution fingerprinting.
- Access tokens AES-256-GCM encrypted at rest (`tokenStore.js`; key must be 64 hex chars, fail-closed in production).
- Sync: cursor-based `/transactions/sync` with pagination-mutation retry, DB job queue with dedupe keys, in-process worker (2 s poll, 5 attempts, backoff), global DB-backed circuit breaker (5 failures/120 s → 60 s open), atomic apply via Postgres RPC.
- Failure modes: Plaid API errors are forwarded with status + `error_code` + `request_id` — good for debugging, and reasonable to expose to an authenticated user.
- **Gap — High:** webhook has no signature verification (see `webhooks-and-events-audit.md`).
- **Gap — Medium:** ops routes (`/api/ops/plaid/*`) are gated by *paid tier*, not an admin role. Any TMM+ subscriber can read operational health data. Decide whether that data is user-scoped only (it appears mostly user-filtered, but the breaker state is global).

## Google Sheets (confirmed)

- Backend-proxied: the browser never calls Google APIs directly except the Picker (which fetches a short-lived access token from `/api/google/token-for-picker`).
- OAuth tokens encrypted at rest (`storage/googleTokens.js`), refresh handled server-side; 25 s fetch timeout.
- **In progress (uncommitted):** retry with exponential backoff + `Retry-After` on 429/503 (max 4 retries, ~15 s worst case), a `valuesBatchUpdate` endpoint to collapse per-row writes into one quota-costing call, and a 45 s client timeout to outlast the backoff. This is good work — finish and commit it with its new unit test (`tests/unit/sheets-diff.test.ts` is currently untracked).
- **Gap — High (security):** OAuth `state` is the raw user UUID and the callback trusts it without any session binding (`server.js` ~lines 1436, 1983–1998). An attacker who obtains/guesses a user ID could potentially bind *their* Google account to the victim's TMM account (login CSRF / account-linking fixation). *Recommendation:* signed, single-use, expiring state nonce stored server-side. Effort: 0.5–1 day. Acceptance: callback rejects unknown/expired/replayed state.
- **Gap — Medium:** `GOOGLE_*` env vars are used by `config.js` but absent from `backend/.env.example` — new environments will silently miss them.

## Stripe

See `payments-and-stripe-readiness.md`. Summary: checkout/portal/webhook exist with signature verification; missing failed-payment states, price verification, and subscription ID persistence.

## Finnhub

`frontend/src/lib/finnhub/tickerSearch.ts` — ticker search using an API key stored **in the plan itself** (`assumptions.finnhubKey`, entered by the user in settings). Confirmed: the key lives in localStorage and in Google Sheets exports. *Risk: users pasting a paid key then exporting/sharing the sheet leaks it.* **Recommendation (Medium):** exclude secrets from Sheet/XLSX export, or proxy Finnhub through the backend for MVP.

## Supabase

- Frontend uses anon key (`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`, throws if missing).
- Backend uses publishable key for auth verification + **service-role key for effectively all DB access** (bypasses RLS). RLS policies exist and matter for the anon/browser path, but server bugs are unmitigated by RLS. Keep the service key strictly server-side (currently true).

## Environment variables

### Backend (from `config.js`; ✗ = missing from `.env.example`)

| Group | Vars | Behavior if missing |
|---|---|---|
| Core | `NODE_ENV`, `PORT`, `CORS_ORIGIN`, `REQUEST_TIMEOUT_MS`, `JSON_BODY_LIMIT`, `ENABLE_HSTS` | CORS_ORIGIN required in prod (throws) |
| Supabase | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | First two throw at import in prod; secret key → null admin client, runtime 500s |
| Plaid | `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENVIRONMENT`, ✗`PLAID_WEBHOOK_URL`, ✗~15 `PLAID_SYNC_*`/`PLAID_BREAKER_*`/cap flags | `plaidClient.js` throws at import (even in dev — see FRAGILE-5) |
| Google | ✗`GOOGLE_CLIENT_ID`, ✗`GOOGLE_CLIENT_SECRET`, ✗`GOOGLE_OAUTH_REDIRECT_URI`, ✗`GOOGLE_OAUTH_FRONTEND_REDIRECT`, ✗`GOOGLE_OAUTH_SCOPES` | Sheets routes fail at runtime |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_TMM_PLUS` | Billing routes return 503 (clean) |
| Crypto | `TOKEN_ENCRYPTION_KEY` (64 hex) | Prod: throws when used; dev: random ephemeral key (tokens unreadable after restart) |
| Dev/test | `TLS_INSECURE_SKIP_VERIFY`, `VALIDATION_MODE`, `I_ACK_PROD`, `RUN_PLAID_WORKER`, etc. | Defaults |

### Frontend

`VITE_SUPABASE_URL`*, `VITE_SUPABASE_ANON_KEY`*, `VITE_API_BASE_URL` (optional; empty = same-origin proxy), `VITE_GOOGLE_CLIENT_ID` (Picker), `VITE_AUTH_CAPTCHA_SITE_KEY` (✗ not in `.env.example`), dev-only onboarding overrides. `VITE_LEGACY_APP_URL`/`VITE_LEGACY_AUTH_URL` are in `.env.example` but **unused in src** — remove.

### Recommendations

- **ENV-1 (High, ~2 h):** make `.env.example` files complete and authoritative; add a startup config validator that prints one clear table of missing/invalid vars and refuses to boot in production. Acceptance: fresh clone + filled `.env.example` boots with zero surprise runtime failures.
- **ENV-2 (Medium, ~1 h):** document exactly one production topology (which host serves the SPA, which serves the API, what `VITE_API_BASE_URL` and `CORS_ORIGIN` must be) in `docs/backend/README.md` and delete the stale root `vercel.json`.

## Cross-cutting failure-mode gaps

1. **No retry/backoff on Plaid API calls from route handlers** (the breaker protects against storms, but individual user actions fail immediately on transient errors). Acceptable for MVP; the frontend shows Plaid errors.
2. **No request-level idempotency keys on mutating client APIs** (e.g., double-click on "archive snapshot" writes twice). Low priority; most writes are naturally idempotent upserts.
3. **`authFetch` (main API) and `sheets/api.ts` (Sheets) are two parallel auth stacks** with separate token caches and timeouts. Consolidate eventually (Low).
4. **Backend API docs (`docs/backend/README.md`) are outdated** — show `userId` in request bodies and omit auth requirements. Regenerate from the route table in this audit (Medium, doc-only).
