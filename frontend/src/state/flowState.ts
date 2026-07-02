import type { AppState } from './appState';

export const UiFlowState = {
  SPLASH: 'SPLASH',
  AUTH: 'AUTH',
  ONBOARDING: 'ONBOARDING',
  ONBOARDING_RESUME: 'ONBOARDING_RESUME',
  TOUR: 'TOUR',
  RESTORE_SESSION: 'RESTORE_SESSION',
  CONNECT_SHEETS_NUDGE: 'CONNECT_SHEETS_NUDGE',
  APP: 'APP'
} as const;

export type UiFlowState = (typeof UiFlowState)[keyof typeof UiFlowState];

export function resolveUiFlowState(state: AppState): UiFlowState {
  if (!state.readiness.authReady || state.auth.status === 'unknown') {
    return UiFlowState.SPLASH;
  }

  if (state.auth.status === 'unauthenticated') {
    return UiFlowState.AUTH;
  }

  if (state.readiness.appDataReady && state.restore.available) {
    return UiFlowState.RESTORE_SESSION;
  }

  if (
    state.readiness.integrationsReady &&
    !state.sheets.connected &&
    !state.sheets.dismissed
  ) {
    return UiFlowState.CONNECT_SHEETS_NUDGE;
  }

  if (state.dev.forceOnboarding || state.onboarding.needsOnboarding) {
    return UiFlowState.ONBOARDING;
  }

  if (state.onboarding.resumeAvailable) {
    return UiFlowState.ONBOARDING_RESUME;
  }

  if (state.onboarding.tourActive) {
    return UiFlowState.TOUR;
  }

  return UiFlowState.APP;
}

export function explainUiFlowState(state: AppState): { flow: UiFlowState; reasons: string[] } {
  const reasons: string[] = [];

  if (!state.readiness.authReady || state.auth.status === 'unknown') {
    reasons.push(`authReady=${state.readiness.authReady}`);
    reasons.push(`auth.status=${state.auth.status}`);
    reasons.push(`profileReady=${state.readiness.profileReady}`);
    reasons.push(`integrationsReady=${state.readiness.integrationsReady}`);
    reasons.push(`appDataReady=${state.readiness.appDataReady}`);
    return { flow: UiFlowState.SPLASH, reasons };
  }

  if (state.auth.status === 'unauthenticated') {
    reasons.push('user is unauthenticated');
    return { flow: UiFlowState.AUTH, reasons };
  }

  if (state.readiness.appDataReady && state.restore.available) {
    reasons.push('restore.available=true');
    reasons.push('appDataReady=true');
    return { flow: UiFlowState.RESTORE_SESSION, reasons };
  }
  if (!state.readiness.appDataReady) {
    reasons.push('restore suppressed: appDataReady=false');
  } else if (!state.restore.available) {
    reasons.push('restore suppressed: restore.available=false');
  }

  if (
    state.readiness.integrationsReady &&
    !state.sheets.connected &&
    !state.sheets.dismissed
  ) {
    reasons.push('sheets.connected=false');
    reasons.push('sheets.dismissed=false');
    reasons.push('integrationsReady=true');
    return { flow: UiFlowState.CONNECT_SHEETS_NUDGE, reasons };
  }
  if (!state.readiness.integrationsReady) {
    reasons.push('connect sheets suppressed: integrationsReady=false');
  } else if (state.sheets.connected) {
    reasons.push('connect sheets suppressed: sheets.connected=true');
  } else if (state.sheets.dismissed) {
    reasons.push('connect sheets suppressed: sheets.dismissed=true');
  }

  if (state.dev.forceOnboarding) {
    reasons.push('dev.forceOnboarding=true');
    return { flow: UiFlowState.ONBOARDING, reasons };
  }
  reasons.push('dev.forceOnboarding=false');

  if (state.onboarding.needsOnboarding) {
    reasons.push('onboarding.needsOnboarding=true');
    return { flow: UiFlowState.ONBOARDING, reasons };
  }
  reasons.push('onboarding.needsOnboarding=false');

  if (state.onboarding.resumeAvailable) {
    reasons.push('onboarding.resumeAvailable=true');
    return { flow: UiFlowState.ONBOARDING_RESUME, reasons };
  }
  reasons.push('onboarding.resumeAvailable=false');

  if (state.onboarding.tourActive) {
    reasons.push('tourActive=true');
    return { flow: UiFlowState.TOUR, reasons };
  }
  reasons.push('tourActive=false');

  reasons.push('no overlay conditions met');
  return { flow: UiFlowState.APP, reasons };
}
