# Release Security Checklist (TMM)

Complete before any production release.

- [ ] Security-impacting changes reviewed by engineering/security owner.
- [ ] RLS/security tests pass (`tests/security/*`).
- [ ] Plaid sync and temporal validation tests pass.
- [ ] No secrets detected by repository secret scan.
- [ ] Required migrations reviewed and rollback plan documented.
- [ ] Monitoring/alerts reviewed for new endpoints or flows.
- [ ] Privacy/consent impacts reviewed if data handling changed.
- [ ] Incident response contacts validated.
