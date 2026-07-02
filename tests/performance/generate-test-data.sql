-- Test Data Generation Script
-- Generates test data for scale testing
-- Run this in Supabase SQL Editor

-- Generate test data for scale testing
-- 10 users, 100 tokens

-- First, create test users
INSERT INTO users (id, email) 
SELECT 
  gen_random_uuid(), 
  'user' || i || '@test.com'
FROM generate_series(1, 10) i
ON CONFLICT (email) DO NOTHING;

-- 100 tokens (10 per user, distributed)
INSERT INTO plaid_tokens (item_id, user_id, access_token)
SELECT 
  'item_' || i,
  (SELECT id FROM users ORDER BY created_at LIMIT 1 OFFSET ((i - 1) % 10)),
  'encrypted_token_' || i || '_' || md5(random()::text)
FROM generate_series(1, 100) i
ON CONFLICT (item_id) DO NOTHING;

-- Create some test accounts
INSERT INTO accounts (user_id, plaid_item_id, plaid_account_id, name, type, balance)
SELECT 
  pt.user_id,
  pt.item_id,
  'account_' || pt.item_id || '_' || j,
  'Test Account ' || j,
  CASE (j % 4)
    WHEN 0 THEN 'checking'
    WHEN 1 THEN 'savings'
    WHEN 2 THEN 'credit'
    ELSE 'investment'
  END,
  (random() * 10000)::numeric(15, 2)
FROM plaid_tokens pt
CROSS JOIN generate_series(1, 3) j
ON CONFLICT (user_id, plaid_account_id) DO NOTHING;

-- Create some test transactions
INSERT INTO transactions (account_id, plaid_transaction_id, amount, date, name, category)
SELECT 
  a.id,
  'txn_' || a.id || '_' || t,
  (random() * 1000 - 500)::numeric(15, 2),
  CURRENT_DATE - (random() * 365)::int,
  'Test Transaction ' || t,
  ARRAY['test', 'category']
FROM accounts a
CROSS JOIN generate_series(1, 10) t
ON CONFLICT (plaid_transaction_id) DO NOTHING;

-- Summary
SELECT 
  'Users' as table_name, COUNT(*) as count FROM users
UNION ALL
SELECT 'Plaid Tokens', COUNT(*) FROM plaid_tokens
UNION ALL
SELECT 'Accounts', COUNT(*) FROM accounts
UNION ALL
SELECT 'Transactions', COUNT(*) FROM transactions;
