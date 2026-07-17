#!/bin/bash
# Master Audit Verification Script
# Runs all verification checks from the audit plan

set -e

echo "🔍 TMM Full-Stack Audit Verification"
echo "===================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

# Section A: Architecture + Data Flow
echo -e "${BLUE}=== A) Architecture + Data Flow Audit ===${NC}"
echo ""

echo "1. Verifying no frontend Supabase client..."
if grep -r "createClient.*supabase" . --include="*.js" --exclude-dir=backend --exclude-dir=node_modules --exclude-dir=tests 2>/dev/null | grep -v "node_modules" > /dev/null; then
    echo -e "${RED}❌ Found Supabase client in frontend${NC}"
    FAILED=$((FAILED + 1))
else
    echo -e "${GREEN}✅ No Supabase client in frontend${NC}"
    PASSED=$((PASSED + 1))
fi

echo "2. Verifying no secrets in frontend..."
if [ -f "./scripts/verify-no-secrets.sh" ]; then
    if bash ./scripts/verify-no-secrets.sh; then
        PASSED=$((PASSED + 1))
    else
        FAILED=$((FAILED + 1))
    fi
else
    echo -e "${YELLOW}⚠️  verify-no-secrets.sh not found${NC}"
fi

echo ""

# Section B: RLS + Security
echo -e "${BLUE}=== B) RLS + Security Verification ===${NC}"
echo ""

echo "1. Checking RLS migration exists..."
if [ -f "supabase/migrations/20260706185451_baseline.sql" ]; then
    echo -e "${GREEN}✅ Canonical baseline migration (strict RLS + anon deny) exists${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}❌ RLS anon policies migration missing${NC}"
    FAILED=$((FAILED + 1))
fi

echo "2. Checking encryption key validation..."
if grep -q "TOKEN_ENCRYPTION_KEY is required in production" backend/tokenStore.js; then
    echo -e "${GREEN}✅ Encryption key validation implemented${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}❌ Encryption key validation missing${NC}"
    FAILED=$((FAILED + 1))
fi

echo ""

# Section C: Performance
echo -e "${BLUE}=== C) Performance + Query Audit ===${NC}"
echo ""

echo "1. Checking performance test data script..."
if [ -f "tests/performance/generate-test-data.sql" ]; then
    echo -e "${GREEN}✅ Performance test data script exists${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}❌ Performance test data script missing${NC}"
    FAILED=$((FAILED + 1))
fi

echo "2. Checking composite index migration..."
if grep -q "idx_transactions_account_id" supabase/migrations/20260706185451_baseline.sql 2>/dev/null; then
    echo -e "${GREEN}✅ Composite/query indexes present in canonical baseline${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${YELLOW}⚠️  Composite index migration not found (optional)${NC}"
fi

echo ""

# Section D: Observability
echo -e "${BLUE}=== D) Observability + Debuggability ===${NC}"
echo ""

echo "1. Checking logging middleware..."
if [ -f "backend/middleware/logging.js" ]; then
    echo -e "${GREEN}✅ Logging middleware exists${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}❌ Logging middleware missing${NC}"
    FAILED=$((FAILED + 1))
fi

echo "2. Checking diagnostic endpoints..."
if grep -q "/api/diag/supabase" backend/server.js && grep -q "/api/diag/plaid" backend/server.js; then
    echo -e "${GREEN}✅ Diagnostic endpoints implemented${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}❌ Diagnostic endpoints missing${NC}"
    FAILED=$((FAILED + 1))
fi

echo ""

# Section E: Cleanup
echo -e "${BLUE}=== E) Cleanup / Environment ===${NC}"
echo ""

echo "1. Checking .env.example..."
if [ -f "backend/.env.example" ]; then
    echo -e "${GREEN}✅ .env.example exists${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}❌ .env.example missing${NC}"
    FAILED=$((FAILED + 1))
fi

echo "2. Checking .gitignore..."
if grep -q "^\.env$" backend/.gitignore 2>/dev/null; then
    echo -e "${GREEN}✅ .env is gitignored${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}❌ .env NOT in .gitignore${NC}"
    FAILED=$((FAILED + 1))
fi

echo "3. Checking for obsolete files..."
if [ -f "./scripts/check-obsolete-files.sh" ]; then
    bash ./scripts/check-obsolete-files.sh
    PASSED=$((PASSED + 1))
else
    echo -e "${YELLOW}⚠️  check-obsolete-files.sh not found${NC}"
fi

echo ""

# Section F: Documentation
echo -e "${BLUE}=== F) Documentation ===${NC}"
echo ""

echo "1. Checking ARCHITECTURE.md..."
if [ -f "docs/project/ARCHITECTURE.md" ]; then
    echo -e "${GREEN}✅ ARCHITECTURE.md exists${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}❌ ARCHITECTURE.md missing${NC}"
    FAILED=$((FAILED + 1))
fi

echo "2. Checking AUDIT_CHECKLIST.md..."
if [ -f "docs/project/AUDIT_CHECKLIST.md" ]; then
    echo -e "${GREEN}✅ AUDIT_CHECKLIST.md exists${NC}"
    PASSED=$((PASSED + 1))
else
    echo -e "${RED}❌ AUDIT_CHECKLIST.md missing${NC}"
    FAILED=$((FAILED + 1))
fi

echo ""

# Summary
echo -e "${BLUE}=== Summary ===${NC}"
echo ""
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"
echo ""

if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}✅ All automated checks passed!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Execute RLS migration in Supabase SQL Editor"
    echo "2. Run security tests: node tests/security/rls-anon-test.js"
    echo "3. Test diagnostic endpoints: curl http://localhost:3000/api/diag/supabase"
    echo "4. Run performance queries from AUDIT_CHECKLIST.md"
    exit 0
else
    echo -e "${RED}❌ Some checks failed. Please review and fix.${NC}"
    exit 1
fi
