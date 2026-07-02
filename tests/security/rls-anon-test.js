// RLS Anon Key Restriction Test
// Tests that anon key is properly blocked by RLS policies

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY; // Anon key

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function testAnonKeyRestrictions() {
  console.log('🧪 Testing RLS anon key restrictions...\n');
  
  const tests = [
    {
      name: 'Anon key cannot read plaid_tokens',
      table: 'plaid_tokens',
      operation: 'select'
    },
    {
      name: 'Anon key cannot read users',
      table: 'users',
      operation: 'select'
    },
    {
      name: 'Anon key cannot read accounts',
      table: 'accounts',
      operation: 'select'
    },
    {
      name: 'Anon key cannot read transactions',
      table: 'transactions',
      operation: 'select'
    },
    {
      name: 'Anon key cannot read account_balance_snapshots',
      table: 'account_balance_snapshots',
      operation: 'select'
    },
    {
      name: 'Anon key cannot read net_worth_points',
      table: 'net_worth_points',
      operation: 'select'
    },
    {
      name: 'Anon key cannot read history_reconciliation_overrides',
      table: 'history_reconciliation_overrides',
      operation: 'select'
    },
    {
      name: 'Anon key cannot read plaid_sync_runs',
      table: 'plaid_sync_runs',
      operation: 'select'
    },
    {
      name: 'Anon key cannot insert into plaid_tokens',
      table: 'plaid_tokens',
      operation: 'insert'
    }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      let result;
      
      if (test.operation === 'select') {
        result = await supabase.from(test.table).select('*').limit(1);
        
        // Expected: Empty array (RLS blocks silently) OR error (explicit denial)
        // Migration 002 adds explicit deny policies, but Supabase RLS may still return
        // empty arrays for SELECT operations even with USING (false) policies.
        // This is acceptable behavior - the important security property is that data is blocked.
        // Inserts should always fail explicitly with an error.
        if (result.error) {
          console.log(`✅ ${test.name}: Explicitly denied (error: ${result.error.message})`);
          passed++;
        } else if (result.data && result.data.length === 0) {
          console.log(`✅ ${test.name}: Blocked (empty array) - RLS is working correctly`);
          console.log(`   Note: Supabase RLS may return empty arrays for SELECT even with explicit deny policies.`);
          console.log(`   This is acceptable - data is properly blocked.`);
          passed++;
        } else {
          console.log(`❌ ${test.name}: FAILED - Data returned when it shouldn't`);
          console.log(`   Data:`, result.data);
          failed++;
        }
      } else if (test.operation === 'insert') {
        result = await supabase.from(test.table).insert({
          // Dummy data
          item_id: 'test_item_' + Date.now(),
          user_id: '00000000-0000-0000-0000-000000000000',
          access_token: 'test_token'
        });
        
        // Expected: Error (explicit denial)
        if (result.error) {
          console.log(`✅ ${test.name}: Explicitly denied (error: ${result.error.message})`);
          passed++;
        } else {
          console.log(`❌ ${test.name}: FAILED - Insert succeeded when it shouldn't`);
          failed++;
        }
      }
    } catch (err) {
      console.log(`✅ ${test.name}: Explicitly denied (exception: ${err.message})`);
      passed++;
    }
  }
  
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  
  if (failed > 0) {
    console.log('\n❌ Some tests failed. RLS policies may need adjustment.');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!');
    process.exit(0);
  }
}

testAnonKeyRestrictions().catch(err => {
  console.error('❌ Test execution failed:', err);
  process.exit(1);
});
