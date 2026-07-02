# Secure SDLC Procedure (TMM)

Version: 1.0  
Owner: Engineering Lead  
Review cadence: Quarterly

## 1. Planning

- Classify data sensitivity and trust boundaries for each feature.
- Identify new security/privacy requirements and update threat assumptions.

## 2. Implementation

- Use approved patterns for auth, access control, and secret handling.
- Enforce backend input validation for new endpoints.
- Avoid introducing bypass paths around RLS and ownership checks.

## 3. Verification

- Run static checks and security test suites.
- Run targeted tests for new data paths and authorization boundaries.
- Validate no secrets in code before merge.

## 4. Release gates

Release cannot proceed until:

- Security checklist is complete.
- High/Critical findings are resolved or approved exception exists.
- Required migrations and rollback steps are documented.

## 5. Post-release

- Monitor logs, webhook/sync health, and error rates.
- Record incidents and feed lessons into risk register.
