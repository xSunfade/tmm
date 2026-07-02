# TMM Architecture (Current) — Plaid Review Packet

Last updated: 2026-02-11

## Overview

TMM is a full-stack financial planning application with a security-first integration to Plaid and Supabase.

- **Frontend**: Vite + React (browser)
- **Identity**: Supabase Auth (Magic Link OTP + Google OAuth)
- **Backend**: Express (server-side Plaid + token encryption + durable webhooks + history ops)
- **Database**: Supabase Postgres (RLS enabled)
- **External services**:
  - **Plaid** (Link, Transactions Sync, webhooks)
  - **Google Sheets** (user-authorized persistence/export)

This document reflects the system **as implemented today** (not aspirational).

## Trust boundary map (runtime)

```mermaid
graph TB
  subgraph publicInternet [Public Internet]
    Browser[Browser (React App)]
  end

  subgraph backendRuntime [Backend Runtime]
    Express[Express API]
  end

  subgraph externalServices [External Services]
    Plaid[Plaid API]
    Sheets[Google APIs (OAuth + Sheets + Drive Picker)]
  end

  subgraph supabaseCloud [Supabase Cloud]
    SupabaseAuth[Supabase Auth]
    SupabaseDB[(Supabase Postgres)]
  end

  Browser -->|"TLS + JWT (Authorization: Bearer)"| Express
  Browser -->|"Supabase Auth SDK"| SupabaseAuth
  Browser -->|"Supabase public key (RLS) — limited tables"| SupabaseDB
  Express -->|"Supabase service role (server-only)"| SupabaseDB
  Express -->|"ClientId+Secret (server-only)"| Plaid
  Browser -->|"OAuth (user token)"| Sheets
```

## Identity & access management (current)

### Consumer authentication (Supabase Auth is live)

- Users sign in via:
  - Magic Link OTP (`frontend/src/components/overlays/AuthScreen.tsx`)
  - Google OAuth (`frontend/src/components/overlays/AuthScreen.tsx`)
- The frontend uses the Supabase session/JWT for authenticated calls to the backend (via `Authorization: Bearer <jwt>`).
- The backend validates JWTs per-request (`backend/middleware/auth.js` `requireAuth`).

### Authorization and feature gating

- **Plan tier gate (TMM+)**: the backend enforces Plaid access for TMM+ users only (`requireTmmPlus` in `backend/middleware/auth.js`), based on `profiles.plan_tier`.
- The frontend also reads `profiles.plan_tier` to render the correct UI (`frontend/src/app/providers/AuthProvider.tsx`).

### Consumer MFA step-up before Plaid Link

For Plaid review requirements, TMM enforces step-up MFA before surfacing Plaid Link:

- MFA helper: `frontend/src/lib/security/mfa.ts`
- Enforcement gate (before “Connect with Plaid”): `frontend/src/features/accountIntegration/AccountIntegrationScreen.tsx`
- TOTP enrollment UX: `frontend/src/features/settings/SettingsScreen.tsx`

### Consent gate before Plaid Link

TMM requires just-in-time consent before initiating Plaid Link:

- Backend endpoints: `GET /api/privacy/consent-status`, `POST /api/privacy/consent`
- Frontend gate: `frontend/src/features/accountIntegration/AccountIntegrationScreen.tsx`
- Storage: `privacy_consents` table (migration `backend/supabase/migrations/014_privacy_consent_and_deletion.sql`)

## Data stores (what lives where)

### Supabase tables (high level)

Plaid integration and durability:

- `plaid_tokens` (encrypted access tokens; user-scoped; server-only access)
- `accounts`, `transactions` (synced financial data; server-only access)
- `plaid_sync_runs` (idempotency + observability)
- `plaid_webhook_events` (durable webhook receipt + dedupe)
- `plaid_item_status` (item health + update-mode requirement)

Identity/product state:

- `profiles` (plan tier + history timezone; user-owned RLS access)
- `google_sheets_tokens` (encrypted Google tokens for Sheets/Picker flows)
- `user_onboarding` (tour/onboarding state)

Privacy:

- `privacy_consents`
- `data_deletion_requests`

History/ops:

- `account_balance_snapshots`, `net_worth_points`, `history_reconciliation_overrides`

### Google Sheets

TMM supports exporting/persisting plan data to Google Sheets using user-authorized OAuth. The backend also supports Google OAuth/token persistence flows for picker operations (see `/api/google/*` routes in `backend/server.js`).

## Supabase RLS posture (current)

RLS is enabled broadly. The system intentionally separates **user-visible app state** from **sensitive financial data**:

- The browser uses the Supabase **public** key and only reads/writes limited user-owned state (notably `profiles`).
- Sensitive financial tables (`accounts`, `transactions`, `plaid_tokens`, legacy `users`) have an explicit **deny** policy for `anon` to fail loudly if the client ever attempts access (`backend/supabase/migrations/002_add_anon_policies.sql`).
- The backend uses the Supabase **service role** (server-only) to perform financial sync and operational tasks.

## Plaid integration architecture (current)

### 1) Link token creation + exchange

**Path**: Frontend → Express → Plaid → Express → Supabase

