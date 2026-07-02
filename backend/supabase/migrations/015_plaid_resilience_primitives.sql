-- Migration 015: Plaid resilience primitives (idempotency, queue, quotas, breaker, atomic sync apply)

-- 1) Link-intent idempotency for /exchange-token
CREATE TABLE IF NOT EXISTS plaid_link_intents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  link_intent_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'failed')),
  request_id TEXT,
  public_token_hash TEXT,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, link_intent_id)
);

CREATE INDEX IF NOT EXISTS idx_plaid_link_intents_user_created
  ON plaid_link_intents(user_id, created_at DESC);

CREATE TRIGGER update_plaid_link_intents_updated_at BEFORE UPDATE ON plaid_link_intents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE plaid_link_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON plaid_link_intents FOR ALL USING (true);

-- 2) Durable queue for Plaid sync jobs
CREATE TABLE IF NOT EXISTS plaid_sync_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id UUID NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id TEXT,
  job_type TEXT NOT NULL DEFAULT 'sync_item' CHECK (job_type IN ('sync_item', 'sync_all')),
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'webhook', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMP WITH TIME ZONE,
  lock_owner UUID,
  dedupe_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  started_at TIMESTAMP WITH TIME ZONE,
  finished_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_plaid_sync_jobs_status_run_after
  ON plaid_sync_jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_plaid_sync_jobs_user_created
  ON plaid_sync_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plaid_sync_jobs_item_created
  ON plaid_sync_jobs(item_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plaid_sync_jobs_active_dedupe
  ON plaid_sync_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

CREATE TRIGGER update_plaid_sync_jobs_updated_at BEFORE UPDATE ON plaid_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE plaid_sync_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON plaid_sync_jobs FOR ALL USING (true);

-- 3) Lock/cooldown state on plaid_item_status
ALTER TABLE plaid_item_status
  ADD COLUMN IF NOT EXISTS sync_locked_until TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS sync_lock_owner UUID,
  ADD COLUMN IF NOT EXISTS cooldown_until TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_sync_started_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS last_sync_finished_at TIMESTAMP WITH TIME ZONE;

-- 4) Quota counters
CREATE TABLE IF NOT EXISTS usage_counters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_id TEXT,
  metric TEXT NOT NULL,
  bucket_start TIMESTAMP WITH TIME ZONE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, metric, bucket_start, item_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_counters_metric_bucket
  ON usage_counters(metric, bucket_start DESC);
CREATE INDEX IF NOT EXISTS idx_usage_counters_user_metric
  ON usage_counters(user_id, metric, bucket_start DESC);

CREATE TRIGGER update_usage_counters_updated_at BEFORE UPDATE ON usage_counters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON usage_counters FOR ALL USING (true);

-- 5) Circuit breaker state
CREATE TABLE IF NOT EXISTS plaid_circuit_breaker (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scope TEXT NOT NULL UNIQUE DEFAULT 'global',
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  opened_at TIMESTAMP WITH TIME ZONE,
  next_try_at TIMESTAMP WITH TIME ZONE,
  last_failure_at TIMESTAMP WITH TIME ZONE,
  failure_count_window INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMP WITH TIME ZONE,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TRIGGER update_plaid_circuit_breaker_updated_at BEFORE UPDATE ON plaid_circuit_breaker
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE plaid_circuit_breaker ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON plaid_circuit_breaker FOR ALL USING (true);

INSERT INTO plaid_circuit_breaker (scope, state)
VALUES ('global', 'closed')
ON CONFLICT (scope) DO NOTHING;

-- 6) Sync-run status should support running/queued
ALTER TABLE plaid_sync_runs
  DROP CONSTRAINT IF EXISTS plaid_sync_runs_status_check;

ALTER TABLE plaid_sync_runs
  ADD CONSTRAINT plaid_sync_runs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed'));

-- 7) Quota helper RPC
CREATE OR REPLACE FUNCTION increment_usage_counter(
  p_metric TEXT,
  p_user_id UUID,
  p_item_id TEXT,
  p_window_seconds INTEGER,
  p_max INTEGER
)
RETURNS TABLE(allowed BOOLEAN, count INTEGER, bucket_start TIMESTAMP WITH TIME ZONE)
LANGUAGE plpgsql
AS $$
DECLARE
  v_window INTEGER := GREATEST(1, COALESCE(p_window_seconds, 60));
  v_max INTEGER := GREATEST(1, COALESCE(p_max, 1));
  v_epoch BIGINT;
  v_bucket_epoch BIGINT;
  v_bucket_start TIMESTAMP WITH TIME ZONE;
  v_count INTEGER;
BEGIN
  v_epoch := FLOOR(EXTRACT(EPOCH FROM NOW()));
  v_bucket_epoch := (v_epoch / v_window) * v_window;
  v_bucket_start := TO_TIMESTAMP(v_bucket_epoch);

  INSERT INTO usage_counters (user_id, item_id, metric, bucket_start, count)
  VALUES (p_user_id, p_item_id, p_metric, v_bucket_start, 1)
  ON CONFLICT ON CONSTRAINT usage_counters_user_id_metric_bucket_start_item_id_key
  DO UPDATE SET
    count = usage_counters.count + 1,
    updated_at = NOW()
  RETURNING usage_counters.count INTO v_count;

  RETURN QUERY SELECT (v_count <= v_max), v_count, v_bucket_start;
END;
$$;

