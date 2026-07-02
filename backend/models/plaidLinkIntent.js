import crypto from 'crypto';
import { supabaseAdmin } from '../supabaseClient.js';

function hashPublicToken(publicToken) {
  if (!publicToken) return null;
  return crypto.createHash('sha256').update(String(publicToken)).digest('hex');
}

export async function startPlaidLinkIntent({ userId, linkIntentId, requestId, publicToken }) {
  const payload = {
    user_id: userId,
    link_intent_id: linkIntentId,
    status: 'started',
    request_id: requestId || null,
    public_token_hash: hashPublicToken(publicToken)
  };
  const { data, error } = await supabaseAdmin
    .from('plaid_link_intents')
    .insert(payload)
    .select('*')
    .single();
  if (!error) {
    return data;
  }
  // Duplicate key => intent already exists; caller handles based on existing row state.
  if (error.code === '23505') {
    return null;
  }
  throw new Error(`Failed to start link intent: ${error.message}`);
}

export async function getPlaidLinkIntent(userId, linkIntentId) {
  const { data, error } = await supabaseAdmin
    .from('plaid_link_intents')
    .select('*')
    .eq('user_id', userId)
    .eq('link_intent_id', linkIntentId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read link intent: ${error.message}`);
  }
  return data || null;
}

export async function completePlaidLinkIntent({ userId, linkIntentId, resultJson }) {
  const { data, error } = await supabaseAdmin
    .from('plaid_link_intents')
    .update({
      status: 'completed',
      result_json: resultJson || {},
      error_code: null,
      error_message: null,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .eq('link_intent_id', linkIntentId)
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to complete link intent: ${error.message}`);
  }
  return data;
}

export async function failPlaidLinkIntent({ userId, linkIntentId, errorCode, errorMessage }) {
  const { data, error } = await supabaseAdmin
    .from('plaid_link_intents')
    .update({
      status: 'failed',
      error_code: errorCode || null,
      error_message: errorMessage || 'Unknown error',
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .eq('link_intent_id', linkIntentId)
    .select('*')
    .single();
  if (error) {
    throw new Error(`Failed to fail link intent: ${error.message}`);
  }
  return data;
}

