import { isOnboardingCompleted } from './onboardingStorage';
import { getTourProgress, isTourCompleted } from '../tour/tourStorage';
import {
  getScopedLocalStorageItem,
  getScopedSessionStorageItem,
  removeScopedLocalStorageItem,
  removeScopedSessionStorageItem,
  setScopedLocalStorageItem,
  setScopedSessionStorageItem
} from '../../lib/storage/userScopedStorage';

const ABANDONMENT_KEY = 'tmm_onboarding_abandonment_date';
const PROMPT_SHOWN_KEY = 'tmm_onboarding_abandonment_prompt_shown';

function readIso(key: string) {
  return getScopedLocalStorageItem(key) || null;
}

function daysSince(isoString: string | null) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

export function markOnboardingAbandoned() {
  try {
    setScopedLocalStorageItem(ABANDONMENT_KEY, new Date().toISOString());
  } catch (error) {
    console.warn('[onboarding] Failed to persist abandonment date', error);
  }
}

export function clearAbandonmentRecord() {
  try {
    removeScopedLocalStorageItem(ABANDONMENT_KEY);
    removeScopedSessionStorageItem(PROMPT_SHOWN_KEY);
  } catch (error) {
    console.warn('[onboarding] Failed to clear abandonment record', error);
  }
}

export function markAbandonmentPromptShown() {
  try {
    setScopedSessionStorageItem(PROMPT_SHOWN_KEY, 'true');
  } catch (error) {
    console.warn('[onboarding] Failed to mark prompt shown', error);
  }
}

export function getOnboardingResumeEligibility() {
  const onboardingCompleted = isOnboardingCompleted();
  const tourCompleted = isTourCompleted();
  const progress = getTourProgress();
  const abandonmentIso = readIso(ABANDONMENT_KEY);
  const days = daysSince(abandonmentIso);
  const promptShown = getScopedSessionStorageItem(PROMPT_SHOWN_KEY) === 'true';

  const eligible =
    !onboardingCompleted &&
    !tourCompleted &&
    Boolean(progress && progress !== '0') &&
    days !== null &&
    days >= 0 &&
    days <= 6 &&
    !promptShown;

  return {
    eligible,
    daysSinceAbandonment: days,
    promptShown
  };
}
