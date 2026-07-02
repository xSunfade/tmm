# Obsolete Files Documentation

This document tracks files that may be obsolete from earlier stack iterations.

## Known Obsolete Files

### `backend/data/plaid_tokens.db` ✅ DELETED
- **Type**: SQLite database file
- **Status**: Removed (2026-01-15)
- **Reason**: TMM has migrated to Supabase PostgreSQL for token storage
- **Action**: Deleted - data migrated to Supabase `plaid_tokens` table

## Files to Review

### AWS Beanstalk Configs (if any)
- `.ebextensions/` directory
- `Procfile`
- **Status**: Review if not using AWS Beanstalk
- **Action**: Remove if not needed

## Migration Notes

When migrating from SQLite to Supabase:
1. All token data should be in Supabase `plaid_tokens` table
2. SQLite file can be deleted after migration verification
3. No data loss should occur if migration was successful

## Verification

Run the following to check for obsolete files:
```bash
./scripts/check-obsolete-files.sh
```
