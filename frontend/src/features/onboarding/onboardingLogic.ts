import { getOnboardingStatus, isOnboardingCompleted } from './onboardingStorage';

const allowlistRaw = import.meta.env.VITE_DEV_FORCE_ONBOARDING_ALLOWLIST as string | undefined;
const allowlist = allowlistRaw
  ? allowlistRaw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  : [];

type OnboardingContext = {
  email?: string | null;
  forceOnboarding?: boolean;
};

export function needsOnboarding({ email, forceOnboarding }: OnboardingContext): boolean {
  if (forceOnboarding) {
    return true;
  }

  const status = getOnboardingStatus();
  if (status.surveyCompleted && status.hasPath) {
    return false;
  }

  const completed = isOnboardingCompleted();

  if (allowlist.length === 0) {
    return !completed;
  }

  if (email && allowlist.includes(email.toLowerCase())) {
    return true;
  }

  return !completed;
}
