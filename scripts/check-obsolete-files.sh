#!/bin/bash
# Check for Obsolete Files
# Identifies files that may be obsolete from earlier stack iterations

set -e

echo "🔍 Checking for obsolete files..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

FOUND=0

# Check for SQLite files (migrated to Supabase)
echo "Checking for SQLite files..."
SQLITE_FILES=$(find . -name "*.db" -not -path "*/node_modules/*" 2>/dev/null)
if [ -n "$SQLITE_FILES" ]; then
    echo -e "${YELLOW}⚠️  Found SQLite files (may be obsolete):${NC}"
    echo "$SQLITE_FILES"
    echo "   Note: TMM now uses Supabase PostgreSQL. SQLite files may be from earlier iterations."
    FOUND=$((FOUND + 1))
else
    echo -e "${GREEN}✅ No SQLite files found${NC}"
fi

# Check for AWS Beanstalk configs
echo "Checking for AWS Beanstalk configs..."
BEANSTALK_FILES=$(find . -name ".ebextensions" -o -name "Procfile" 2>/dev/null | grep -v node_modules)
if [ -n "$BEANSTALK_FILES" ]; then
    echo -e "${YELLOW}⚠️  Found AWS Beanstalk configs:${NC}"
    echo "$BEANSTALK_FILES"
    echo "   Note: If not using AWS Beanstalk, these may be obsolete."
    FOUND=$((FOUND + 1))
else
    echo -e "${GREEN}✅ No AWS Beanstalk configs found${NC}"
fi

# Summary
echo ""
if [ "$FOUND" -eq 0 ]; then
    echo -e "${GREEN}✅ No obvious obsolete files found.${NC}"
    exit 0
else
    echo -e "${YELLOW}⚠️  Found $FOUND potential obsolete file(s). Review and remove if not needed.${NC}"
    exit 0
fi
