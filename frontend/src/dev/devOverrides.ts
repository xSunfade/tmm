type DevOverrideResult = {
  forceOnboarding: boolean;
};

function readAllowlist(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveDevOverrides(email?: string): DevOverrideResult {
  const isDev = import.meta.env.DEV === true;
  const forceOnboardingFlag = import.meta.env.VITE_DEV_FORCE_ONBOARDING === 'true';
  const allowlist = readAllowlist(import.meta.env.VITE_DEV_FORCE_ONBOARDING_ALLOWLIST);

  if (!isDev) {
    return { forceOnboarding: false };
  }

  if (forceOnboardingFlag) {
    return { forceOnboarding: true };
  }

  if (allowlist.length === 0) {
    return { forceOnboarding: false };
  }

  const normalizedEmail = (email ?? '').toLowerCase();
  return { forceOnboarding: allowlist.includes(normalizedEmail) };
}
