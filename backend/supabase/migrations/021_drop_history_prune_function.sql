-- Migration 021: cleanup scheduled prune helper
-- We no longer use scheduled prune flows in the app architecture.

DROP FUNCTION IF EXISTS prune_account_balance_snapshots(INTEGER);

