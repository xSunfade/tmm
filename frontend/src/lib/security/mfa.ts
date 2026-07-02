import { getSupabaseClient } from '../supabaseClient';

const STEP_UP_STORAGE_PREFIX = 'tmm_plaid_step_up_verified_at_';
const RECOMMENDATION_DISMISSED_PREFIX = 'tmm_mfa_recommendation_dismissed_at_';
const STEP_UP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECOMMENDATION_DISMISS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type MfaFactorSummary = {
  id: string;
  factorType?: string;
  status?: string;
  friendlyName?: string;
};

export type MfaStatus = {
  hasVerifiedFactor: boolean;
  verifiedFactors: MfaFactorSummary[];
  aal?: string | null;
};

function makeScopedKey(prefix: string, userId?: string | null): string | null {
  if (!userId) return null;
  return `${prefix}${userId}`;
}

function readTimestamp(key: string | null): number | null {
  if (!key) return null;
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function writeTimestamp(key: string | null, timestampMs: number) {
  if (!key) return;
  if (typeof window === 'undefined') return;
  localStorage.setItem(key, String(timestampMs));
}

function clearTimestamp(key: string | null) {
  if (!key) return;
  if (typeof window === 'undefined') return;
  localStorage.removeItem(key);
}

export function hasFreshPlaidStepUp(userId?: string | null): boolean {
  const ts = readTimestamp(makeScopedKey(STEP_UP_STORAGE_PREFIX, userId));
  if (!ts) return false;
  return Date.now() - ts <= STEP_UP_TTL_MS;
}

export function markPlaidStepUpVerified(userId?: string | null) {
  writeTimestamp(makeScopedKey(STEP_UP_STORAGE_PREFIX, userId), Date.now());
}

export function clearPlaidStepUpVerification(userId?: string | null) {
  clearTimestamp(makeScopedKey(STEP_UP_STORAGE_PREFIX, userId));
}

export function dismissMfaRecommendation(userId?: string | null) {
  writeTimestamp(makeScopedKey(RECOMMENDATION_DISMISSED_PREFIX, userId), Date.now());
}

export function shouldShowMfaRecommendation(userId?: string | null): boolean {
  const ts = readTimestamp(makeScopedKey(RECOMMENDATION_DISMISSED_PREFIX, userId));
  if (!ts) return true;
  return Date.now() - ts > RECOMMENDATION_DISMISS_WINDOW_MS;
}

export function clearMfaRecommendationDismissal(userId?: string | null) {
  clearTimestamp(makeScopedKey(RECOMMENDATION_DISMISSED_PREFIX, userId));
}

export async function getMfaStatus(): Promise<MfaStatus> {
  const supabase = getSupabaseClient();
  const mfaApi = (supabase.auth as any).mfa;
  if (!mfaApi?.listFactors) {
    return { hasVerifiedFactor: false, verifiedFactors: [], aal: null };
  }

  const { data: factorsData, error: factorsError } = await mfaApi.listFactors();
  if (factorsError) throw factorsError;

  const allFactors: any[] = [
    ...(factorsData?.all || []),
    ...(factorsData?.totp || [])
  ];
  const dedupById = new Map<string, any>();
  allFactors.forEach((factor) => {
    if (factor?.id) dedupById.set(factor.id, factor);
  });
  const verifiedFactors = Array.from(dedupById.values()).filter((factor) => factor?.status === 'verified');

  let aal: string | null = null;
  if (mfaApi.getAuthenticatorAssuranceLevel) {
    const { data } = await mfaApi.getAuthenticatorAssuranceLevel();
    aal = data?.currentLevel || null;
  }

  return {
    hasVerifiedFactor: verifiedFactors.length > 0,
    verifiedFactors: verifiedFactors.map((factor) => ({
      id: factor.id,
      factorType: factor.factor_type,
      status: factor.status,
      friendlyName: factor.friendly_name
    })),
    aal
  };
}

export async function enrollTotpFactor() {
  const supabase = getSupabaseClient();
  const mfaApi = (supabase.auth as any).mfa;
  if (!mfaApi?.enroll) throw new Error('MFA enrollment is not available');
  const { data, error } = await mfaApi.enroll({
    factorType: 'totp',
    friendlyName: 'TMM Plaid MFA'
  });
  if (error) throw error;
  return data;
}

export async function challengeFactor(factorId: string) {
  const supabase = getSupabaseClient();
  const mfaApi = (supabase.auth as any).mfa;
  if (!mfaApi?.challenge) throw new Error('MFA challenge is not available');
  const { data, error } = await mfaApi.challenge({ factorId });
  if (error) throw error;
  return data;
}

export async function verifyChallenge(factorId: string, challengeId: string, code: string) {
  const supabase = getSupabaseClient();
  const mfaApi = (supabase.auth as any).mfa;
  if (!mfaApi?.verify) throw new Error('MFA verification is not available');
  const { data, error } = await mfaApi.verify({
    factorId,
    challengeId,
    code
  });
  if (error) throw error;
  return data;
}
