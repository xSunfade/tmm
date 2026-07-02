# TMM Full-Stack Audit Checklist

This checklist provides executable verification steps for the TMM audit plan.

## A) Architecture + Data Flow Audit

### Verification Commands

- [ ] **Verify No Supabase Secret Key In Frontend**
  ```bash
  grep -r "SUPABASE_SECRET_KEY\\|sb_secret_" . --exclude-dir=backend --exclude-dir=node_modules
  ```
  Expected: Zero matches

- [ ] **Verify No Secrets in Frontend**
  ```bash
  ./scripts/verify-no-secrets.sh
  ```
  Expected: All checks pass

- [ ] **Verify Backend Uses Service Role**
  ```bash
  grep -r "supabaseAdmin" backend/
  ```
  Expected: Only in backend/storage/supabaseStorage.js and backend/supabaseClient.js

- [ ] **Verify Service Role Key Only in Backend**
  ```bash
  grep -r "SUPABASE_SECRET_KEY" backend/
  ```
  Expected: Only in backend/supabaseClient.js and backend/config.js

## B) RLS + Security Verification

### SQL Queries (Run in Supabase SQL Editor)

- [ ] **Verify RLS is Enabled**
  ```sql
  SELECT tablename, rowsecurity 
  FROM pg_tables 
  WHERE schemaname = 'public' 
    AND tablename IN ('users', 'plaid_tokens', 'accounts', 'transactions');
  ```
  Expected: rowsecurity = true for all tables

- [ ] **List All RLS Policies**
  ```sql
  SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual 
  FROM pg_policies 
  WHERE schemaname = 'public' 
    AND tablename IN ('users', 'plaid_tokens', 'accounts', 'transactions');
  ```
  Expected: Policies exist for all tables

- [ ] **Run Migration 002 (Anon Key Policies)**
  - Execute `backend/supabase/migrations/002_add_anon_policies.sql` in Supabase SQL Editor
  - Expected: Policies created successfully

### Test Scripts

- [ ] **Run RLS Anon Key Test**
  ```bash
  cd backend && node ../tests/security/rls-anon-test.js
  ```
  Expected: All tests pass

- [ ] **Run Token Encryption Test**
  ```bash
  node tests/security/token-encryption.test.js
  ```
  Expected: All tests pass

## C) Performance + Query Audit

### SQL Queries (Run in Supabase SQL Editor)

- [ ] **List All Indexes**
  ```sql
  SELECT tablename, indexname, indexdef 
  FROM pg_indexes 
  WHERE schemaname = 'public' 
    AND tablename IN ('users', 'plaid_tokens', 'accounts', 'transactions')
  ORDER BY tablename, indexname;
  ```
  Expected: All indexes from migration exist

- [ ] **Token Lookup Performance**
  ```sql
  EXPLAIN ANALYZE
  SELECT access_token 
  FROM plaid_tokens 
  WHERE item_id = 'test-item-id';
  ```
  Expected: Index Scan, Execution Time < 10ms

- [ ] **User Token List Performance**
  ```sql
  EXPLAIN ANALYZE
  SELECT * 
  FROM plaid_tokens 
  WHERE user_id = 'test-user-id';
  ```
  Expected: Index Scan, Execution Time < 50ms for 10 tokens

- [ ] **Transaction Date Range Performance**
  ```sql
  EXPLAIN ANALYZE
  SELECT * 
  FROM transactions 
  WHERE account_id = 'test-account-id' 
    AND date BETWEEN '2024-01-01' AND '2024-12-31'
  ORDER BY date DESC
  LIMIT 100;
  ```
  Expected: Index Scan, Execution Time < 100ms

## D) Observability + Debuggability

### Endpoint Tests

- [ ] **Test Health Endpoint**
  ```bash
  curl https://your-backend.vercel.app/api/health
  ```
  Expected: `{ "status": "ok", "timestamp": "...", "requestId": "..." }`

- [ ] **Test Supabase Diagnostic Endpoint**
  ```bash
  curl https://your-backend.vercel.app/api/diag/supabase
  ```
  Expected: All checks pass

- [ ] **Test Plaid Diagnostic Endpoint**
  ```bash
  curl https://your-backend.vercel.app/api/diag/plaid
  ```
  Expected: All checks pass

### Log Verification

- [ ] **Check Vercel Logs**
  - Go to Vercel Dashboard → Functions → Logs
  - Verify structured JSON logs with request IDs
  - Expected: Request/response logs visible

- [ ] **Check Supabase Logs**
  - Go to Supabase Dashboard → Logs → Postgres Logs
  - Verify query logs
  - Expected: Query logs visible

## E) Cleanup / Environment

### File Verification

- [ ] **Check for Obsolete SQLite Files**
  ```bash
  find . -name "*.db" -not -path "*/node_modules/*"
  ```
  Expected: None (or document why they exist)

- [ ] **Verify .env.example Exists**
  ```bash
  test -f backend/.env.example && echo "✅ .env.example exists" || echo "❌ .env.example missing"
  ```
  Expected: File exists

- [ ] **Verify .env is Gitignored**
  ```bash
  grep -q "^\.env$" backend/.gitignore && echo "✅ .env is gitignored" || echo "❌ .env NOT in .gitignore"
  ```
  Expected: .env is gitignored

- [ ] **Verify .env is Not Tracked**
  ```bash
  git ls-files | grep -q "\.env$" && echo "❌ .env is tracked!" || echo "✅ .env is not tracked"
  ```
  Expected: .env is not tracked

## F) End-to-End Functional Verification

### Manual Tests

- [ ] **Frontend Loads**
  - Open app in browser
  - Check console for errors
  - Expected: No errors

- [ ] **Backend Health Check**
  ```bash
  node tests/e2e/backend-health.test.js
  ```
  Expected: Test passes

- [ ] **Manual Mode Workflow**
  - Add manual account
  - Update balance
  - Run simulation
  - Expected: Simulation reflects changes

- [ ] **Plaid Workflow (Sandbox)**
  - Enable Plaid in settings
  - Connect account via Plaid Link
  - Verify account appears
  - Expected: Account linked successfully

- [ ] **CORS Verification**
  - Test from unauthorized origin
  - Expected: CORS error
  - Test from authorized origin
  - Expected: Request succeeds

## G) Definition of Done

- [ ] All "Fix Now" priorities completed
- [ ] All test suites pass
- [ ] Diagnostic endpoints return expected results
- [ ] No secrets in frontend code (verified)
- [ ] RLS policies verified and documented
- [ ] Performance benchmarks established
- [ ] Observability infrastructure in place
- [ ] `.env.example` created
- [ ] Architecture documentation updated
- [ ] E2E smoke tests pass
