# TMM Test Suite

> **⚠️ STALE (marked 2026-07-03, Phase 0.7).** This overview omits roughly half of the current test tree (`tests/validation/` harness, unit suites, e2e specs). Until it is rewritten, treat `docs/project-audit/testing-strategy.md` and the root `package.json` test scripts as the source of truth.

This directory contains test suites for the TMM full-stack audit and verification.

## Directory Structure

```
tests/
├── security/          # Security and RLS tests
├── performance/        # Performance and query tests
└── e2e/               # End-to-end functional tests
```

## Running Tests

### Security Tests

**RLS Anon Key Test**
```bash
cd backend
node ../tests/security/rls-anon-test.js
```

**Token Encryption Test**
```bash
node tests/security/token-encryption.test.js
```

### E2E Tests

**Backend Health Check**
```bash
# Set BACKEND_URL environment variable or edit test file
node tests/e2e/backend-health.test.js
```

**History Net Worth**
```bash
node tests/e2e/history-net-worth.test.js
```

**Reconciliation Override**
```bash
node tests/e2e/reconciliation-override.test.js
```

### Performance Tests

**Generate Test Data**
1. Open Supabase SQL Editor
2. Copy contents of `tests/performance/generate-test-data.sql`
3. Execute in SQL Editor
4. Run `EXPLAIN ANALYZE` queries from audit plan

**Generate History Test Data (Supabase local)**
1. Open Supabase SQL Editor (local)
2. Copy contents of `tests/performance/generate-history-test-data.sql`
3. Execute in SQL Editor
4. Run history e2e scripts in `tests/e2e`

## Test Requirements

- Node.js >= 18.0.0
- Environment variables set (see `backend/.env.example`)
- Supabase project configured
- Backend server running (for E2E tests)

## Test Data

Test data is generated using SQL scripts in `tests/performance/`. These scripts create:
- Test users
- Test Plaid tokens
- Test accounts
- Test transactions

**Warning**: Test data scripts should only be run in development/sandbox environments.
