// Scheduled entitlement sweeps (Phase 4.4 / D11): grace expiry is enforced by
// us on a schedule, never solely by trusting Stripe to send a follow-up event.
//
// Day-7 rule: a profile still past_due when grace_expires_at passes is
// downgraded to Free, its history archived, and its Plaid items suspended
// (ADR-6). Restoration is instant when payment is cured (webhook path).

import { supabaseAdmin } from '../supabaseClient.js';
import { writeAuditLog } from './auditLog.js';
import { suspendPlaidForUser } from './plaidLifecycle.js';
import { createArchiveSnapshotForUser } from './historyService.js';

export async function runGraceExpirySweep({
  now = new Date(),
  db = supabaseAdmin,
  archiveSnapshot = createArchiveSnapshotForUser
} = {}) {
  if (!db) return { downgraded: 0 };

  const { data: rows, error } = await db
    .from('profiles')
    .select('id, plan_tier, subscription_status, grace_expires_at')
    .eq('subscription_status', 'past_due')
    .not('grace_expires_at', 'is', null)
    .lt('grace_expires_at', now.toISOString())
    .neq('plan_tier', 'free');
  if (error) {
    throw new Error(`Grace expiry sweep query failed: ${error.message}`);
  }

  let downgraded = 0;
  for (const row of rows || []) {
    try {
      try {
        await archiveSnapshot(row.id, {
          pointSource: 'plaid_archived',
          metadata: { trigger: 'grace_expiry_sweep' }
        });
      } catch (archiveErr) {
        console.error(`Grace-expiry archive hook failed for ${row.id}:`, archiveErr.message);
      }

      const { error: updateError } = await db
        .from('profiles')
        .update({ plan_tier: 'free' })
        .eq('id', row.id);
      if (updateError) {
        throw new Error(`Failed to downgrade ${row.id}: ${updateError.message}`);
      }

      await suspendPlaidForUser(row.id, { reason: 'grace_expired', db });
      await writeAuditLog({
        db,
        userId: row.id,
        actor: 'system',
        action: 'entitlement.grace_expired_downgrade',
        metadata: { previous_tier: row.plan_tier, grace_expires_at: row.grace_expires_at }
      });
      downgraded += 1;
    } catch (err) {
      console.error(JSON.stringify({
        type: 'grace_expiry_sweep_user_failed',
        userId: row.id,
        message: err?.message || String(err),
        timestamp: new Date().toISOString()
      }));
    }
  }

  if (downgraded > 0) {
    console.log(JSON.stringify({
      type: 'grace_expiry_sweep',
      downgraded,
      timestamp: new Date().toISOString()
    }));
  }
  return { downgraded };
}
