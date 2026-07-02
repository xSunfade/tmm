# TLS and Encryption Standard (TMM)

Version: 1.0  
Owner: Engineering Lead  
Review cadence: Quarterly

## 1. Data in transit

- Production traffic must use HTTPS with TLS 1.2 or higher.
- Plain HTTP must redirect to HTTPS at edge/hosting layer.
- Webhook endpoints must be HTTPS only.
- HSTS may be enabled only after confirming all domains/subdomains are HTTPS-safe.

Implementation notes:

- Backend supports optional HSTS header via `ENABLE_HSTS=true`.
- HSTS should remain disabled in local development.

## 2. Data at rest

- Plaid access tokens are encrypted in application layer before persistence.
- Encryption algorithm: AES-256-GCM (`backend/tokenStore.js`).
- Google OAuth tokens are encrypted similarly (`backend/storage/googleTokens.js`).
- Database-at-rest encryption is provided by managed Supabase infrastructure.

## 3. Key management

- `TOKEN_ENCRYPTION_KEY` is required in production and must be 64 hex chars.
- Keys are stored only in secret management/environment configuration.
- Rotation is performed per `docs/backend/PLAID_OPERATIONS_RUNBOOK.md`.

## 4. Verification evidence checklist

- [ ] TLS scan result (TLS1.2+ confirmed)
- [ ] HTTPS redirect evidence
- [ ] HSTS setting evidence (if enabled)
- [ ] Token encryption evidence (code reference + test output)
- [ ] Key rotation evidence (date, owner, outcome)
