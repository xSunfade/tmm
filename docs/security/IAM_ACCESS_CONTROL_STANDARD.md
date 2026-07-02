# IAM and Access Control Standard (TMM)

Version: 1.0  
Owner: Security Lead  
Review cadence: Quarterly

## 1. Access principles

- Least privilege: grant only required permissions.
- Separation of duties: avoid single-user unchecked control on critical actions.
- Time-bound elevated access where feasible.
- Immediate revocation on role change or offboarding.

## 2. Critical systems in scope

- Supabase (database/auth/admin)
- Plaid dashboard
- Hosting provider dashboard
- Source control (GitHub organization and repos)
- Logging/monitoring tools

## 3. Mandatory controls

- MFA required for all admin users on critical systems.
- Shared accounts prohibited.
- Production secrets stored only in managed secret stores/environment configuration.
- Admin access reviewed monthly and after personnel changes.

## 4. Access review process

Monthly:

1. Export current user/admin lists for each critical system.
2. Validate role necessity and ownership.
3. Remove stale users or excessive permissions.
4. Record review date and reviewer.

## 5. Evidence expectations

- MFA enforcement screenshots/config exports.
- Access review log with dates and approvals.
- Onboarding/offboarding checklist completion records.
