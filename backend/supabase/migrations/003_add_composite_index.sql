-- TMM Backend Database Schema
-- Migration 003: Add composite index for transaction date range queries
-- This improves performance for queries filtering by account_id and date

-- Composite index for transaction date range queries
-- This index supports queries like:
-- SELECT * FROM transactions WHERE account_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC
CREATE INDEX IF NOT EXISTS idx_transactions_account_date 
  ON transactions(account_id, date DESC);

-- Note: This index is optional but recommended if transaction queries are slow
-- Run EXPLAIN ANALYZE on transaction queries to verify if this index is being used
