import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

const ONBOARDING_STORAGE_KEY = 'tmm_onboarding_state';
const TOUR_VERSION = '1.0';

export type OnboardingSurvey = {
  primary_goal?: string;
  experience_level?: string;
  data_preference?: string;
  time_horizon?: string;
};

export type OnboardingStatePayload = {
  onboardingCompleted?: boolean;
  surveyCompleted?: boolean;
  surveyResponses?: OnboardingSurvey | null;
  currentPath?: string[];
  currentModule?: string | null;
  currentStepId?: string | null;
  completedModules?: string[];
  tourVersion?: string;
};

export function readOnboardingPayload(): OnboardingStatePayload | null {
  try {
    const raw = getScopedLocalStorageItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as OnboardingStatePayload;
  } catch (error) {
    console.warn('[onboarding] Failed to parse onboarding state', error);
    return null;
  }
}

export function isOnboardingCompleted(): boolean {
  const payload = readOnboardingPayload();
  return payload?.onboardingCompleted === true && payload?.tourVersion === TOUR_VERSION;
}

export function setOnboardingCompleted(completed: boolean) {
  const payload = readOnboardingPayload() ?? {};
  payload.onboardingCompleted = completed;
  payload.tourVersion = TOUR_VERSION;
  try {
    setScopedLocalStorageItem(ONBOARDING_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('[onboarding] Failed to persist onboarding state', error);
  }
}

export function setOnboardingSurvey(responses: OnboardingSurvey, path: string[]) {
  const payload = readOnboardingPayload() ?? {};
  payload.surveyCompleted = true;
  payload.surveyResponses = responses;
  payload.currentPath = path;
  payload.currentModule = path[0] ?? payload.currentModule ?? null;
  payload.currentStepId = payload.currentStepId ?? null;
  payload.completedModules = payload.completedModules ?? [];
  payload.tourVersion = TOUR_VERSION;
  try {
    setScopedLocalStorageItem(ONBOARDING_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('[onboarding] Failed to persist onboarding survey', error);
  }
}

export function markModuleCompleted(moduleId: string) {
  const payload = readOnboardingPayload() ?? {};
  const completed = new Set(payload.completedModules ?? []);
  completed.add(moduleId);
  payload.completedModules = Array.from(completed);
  payload.currentModule = moduleId;
  payload.tourVersion = TOUR_VERSION;
  try {
    setScopedLocalStorageItem(ONBOARDING_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('[onboarding] Failed to persist module completion', error);
  }
}

export function setOnboardingCurrentModule(moduleId: string | null) {
  const payload = readOnboardingPayload() ?? {};
  payload.currentModule = moduleId;
  payload.tourVersion = TOUR_VERSION;
  try {
    setScopedLocalStorageItem(ONBOARDING_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('[onboarding] Failed to persist current module', error);
  }
}

export function setOnboardingCurrentStep(stepId: string | null) {
  const payload = readOnboardingPayload() ?? {};
  payload.currentStepId = stepId;
  payload.tourVersion = TOUR_VERSION;
  try {
    setScopedLocalStorageItem(ONBOARDING_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('[onboarding] Failed to persist current step', error);
  }
}

export function getOnboardingStatus() {
  const payload = readOnboardingPayload();
  return {
    completed: payload?.onboardingCompleted === true,
    surveyCompleted: payload?.surveyCompleted === true,
    hasPath: (payload?.currentPath || []).length > 0
  };
}

export function getOnboardingPath(): string[] {
  const payload = readOnboardingPayload();
  return payload?.currentPath ?? [];
}

export function resetOnboardingProgress() {
  const payload = readOnboardingPayload() ?? {};
  payload.completedModules = [];
  payload.currentModule = null;
  payload.currentStepId = null;
  payload.tourVersion = TOUR_VERSION;
  try {
    setScopedLocalStorageItem(ONBOARDING_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('[onboarding] Failed to reset onboarding progress', error);
  }
}
