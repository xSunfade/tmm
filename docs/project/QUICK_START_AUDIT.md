# Quick Start: Running the Audit

This guide provides quick steps to execute the audit verification.

## Prerequisites

1. Backend server running (for endpoint tests)
2. Supabase project configured
3. Environment variables set (see `backend/.env.example`)

## Quick Verification Steps

### 1. Run Master Verification Script

```bash
bash scripts/run-audit-verification.sh
```

This runs all automated checks.

### 2. Execute RLS Migration

1. Open Supabase Dashboard → SQL Editor
2. Copy contents of `backend/supabase/migrations/002_add_anon_policies.sql`
3. Execute in SQL Editor
4. Verify policies are created

### 3. Run Security Tests

```bash
# RLS Anon Key Test
cd backend
node ../tests/security/rls-anon-test.js

# Token Encryption Test
node tests/security/token-encryption.test.js
```

### 4. Test Diagnostic Endpoints

```bash
# Health check
curl http://localhost:3000/api/health

# Supabase diagnostic
curl http://localhost:3000/api/diag/supabase

# Plaid diagnostic
curl http://localhost:3000/api/diag/plaid
```

### 5. Run Performance Queries

1. Open Supabase SQL Editor
2. Execute queries from `AUDIT_CHECKLIST.md` Section C
3. Document results

### 6. Verify No Secrets

```bash
bash scripts/verify-no-secrets.sh
```

## Expected Results

- ✅ All verification scripts pass
- ✅ RLS migration executes successfully
- ✅ Security tests pass
- ✅ Diagnostic endpoints return expected results
- ✅ No secrets found in frontend
- ✅ Performance queries meet targets

## Full Documentation

- **ARCHITECTURE.md** - Complete architecture documentation
- **AUDIT_CHECKLIST.md** - Detailed verification checklist
- **IMPLEMENTATION_SUMMARY.md** - Implementation status
