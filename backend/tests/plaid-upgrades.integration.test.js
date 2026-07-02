import test from 'node:test';
import assert from 'node:assert/strict';

const shouldRun = String(process.env.RUN_DB_INTEGRATION_TESTS || 'false').toLowerCase() === 'true';

test('increment_usage_counter RPC integration smoke test', { skip: !shouldRun }, async () => {
  const { supabaseAdmin } = await import('../supabaseClient.js');
  assert.ok(supabaseAdmin, 'supabaseAdmin is required for integration tests');

  const { data: profileRow, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .limit(1)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profileRow?.id) {
    test.skip('No profile rows available for integration smoke test');
    return;
  }

  const { data, error } = await supabaseAdmin.rpc('increment_usage_counter', {
    p_metric: 'integration_test_metric',
    p_user_id: profileRow.id,
    p_item_id: null,
    p_window_seconds: 3600,
    p_max: 9999
  });
  if (error) throw error;
  assert.ok(Array.isArray(data));
  assert.equal(typeof data[0]?.allowed, 'boolean');
  assert.equal(typeof data[0]?.count, 'number');
});

