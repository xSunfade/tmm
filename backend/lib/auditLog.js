// Audit log writer (Phase 4): security-relevant transitions only.
// NEVER log tokens, plan contents, account numbers, or raw payloads here —
// userId, action names, resource ids, and error codes are the allowed set.

import { supabaseAdmin } from '../supabaseClient.js';

export async function writeAuditLog({ userId = null, actor = 'system', action, resource = null, metadata = {}, db = supabaseAdmin }) {
  try {
    if (!db || !action) return;
    const { error } = await db.from('audit_log').insert({
      user_id: userId,
      actor,
      action,
      resource,
      metadata: metadata || {}
    });
    if (error) {
      console.warn(JSON.stringify({
        type: 'audit_log_write_failed',
        action,
        message: error.message,
        timestamp: new Date().toISOString()
      }));
    }
  } catch (err) {
    console.warn(JSON.stringify({
      type: 'audit_log_write_failed',
      action,
      message: err?.message || String(err),
      timestamp: new Date().toISOString()
    }));
  }
}
