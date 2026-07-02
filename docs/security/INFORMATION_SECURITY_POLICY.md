# Information Security Policy (TMM)

Version: 1.0  
Owner: Security Lead  
Review cadence: Quarterly

## 1. Purpose

Define how TMM identifies, mitigates, and monitors information security risks across application, infrastructure, data, and operations.

## 2. Scope

Applies to:

- Production systems and data stores
- Source code repositories and CI/CD
- Workforce endpoints used to access production systems
- Third-party providers (Plaid, Supabase, hosting, monitoring)

## 3. Core principles

1. Least privilege by default.
2. Defense in depth for sensitive financial data.
3. Secure-by-default releases (tests and reviews required).
4. Prompt detection and response to incidents.
5. Continuous improvement through periodic risk review.

## 4. Control requirements

- MFA required for all critical admin systems.
- Secrets must not be committed to source control.
- Plaid tokens must remain server-side only and encrypted at rest.
- Data in transit must use TLS 1.2+.
- RLS and ownership controls must be tested before release.
- Security-impacting changes require review and approval.

## 5. Operationalization

- Maintain risk register in `docs/security/templates/RISK_REGISTER_TEMPLATE.csv`.
- Run monthly risk review and record decisions.
- Run release security checklist before production deployments.
- Maintain incident response runbook and post-incident actions.

## 6. Exceptions

Exceptions must be documented with owner, rationale, and expiration date, and approved by Security Lead.
