#!/bin/bash
# Verify No Secrets in Frontend Code
# This script checks that no secrets are accidentally committed to frontend files

set -e

echo "🔍 Checking for secrets in frontend code..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0

# Check for Plaid secret
echo "Checking for PLAID_SECRET..."
PLAID_SECRET_MATCHES=$(grep -r "PLAID_SECRET" . --include="*.js" --exclude-dir=backend --exclude-dir=node_modules --exclude-dir=tests 2>/dev/null | wc -l)
if [ "$PLAID_SECRET_MATCHES" -gt 0 ]; then
    echo -e "${RED}❌ Found $PLAID_SECRET_MATCHES match(es) for PLAID_SECRET in frontend${NC}"
    grep -r "PLAID_SECRET" . --include="*.js" --exclude-dir=backend --exclude-dir=node_modules --exclude-dir=tests
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✅ No PLAID_SECRET found in frontend${NC}"
fi

# Check for Supabase service role key
echo "Checking for SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE..."
SUPABASE_SECRET_MATCHES=$(grep -r "SUPABASE_SECRET_KEY\|SUPABASE_SERVICE_ROLE" . --include="*.js" --exclude-dir=backend --exclude-dir=node_modules --exclude-dir=tests 2>/dev/null | wc -l)
if [ "$SUPABASE_SECRET_MATCHES" -gt 0 ]; then
    echo -e "${RED}❌ Found $SUPABASE_SECRET_MATCHES match(es) for Supabase secret key in frontend${NC}"
    grep -r "SUPABASE_SECRET_KEY\|SUPABASE_SERVICE_ROLE" . --include="*.js" --exclude-dir=backend --exclude-dir=node_modules --exclude-dir=tests
    ERRORS=$((ERRORS + 1))
else
    echo -e "${GREEN}✅ No Supabase secret key found in frontend${NC}"
fi

# Check for hardcoded JWT tokens (common patterns)
echo "Checking for hardcoded JWT tokens..."
JWT_MATCHES=$(grep -r "eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*" . --include="*.js" --exclude-dir=backend --exclude-dir=node_modules --exclude-dir=tests 2>/dev/null | wc -l)
if [ "$JWT_MATCHES" -gt 0 ]; then
    echo -e "${YELLOW}⚠️  Found $JWT_MATCHES potential JWT token(s) in frontend (may be test data)${NC}"
    grep -r "eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*" . --include="*.js" --exclude-dir=backend --exclude-dir=node_modules --exclude-dir=tests
else
    echo -e "${GREEN}✅ No hardcoded JWT tokens found${NC}"
fi

# Check for common secret patterns
echo "Checking for common secret patterns..."
SECRET_PATTERNS=$(grep -r "sk_live\|secret.*=.*['\"][^'\"]*['\"]" . --include="*.js" --exclude-dir=backend --exclude-dir=node_modules --exclude-dir=tests 2>/dev/null | grep -v "//\|/\*\|^\s*\*" | wc -l)
if [ "$SECRET_PATTERNS" -gt 0 ]; then
    echo -e "${YELLOW}⚠️  Found $SECRET_PATTERNS potential secret pattern(s) (review manually)${NC}"
    grep -r "sk_live\|secret.*=.*['\"][^'\"]*['\"]" . --include="*.js" --exclude-dir=backend --exclude-dir=node_modules --exclude-dir=tests | grep -v "//\|/\*\|^\s*\*"
else
    echo -e "${GREEN}✅ No obvious secret patterns found${NC}"
fi

# Summary
echo ""
if [ "$ERRORS" -eq 0 ]; then
    echo -e "${GREEN}✅ All checks passed! No secrets found in frontend code.${NC}"
    exit 0
else
    echo -e "${RED}❌ Found $ERRORS security issue(s). Please review and fix.${NC}"
    exit 1
fi
