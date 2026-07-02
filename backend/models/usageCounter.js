import { supabaseAdmin } from '../supabaseClient.js';

export async function incrementUsageCounter({
  metric,
  userId,
  itemId = null,
  windowSeconds,
  max
}) {
  const { data, error } = await supabaseAdmin.rpc('increment_usage_counter', {
    p_metric: metric,
    p_user_id: userId,
    p_item_id: itemId,
    p_window_seconds: windowSeconds,
    p_max: max
  });
  if (error) {
    throw new Error(`Failed to increment usage counter: ${error.message}`);
  }
  return Array.isArray(data) && data.length > 0
    ? data[0]
    : { allowed: true, count: 0, bucket_start: null };
}