1. Frontend requests a Link token: `POST /api/plaid/create-link-token`
2. Express creates a Link token with Plaid secret (server-only)
3. User completes Plaid Link in the browser; frontend receives `public_token`
4. Frontend exchanges token via backend: `POST /api/plaid/exchange-token`
5. Backend exchanges `public_token` → `access_token` and **encrypts** it (AES-256-GCM) before storage
6. Backend stores encrypted token in Supabase (service role) and returns `item_id` (never returns `access_token`)

**Token encryption**: `backend/tokenStore.js` (AES-256-GCM; `TOKEN_ENCRYPTION_KEY` required in production).

### 2) Accounts metadata + balances (supporting)

TMM can call Plaid accounts endpoints server-side for metadata and balances:

- `POST /api/plaid/accounts` (Plaid `accountsGet`)
- `POST /api/plaid/balance` (Plaid `accountsBalanceGet`)

These endpoints are authenticated and tier-gated (JWT + `requireTmmPlus`).

### 3) Primary data plane: Transactions Sync

TMM’s primary production-grade mechanism is **Plaid Transactions Sync**:

- `POST /api/plaid/transactions/sync` (sync one `item_id` or all items for a user)
- Uses durable cursoring and idempotency/observability via `plaid_sync_runs` (migration `backend/supabase/migrations/012_history_integration.sql`).
- Writes into `accounts` and `transactions` tables (server-side).

Optional retrieval paths:

- `POST /api/plaid/transactions` (Plaid `transactionsGet` for a bounded date range)
- `GET /api/plaid/transactions/db` (read already-synced DB transactions with filters)

### 4) Webhooks for ongoing accuracy + item health

TMM exposes a server-only webhook endpoint:

- `POST /api/webhooks/plaid`
- Explicitly rejects any `Authorization: Bearer` user tokens on webhook routes.
- Supports a lightweight shared-secret header guard (`PLAID_WEBHOOK_SECRET` via `x-plaid-webhook-secret`).
- Stores every webhook durably in `plaid_webhook_events` with deduplication (migration `backend/supabase/migrations/013_plaid_webhook_events_and_item_status.sql`).
- On `TRANSACTIONS / SYNC_UPDATES_AVAILABLE`, schedules a debounced sync for the item.
- Tracks item health / update-mode requirements in `plaid_item_status` to drive frontend UX (reconnect/update flows).

### 5) Update mode (re-authentication) and reconnect-in-place

When Plaid indicates action required (e.g., `ITEM_LOGIN_REQUIRED`), TMM:

- Exposes item status to the frontend (`GET /api/plaid/item-status`)
- Creates Link tokens with `update_item_id` when needed
- Supports reconnect-in-place mapping updates (backend route: `/api/plaid/reconnect-in-place`; frontend logic in `AccountIntegrationScreen.tsx`)

## Privacy, retention, and deletion (current)

- Consent is recorded before initiating Plaid Link (`privacy_consents`).
- Users can trigger a full deletion workflow:
  - `POST /api/privacy/delete-account` (requires explicit confirm text)
  - Best-effort calls Plaid `/item/remove`, deletes user data, then deletes the Supabase auth user.

See:

- `docs/security/PRIVACY_POLICY.md`
- `docs/security/DATA_RETENTION_AND_DELETION_POLICY.md`

## Security controls (in-code)

TMM applies layered backend controls (see `backend/server.js` and `backend/middleware/*`):

- **TLS** assumed at hosting/edge; optional **HSTS** header toggle (`ENABLE_HSTS=true`) via `backend/middleware/security.js`.
- **CORS** origin controls (prod-validated).
- **Rate limiting** for API and webhook routes (`backend/middleware/rateLimit.js`).
- **Request timeouts** (`backend/middleware/security.js` + `createRequestTimeoutMiddleware`).
- **Input validation** via Zod schemas (`backend/middleware/validation.js`).
- **Security headers** (nosniff, frame deny, referrer policy, permissions policy; optional HSTS).
- **Encryption at rest (application layer)** for Plaid + Google tokens (AES-256-GCM).

## Request/response examples (current)

### Example 1: Sync transactions for all items (primary path)

```
1) Frontend: POST /api/plaid/transactions/sync { force_refresh?: boolean }
   Authorization: Bearer <supabase_jwt>
   ↓
2) Express: requireAuth + requireTmmPlus
   ↓
3) Express: listItemIdsForUser(userId)
   ↓
4) For each item: getToken(item_id,userId) → decrypt → plaidClient.transactionsSync(...)
   ↓
5) Express: upsert accounts + transactions; record plaid_sync_runs
   ↓
6) Response: { ok: true, results: [...] }
```

### Example 2: Webhook-driven sync (ongoing accuracy)

```
1) Plaid → POST /api/webhooks/plaid
   x-plaid-webhook-secret: <shared_secret> (optional, if configured)
   ↓
2) Express: records durable webhook event (dedupe)
   ↓
3) If SYNC_UPDATES_AVAILABLE: scheduleDebouncedItemSync(itemId,userId)
   ↓
4) Background sync calls transactionsSync and updates DB
```

### Example 3: User deletion

```
1) Frontend: POST /api/privacy/delete-account { confirm_text: "DELETE MY DATA" }
   Authorization: Bearer <supabase_jwt>
   ↓
2) Express: best-effort Plaid /item/remove for linked items
   ↓
3) Express: delete user rows (financial + integration + privacy), then delete auth user
   ↓
4) Response: { ok: true, deleted: true }
```
