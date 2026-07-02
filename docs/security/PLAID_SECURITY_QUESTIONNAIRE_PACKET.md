# Plaid Security Questionnaire Packet (TMM)

Prepared on: 2026-02-09

Use this file as the canonical response packet. Attach screenshots and exports referenced below before submission.

## 1) Security program and contacts

- Answer: **Yes (with documented controls)**
- Controls:
  - `docs/security/SECURITY_CONTACTS.md`
  - `docs/security/INFORMATION_SECURITY_POLICY.md`
  - `docs/security/RISK_MANAGEMENT_PROCEDURE.md`
  - `docs/security/INCIDENT_RESPONSE_PLAN.md`
- Evidence to attach:
  - Named security owner + escalation contacts
  - Monthly risk review meeting note

## 2) Admin MFA on critical systems

- Answer: **Partially complete (code/docs complete; external console enforcement evidence pending upload)**
- Controls:
  - `docs/security/ADMIN_MFA_ENFORCEMENT_CHECKLIST.md`
  - `docs/security/IAM_ACCESS_CONTROL_STANDARD.md`
  - `docs/security/ACCESS_ONBOARDING_OFFBOARDING_PROCEDURE.md`
- Evidence to attach:
  - Supabase/Plaid/GitHub/hosting/monitoring MFA screenshots

## 3) Consumer MFA before Plaid Link

- Answer: **Yes**
- Controls:
  - MFA helper: `frontend/src/lib/security/mfa.ts`
  - Link gating + MFA challenge: `frontend/src/features/accountIntegration/AccountIntegrationScreen.tsx`
  - MFA enrollment flow: `frontend/src/features/settings/SettingsScreen.tsx`
- Evidence to attach:
  - Screenshots of MFA enrollment and verification gate
  - Test run: frontend build + manual verification steps

## 4) TLS and encryption at rest

- Answer: **Yes**
- Controls:
  - TLS/encryption standard: `docs/security/TLS_AND_ENCRYPTION_STANDARD.md`
  - Optional HSTS control: `backend/middleware/security.js`, `backend/config.js`, `backend/.env.example`
  - Token encryption: `backend/tokenStore.js`, `backend/storage/googleTokens.js`
- Evidence to attach:
  - TLS scan output
  - HSTS configuration screenshot (if enabled)

## 5) Vulnerability management and scanning

- Answer: **Yes (programmatic controls implemented)**
- Controls:
  - `docs/security/VULNERABILITY_MANAGEMENT_POLICY.md`
  - Dependabot: `.github/dependabot.yml`
  - Security CI: `.github/workflows/security-audit.yml`
  - SAST: `.github/workflows/codeql.yml`
- Evidence to attach:
  - Most recent CI run results
  - Monthly vulnerability evidence log

## 6) Privacy policy, consent, retention, deletion

- Answer: **Yes**
- Controls:
  - Privacy policy: `docs/security/PRIVACY_POLICY.md`
  - Retention/deletion policy: `docs/security/DATA_RETENTION_AND_DELETION_POLICY.md`
  - Consent + deletion migration: `backend/supabase/migrations/014_privacy_consent_and_deletion.sql`
  - Consent/deletion model: `backend/models/privacy.js`
  - API endpoints: `backend/server.js` (`/api/privacy/consent-status`, `/api/privacy/consent`, `/api/privacy/delete-account`)
  - Frontend consent modal + deletion UX:
    - `frontend/src/features/accountIntegration/AccountIntegrationScreen.tsx`
    - `frontend/src/features/settings/SettingsScreen.tsx`
- Evidence to attach:
  - Consent capture record from `privacy_consents`
  - Deletion request record from `data_deletion_requests`
  - Screenshot of consent gate and deletion flow

## 7) Open evidence tasks before submission

- [ ] Fill security contact names and escalation details
- [ ] Attach admin-MFA enforcement screenshots for all external consoles
- [ ] Attach TLS scan artifacts
- [ ] Attach first monthly risk review and vulnerability evidence logs
