// Plan tiers (Phase 4 / D7). `null` = still loading. Paid checks must use
// isPaidTier — never compare against 'tmm_plus' directly, or TMM Pro users
// lose features.

export type PlanTier = 'free' | 'tmm_plus' | 'tmm_pro';

export function isPaidTier(tier: PlanTier | null | undefined): boolean {
  return tier === 'tmm_plus' || tier === 'tmm_pro';
}

export function tierLabel(tier: PlanTier | null | undefined): string {
  if (tier === 'tmm_plus') return 'TMM+';
  if (tier === 'tmm_pro') return 'TMM Pro';
  return 'Free';
}