-- 8) Atomic apply for /transactions/sync writes + cursor update
CREATE OR REPLACE FUNCTION plaid_apply_transactions_sync(
  p_user_id UUID,
  p_item_id TEXT,
  p_next_cursor TEXT,
  p_upserts JSONB,
  p_removed_ids TEXT[],
  p_coverage JSONB,
  p_sync_run_id UUID,
  p_counts JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_upserted INTEGER := 0;
  v_deleted INTEGER := 0;
  v_skipped INTEGER := 0;
  v_earliest DATE := NULL;
  v_latest DATE := NULL;
  v_added_count INTEGER := COALESCE((p_counts->>'added_count')::INTEGER, 0);
  v_modified_count INTEGER := COALESCE((p_counts->>'modified_count')::INTEGER, 0);
  v_removed_count INTEGER := COALESCE((p_counts->>'removed_count')::INTEGER, 0);
BEGIN
  IF p_coverage IS NOT NULL THEN
    v_earliest := NULLIF(p_coverage->>'earliest', '')::DATE;
    v_latest := NULLIF(p_coverage->>'latest', '')::DATE;
  END IF;

  WITH input_rows AS (
    SELECT
      NULLIF(j->>'plaid_transaction_id', '') AS plaid_transaction_id,
      NULLIF(j->>'plaid_account_id', '') AS plaid_account_id,
      COALESCE((j->>'amount')::NUMERIC, 0) AS amount,
      NULLIF(j->>'date', '')::DATE AS date,
      COALESCE(NULLIF(j->>'name', ''), 'Unknown') AS name,
      CASE
        WHEN jsonb_typeof(j->'category') = 'array' THEN (
          SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
          FROM jsonb_array_elements_text(j->'category')
        )
        ELSE ARRAY[]::TEXT[]
      END AS category,
      NULLIF(j->>'merchant_name', '') AS merchant_name,
      COALESCE((j->>'pending')::BOOLEAN, FALSE) AS pending,
      NULLIF(j->>'iso_currency_code', '') AS iso_currency_code,
      NULLIF(j->>'unofficial_currency_code', '') AS unofficial_currency_code
    FROM jsonb_array_elements(COALESCE(p_upserts, '[]'::jsonb)) j
  ),
  mapped_rows AS (
    SELECT
      a.id AS account_id,
      i.plaid_transaction_id,
      i.amount,
      i.date,
      i.name,
      i.category,
      i.merchant_name,
      i.pending,
      i.iso_currency_code,
      i.unofficial_currency_code
    FROM input_rows i
    JOIN accounts a
      ON a.user_id = p_user_id
      AND a.plaid_item_id = p_item_id
      AND a.plaid_account_id = i.plaid_account_id
    WHERE i.plaid_transaction_id IS NOT NULL
      AND i.date IS NOT NULL
  ),
  upserted_rows AS (
    INSERT INTO transactions (
      account_id,
      plaid_transaction_id,
      amount,
      date,
      name,
      category,
      merchant_name,
      pending,
      iso_currency_code,
      unofficial_currency_code
    )
    SELECT
      account_id,
      plaid_transaction_id,
      amount,
      date,
      name,
      category,
      merchant_name,
      pending,
      iso_currency_code,
      unofficial_currency_code
    FROM mapped_rows
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET
      account_id = EXCLUDED.account_id,
      amount = EXCLUDED.amount,
      date = EXCLUDED.date,
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      merchant_name = EXCLUDED.merchant_name,
      pending = EXCLUDED.pending,
      iso_currency_code = EXCLUDED.iso_currency_code,
      unofficial_currency_code = EXCLUDED.unofficial_currency_code,
      updated_at = NOW()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_upserted FROM upserted_rows;

  WITH input_count AS (
    SELECT COUNT(*)::INTEGER AS total
    FROM jsonb_array_elements(COALESCE(p_upserts, '[]'::jsonb)) j
    WHERE NULLIF(j->>'plaid_transaction_id', '') IS NOT NULL
  )
  SELECT GREATEST(0, input_count.total - v_upserted)
    INTO v_skipped
  FROM input_count;

  IF COALESCE(array_length(p_removed_ids, 1), 0) > 0 THEN
    WITH deleted_rows AS (
      DELETE FROM transactions t
      USING accounts a
      WHERE t.account_id = a.id
        AND a.user_id = p_user_id
        AND a.plaid_item_id = p_item_id
        AND t.plaid_transaction_id = ANY(p_removed_ids)
      RETURNING 1
    )
    SELECT COUNT(*) INTO v_deleted FROM deleted_rows;
  END IF;

  UPDATE plaid_tokens
  SET
    transactions_sync_cursor = p_next_cursor,
    earliest_txn_date_seen = CASE
      WHEN v_earliest IS NULL THEN earliest_txn_date_seen
      WHEN earliest_txn_date_seen IS NULL THEN v_earliest
      ELSE LEAST(earliest_txn_date_seen, v_earliest)
    END,
    latest_txn_date_seen = CASE
      WHEN v_latest IS NULL THEN latest_txn_date_seen
      WHEN latest_txn_date_seen IS NULL THEN v_latest
      ELSE GREATEST(latest_txn_date_seen, v_latest)
    END,
    updated_at = NOW()
  WHERE item_id = p_item_id AND user_id = p_user_id;

  UPDATE plaid_sync_runs
  SET
    cursor_after = p_next_cursor,
    added_count = v_added_count,
    modified_count = v_modified_count,
    removed_count = v_removed_count,
    upserted_count = v_upserted,
    deleted_count = v_deleted,
    skipped_unmapped_accounts = v_skipped,
    status = 'completed',
    error_message = NULL,
    finished_at = NOW()
  WHERE sync_run_id = p_sync_run_id;

  RETURN jsonb_build_object(
    'upserted_count', v_upserted,
    'deleted_count', v_deleted,
    'skipped_unmapped_accounts', v_skipped
  );
END;
$$;

