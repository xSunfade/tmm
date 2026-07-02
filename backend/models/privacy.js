import { supabaseAdmin } from '../supabaseClient.js';

export const PLAID_CONSENT_TYPE = 'plaid_data_processing';
export const CURRENT_PRIVACY_POLICY_VERSION = '2026-02-09';

export async function recordPrivacyConsent({
  userId,
  consentType,
  policyVersion,
  accepted = true,
  metadata = {}
}) {
  const payload = {
    user_id: userId,
    consent_type: consentType,
    policy_version: policyVersion,
    accepted: !!accepted,
    metadata: metadata || {},
    consented_at: new Date().toISOString()
  };
  const { data, error } = await supabaseAdmin
    .from('privacy_consents')
    .insert(payload)
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to record privacy consent: ${error.message}`);
  }
  return data;
}

export async function getLatestConsent(userId, consentType) {
  const { data, error } = await supabaseAdmin
    .from('privacy_consents')
    .select('*')
    .eq('user_id', userId)
    .eq('consent_type', consentType)
    .order('consented_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load latest consent: ${error.message}`);
  }
  return data || null;
}

export async function createDeletionRequest(userId, metadata = {}) {
  const { data, error } = await supabaseAdmin
    .from('data_deletion_requests')
    .insert({
      user_id: userId,
      status: 'processing',
      metadata: metadata || {}
    })
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to create deletion request: ${error.message}`);
  }
  return data;
}

export async function completeDeletionRequest(id) {
  const { error } = await supabaseAdmin
    .from('data_deletion_requests')
    .update({
      status: 'completed',
      processed_at: new Date().toISOString()
    })
    .eq('id', id);
  if (error) {
    throw new Error(`Failed to complete deletion request: ${error.message}`);
  }
}

export async function failDeletionRequest(id, message) {
  const { error } = await supabaseAdmin
    .from('data_deletion_requests')
    .update({
      status: 'failed',
      error_message: message || 'unknown error',
      processed_at: new Date().toISOString()
    })
    .eq('id', id);
  if (error) {
    throw new Error(`Failed to mark deletion request failed: ${error.message}`);
  }
}
