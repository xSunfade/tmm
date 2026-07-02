-- Migration 019: bounded history retention helper
-- Adds RPC to prune old account balance snapshots.

CREATE OR REPLACE FUNCTION prune_account_balance_snapshots(
  p_retention_days INTEGER DEFAULT 90
)
RETURNS TABLE (
  deleted_count BIGINT,
  cutoff_date DATE
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_retention_days INTEGER := GREATEST(1, COALESCE(p_retention_days, 90));
  v_cutoff_date DATE := (NOW() AT TIME ZONE 'UTC')::DATE - (v_retention_days - 1);
  v_deleted_count BIGINT := 0;
BEGIN
  DELETE FROM account_balance_snapshots
  WHERE (as_of AT TIME ZONE 'UTC')::DATE < v_cutoff_date;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN QUERY
  SELECT v_deleted_count, v_cutoff_date;
END;
$$;
