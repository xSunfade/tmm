import React, { useEffect, useMemo } from 'react';
import { useAppDispatch, useAppState } from '../state/appState';
import { resolveUiFlowState, UiFlowState } from '../state/flowState';
import { getRestoreEligibility, hasMeaningfulData } from '../features/restore/restoreEligibility';
import {
  getOnboardingPath,
  resetOnboardingProgress,
  setOnboardingCompleted,
  setOnboardingCurrentModule,
  setOnboardingCurrentStep
} from '../features/onboarding/onboardingStorage';
import { needsOnboarding } from '../features/onboarding/onboardingLogic';
import { bootstrapLocalState, persistSheetsDismissed, persistSheetsOAuthDone } from '../state/localBootstrap';
 
import { usePlanStore } from '../lib/plan/planStore';
import { loadPlanSnapshot, setRestoreDecline, getRestoreSnapshotId } from '../lib/plan/planPersistence';
import { DEFAULT_PLAN_STATE } from '../lib/plan/defaults';
import { createMonthlyCheckpointIfNeeded } from '../lib/simulation/checkpoints';
import { getEffectiveValue } from '../lib/plan/overrideManager';
import { getGoogleAuthUrl, getGoogleTokenStatus } from '../lib/sheets/api';
import { getSheetsPrefs, setSheetsPrefs } from '../lib/sheets/sheetsPrefs';
import { getStoredSheetId, setStoredSheetId } from '../lib/sheets/storage';
import { flushSheetQueue } from '../lib/sheets/sync';
import { ConnectSheetsNudge } from '../components/overlays/ConnectSheetsNudge';
import { OnboardingOverlay } from '../components/overlays/OnboardingOverlay';
import { OnboardingResumeOverlay } from '../components/overlays/OnboardingResumeOverlay';
import { RestoreSessionOverlay } from '../components/overlays/RestoreSessionOverlay';
import { SplashScreen } from '../components/overlays/SplashScreen';
import { SplashLoginOverlay } from '../components/overlays/SplashLoginOverlay';
import { TourSpotlightOverlay } from '../components/tour/TourSpotlightOverlay';
import { AppLayout } from './AppLayout';
import { getTourEligibility, getTourProgress } from '../features/tour/tourStorage';
import { buildLegacyTourSteps } from '../features/tour/legacyTourSteps';
import { startTour, getTourState } from '../features/tour/tourManager';
import { getOnboardingResumeEligibility, clearAbandonmentRecord } from '../features/onboarding/onboardingAbandonment';
import { setTourProgress } from '../features/tour/tourStorage';
import { initTheme } from '../lib/theme/theme';
import { authFetch } from '../lib/api/authFetch';
import { triggerPlaidTransactionsSync } from '../lib/plaid/transactionsSync';
import { AppSpinner } from '../components/AppSpinner';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { DashboardScreen } from '../features/dashboard/DashboardScreen';
import { AccountsScreen } from '../features/accounts/AccountsScreen';
import { PipelineScreen } from '../features/pipeline/PipelineScreen';
import { SimulationScreen } from '../features/simulation/SimulationScreen';
import { AccountIntegrationScreen } from '../features/accountIntegration/AccountIntegrationScreen';
import { GoalsScreen } from '../features/goals/GoalsScreen';
import { PrivacyScreen } from '../features/privacy/PrivacyScreen';
import { applyConnectedBalancesToPlan } from '../features/accountIntegration/applyConnectedToPlan';
import {
  flattenPlaidItemsToConnectedAccounts,
  loadPlaidItemsWithAccountsResponse
} from '../features/accountIntegration/legacyAdapters';
import type { AppRoute } from './routing';
import { isRoute, navigateToRoute, usePathname } from './routing';
import type { PlanState } from '../lib/plan/types';

function computePerAltNetWorthPoints(plan: PlanState) {
  const points: Array<{ alt: string; net_worth: number }> = [];
  for (const alt of Object.keys(plan.alternatives || {})) {
    const alternative = plan.alternatives[alt];
    if (!alternative) continue;
    const assets = (alternative.asset || []).reduce((sum, row) => sum + getEffectiveValue(row), 0);
    const debts = (alternative.debt || []).reduce((sum, row) => sum + getEffectiveValue(row), 0);
    points.push({
      alt,
      net_worth: assets - debts
    });
  }
  return points;
}

export function AppShell() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const { state: planState, dispatch: planDispatch } = usePlanStore();
  const pathname = usePathname();
  const [showLogin, setShowLogin] = React.useState(false);
  const [authIntent, setAuthIntent] = React.useState<'login' | 'signup'>('login');
  const [resumeDays, setResumeDays] = React.useState<number | null>(null);
  const pendingPlanSnapshot = useMemo(
    () => (state.readiness.authReady ? loadPlanSnapshot() : { ...DEFAULT_PLAN_STATE }),
    [state.readiness.authReady, state.auth.userId]
  );
  const isDashboardRoute = isRoute(pathname, 'dashboard') || isRoute(pathname, 'home');
  const isAccountsRoute = isRoute(pathname, 'accounts');
  const isPipelineRoute = isRoute(pathname, 'pipeline');
  const isSimulationRoute = isRoute(pathname, 'simulation');
  const isAccountIntegrationRoute = isRoute(pathname, 'account-integration');
  const isGoalsRoute = isRoute(pathname, 'goals');
  const isSettingsRoute = isRoute(pathname, 'settings');
  const isPrivacyRoute = isRoute(pathname, 'privacy');
  const search = window.location.search;
  const plaidBaseUrl = useMemo(
    () => (planState.plaidConfig?.backendApiUrl || '').replace(/\/$/, ''),
    [planState.plaidConfig?.backendApiUrl]
  );
  const plaidSyncAttemptRef = React.useRef<string | null>(null);
  const syncPollRunningRef = React.useRef<boolean>(state.plaid.syncRunning);
  const planStateRef = React.useRef(planState);
  const postSyncRefreshInFlightRef = React.useRef(false);

  useEffect(() => {
    syncPollRunningRef.current = state.plaid.syncRunning;
  }, [state.plaid.syncRunning]);

  useEffect(() => {
    planStateRef.current = planState;
  }, [planState]);

  useEffect(() => {
    initTheme('dark-green');
  }, []);

  useEffect(() => {
    if (state.readiness.authReady && (!state.readiness.profileReady || !state.readiness.integrationsReady)) {
      bootstrapLocalState(dispatch);
    }
  }, [dispatch, state.readiness.authReady, state.readiness.integrationsReady, state.readiness.profileReady]);

  // Sync sheets.connected and sheets prefs (dismissed, spreadsheetId) with backend when auth is ready
  useEffect(() => {
    if (!state.readiness.authReady || state.readiness.integrationsReady !== true || state.auth.status !== 'authenticated') return;
    let cancelled = false;
    console.info('[sheets] getGoogleTokenStatus effect running');
    getGoogleTokenStatus()
      .then((data) => {
        if (cancelled) {
          console.info('[sheets] getGoogleTokenStatus resolved but skipped (effect already cleaned up)');
          return;
        }
        const connected = Boolean(data?.connected);
        console.info('[sheets] getGoogleTokenStatus resolved, dispatching connectionVerified=true', { connected });
        dispatch({ type: 'sheets', connected, dismissed: state.sheets.dismissed, connectionVerified: true });
        persistSheetsOAuthDone(connected);
        return getSheetsPrefs()
          .then((prefs) => ({ connected, prefs }))
          .catch(() => ({ connected, prefs: null }));
      })
      .then((result) => {
        if (cancelled || !result?.prefs) return;
        const { connected, prefs } = result;
        dispatch({ type: 'sheets', connected, dismissed: prefs.sheetsNudgeDismissed, spreadsheetId: prefs.lastSpreadsheetId ?? undefined });
        if (prefs.lastSpreadsheetId) setStoredSheetId(prefs.lastSpreadsheetId);
      })
      .catch((err) => {
        if (cancelled) {
          console.info('[sheets] getGoogleTokenStatus failed but skipped (effect already cleaned up)');
          return;
        }
        console.warn('[sheets] getGoogleTokenStatus failed', err);
        dispatch({ type: 'sheets', connected: false, dismissed: state.sheets.dismissed, connectionVerified: true });
        persistSheetsOAuthDone(false);
      });
    return () => {
      cancelled = true;
      console.info('[sheets] getGoogleTokenStatus effect cleanup');
    };
  }, [dispatch, state.readiness.authReady, state.readiness.integrationsReady, state.auth.status, state.sheets.dismissed]);

  useEffect(() => {
    if (!state.readiness.authReady || state.auth.status !== 'authenticated') return;
    if (!state.auth.userId || state.auth.planTier !== 'tmm_plus' || !plaidBaseUrl) return;
    const key = `${state.auth.userId}:${plaidBaseUrl}`;
    if (plaidSyncAttemptRef.current === key) return;
    plaidSyncAttemptRef.current = key;
    triggerPlaidTransactionsSync(plaidBaseUrl, { userInitiated: false }).catch((error) => {
      console.warn('[plaid] Background sync trigger failed', error);
    });
  }, [
    state.readiness.authReady,
    state.auth.status,
    state.auth.userId,
    state.auth.planTier,
    plaidBaseUrl
  ]);

  useEffect(() => {
    if (!state.readiness.authReady || state.auth.status !== 'authenticated') return;
    if (!state.auth.userId || state.auth.planTier !== 'tmm_plus' || !plaidBaseUrl) {
      if (syncPollRunningRef.current) {
        syncPollRunningRef.current = false;
        dispatch({ type: 'plaid', syncRunning: false });
      }
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;

    const runPostSyncRefresh = async () => {
      if (postSyncRefreshInFlightRef.current) return;
      postSyncRefreshInFlightRef.current = true;
      try {
        const response = await loadPlaidItemsWithAccountsResponse(plaidBaseUrl, authFetch);
        if (cancelled) return;

        const plaidAccounts = flattenPlaidItemsToConnectedAccounts(response.items || []);
        const nextPlan = applyConnectedBalancesToPlan(planStateRef.current, plaidAccounts);
        if (nextPlan && !cancelled) {
          planDispatch({ type: 'hydrate', plan: nextPlan });
        }
        const historyPlan = nextPlan || planStateRef.current;
        const points = computePerAltNetWorthPoints(historyPlan);
        if (points.length) {
          try {
            await authFetch(`${plaidBaseUrl}/api/history/net-worth/tmm`, {
              method: 'POST',
              body: JSON.stringify({ points })
            });
          } catch (error) {
            console.warn('[plaid] Post-sync TMM history write failed', error);
          }
        }
      } catch (error) {
        console.warn('[plaid] Post-sync refresh failed', error);
      } finally {
        postSyncRefreshInFlightRef.current = false;
      }
    };

    const pollSyncStatus = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const status = await authFetch(`${plaidBaseUrl}/api/plaid/sync/status`, { method: 'GET' });
        if (cancelled) return;
        const running = !!status?.running;

        if (running) {
          syncPollRunningRef.current = true;
          dispatch({ type: 'plaid', syncRunning: true });
          return;
        }

        if (!syncPollRunningRef.current) {
          return;
        }

        if (postSyncRefreshInFlightRef.current) {
          return;
        }

        syncPollRunningRef.current = false;
        const syncLastCompletedAt = new Date().toISOString();
        await runPostSyncRefresh();
        if (cancelled) return;
        dispatch({
          type: 'plaid',
          syncRunning: false,
          syncLastCompletedAt
        });
      } catch (error) {
        if (!cancelled) {
          console.warn('[plaid] Failed to poll sync status', error);
        }
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void pollSyncStatus();
      }
    };

    void pollSyncStatus();
    intervalId = window.setInterval(() => {
      void pollSyncStatus();
    }, 4000);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [
    dispatch,
    planDispatch,
    plaidBaseUrl,
    state.auth.planTier,
    state.auth.status,
    state.auth.userId,
    state.readiness.authReady
  ]);

  useEffect(() => {
    if (!state.readiness.authReady || state.readiness.appDataReady) {
      return;
    }

    const eligibility = getRestoreEligibility(pendingPlanSnapshot);
    // Only show Restore when saved snapshot has data but current plan does not (e.g. user declined restore).
    // When we load from storage on init, planState already has the data, so we skip the overlay.
    const shouldShowRestore = eligibility.eligible && !hasMeaningfulData(planState);
    dispatch({
      type: 'restore',
      available: shouldShowRestore,
      reason: eligibility.reason,
      meta: eligibility.meta
    });
    dispatch({ type: 'readiness', key: 'appDataReady', value: true });
  }, [dispatch, planState, state.readiness.appDataReady, state.readiness.authReady]);

  useEffect(() => {
    if (!state.readiness.authReady || state.auth.status !== 'authenticated') return;
    if (!search.includes('sheets=connected')) return;
    const init = () => {
      persistSheetsOAuthDone(true);
      dispatch({ type: 'sheets', connected: true, dismissed: false, connectionVerified: true });
      window.history.replaceState({}, '', window.location.pathname);
    };
    init();
  }, [dispatch, search, state.auth.status, state.readiness.authReady]);

  useEffect(() => {
    if (!state.readiness.authReady || state.auth.status !== 'authenticated') return;
    if (!isAccountIntegrationRoute) return;
    if (state.auth.planTier === 'tmm_plus') return;
    navigateToRoute('dashboard');
  }, [
    isAccountIntegrationRoute,
    state.auth.planTier,
    state.auth.status,
    state.readiness.authReady
  ]);

  useEffect(() => {
    if (!state.readiness.appDataReady) return;
    let updated = false;
    const nextPlan = JSON.parse(JSON.stringify(planState));
    Object.keys(nextPlan.alternatives || {}).forEach((altName) => {
      const created = createMonthlyCheckpointIfNeeded(nextPlan, altName);
      if (created) updated = true;
    });
    if (updated) {
      planDispatch({ type: 'hydrate', plan: nextPlan });
    }
  }, [planDispatch, planState, state.readiness.appDataReady]);

  useEffect(() => {
    const sheetId = getStoredSheetId();
    if (!sheetId) return;
    const flush = () => {
      if (navigator.onLine) {
        flushSheetQueue(sheetId).catch((error) => {
          console.warn('[sheets] Queue flush failed', error);
        });
      }
    };
    flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, []);

  useEffect(() => {
    if (!state.readiness.authReady || state.auth.status !== 'authenticated') {
      return;
    }
    const nextNeedsOnboarding = needsOnboarding({
      email: state.auth.email,
      forceOnboarding: state.dev.forceOnboarding
    });
    if (state.onboarding.needsOnboarding !== nextNeedsOnboarding) {
      dispatch({ type: 'onboarding', needsOnboarding: nextNeedsOnboarding });
    }
  }, [
    dispatch,
    state.auth.status,
    state.auth.email,
    state.dev.forceOnboarding,
    state.onboarding.needsOnboarding,
    state.readiness.authReady
  ]);

  useEffect(() => {
    if (!state.readiness.authReady || state.auth.status !== 'authenticated') {
      return;
    }
    const eligibility = getOnboardingResumeEligibility();
    setResumeDays(eligibility.daysSinceAbandonment ?? null);
    if (state.onboarding.resumeAvailable !== eligibility.eligible) {
      dispatch({
        type: 'onboarding',
        needsOnboarding: state.onboarding.needsOnboarding,
        resumeAvailable: eligibility.eligible
      });
    }
  }, [
    dispatch,
    state.auth.status,
    state.onboarding.needsOnboarding,
    state.onboarding.resumeAvailable,
    state.readiness.authReady
  ]);

  useEffect(() => {
    if (!state.readiness.authReady || state.auth.status !== 'authenticated') {
      return;
    }
    const tourEligible = getTourEligibility();
    const higherPriority =
      state.dev.forceOnboarding ||
      state.onboarding.needsOnboarding ||
      state.onboarding.resumeAvailable ||
      (state.readiness.appDataReady && state.restore.available) ||
      (state.readiness.integrationsReady && !state.sheets.connected && !state.sheets.dismissed);

    const shouldBeActive = tourEligible && !higherPriority;
    if (state.onboarding.tourActive !== shouldBeActive) {
      dispatch({ type: 'tour', tourActive: shouldBeActive });
    }
  }, [
    dispatch,
    state.auth.status,
    state.dev.forceOnboarding,
    state.onboarding.needsOnboarding,
    state.onboarding.tourActive,
    state.readiness.appDataReady,
    state.readiness.authReady,
    state.readiness.integrationsReady,
    state.restore.available,
    state.sheets.connected,
    state.sheets.dismissed
  ]);

  useEffect(() => {
    if (!state.onboarding.tourActive) {
      return;
    }
    const current = getTourState();
    if (current.status === 'active') {
      return;
    }
    const steps = buildLegacyTourSteps(getOnboardingPath());
    navigateToRoute((steps[0]?.route as AppRoute) ?? 'dashboard');
    const startAtId = getTourProgress() ?? undefined;
    startTour(steps, startAtId);
  }, [state.onboarding.tourActive]);

  const flow = useMemo(() => resolveUiFlowState(state), [state]);

  useEffect(() => {
    if (flow !== UiFlowState.AUTH) {
      setShowLogin(false);
      setAuthIntent('login');
    }
  }, [flow]);

  if (flow === UiFlowState.SPLASH) {
    return <SplashScreen mode="loading" />;
  }

  if (flow === UiFlowState.AUTH) {
    return (
      <div className="relative min-h-screen">
        <SplashScreen
          mode="unauthenticated"
          onLoginClick={() => {
            setAuthIntent('login');
            setShowLogin(true);
          }}
          onCreateAccountClick={() => {
            setAuthIntent('signup');
            setShowLogin(true);
          }}
        />
        {showLogin ? <SplashLoginOverlay initialIntent={authIntent} onClose={() => setShowLogin(false)} /> : null}
      </div>
    );
  }

  const overlay = (() => {
    switch (flow) {
      case UiFlowState.ONBOARDING:
        return (
          <OnboardingOverlay
            onComplete={() => {
              dispatch({ type: 'dev', forceOnboarding: false });
              dispatch({ type: 'onboarding', needsOnboarding: false });
              dispatch({ type: 'tour', tourActive: true });
            }}
            onSkip={() => {
              setOnboardingCompleted(true);
              dispatch({ type: 'dev', forceOnboarding: false });
              dispatch({ type: 'onboarding', needsOnboarding: false });
            }}
          />
        );
      case UiFlowState.ONBOARDING_RESUME:
        return (
          <OnboardingResumeOverlay
            daysSinceAbandonment={resumeDays}
            onResume={() => {
              clearAbandonmentRecord();
              dispatch({ type: 'onboarding', needsOnboarding: false, resumeAvailable: false });
              dispatch({ type: 'tour', tourActive: true });
            }}
            onRestart={() => {
              const path = getOnboardingPath();
              const firstStep = path[0] ?? 'dashboard';
              resetOnboardingProgress();
              setOnboardingCurrentModule(firstStep);
              setOnboardingCurrentStep(firstStep);
              setTourProgress(firstStep);
              clearAbandonmentRecord();
              dispatch({ type: 'onboarding', needsOnboarding: false, resumeAvailable: false });
              dispatch({ type: 'tour', tourActive: true });
            }}
            onSkip={() => {
              dispatch({ type: 'onboarding', needsOnboarding: false, resumeAvailable: false });
            }}
          />
        );
      case UiFlowState.RESTORE_SESSION:
        return (
          <RestoreSessionOverlay
            reason={state.restore.reason}
            metadata={state.restore.meta}
            onRestore={async () => {
              planDispatch({ type: 'hydrate', plan: pendingPlanSnapshot });
              dispatch({ type: 'restore', available: false });
            }}
            onSkip={() => {
              const snapshotId = getRestoreSnapshotId(pendingPlanSnapshot);
              setRestoreDecline({ snapshotId, decidedAt: new Date().toISOString() });
              dispatch({ type: 'restore', available: false });
            }}
          />
        );
      case UiFlowState.CONNECT_SHEETS_NUDGE:
        return (
          <ConnectSheetsNudge
            onConnect={() => {
              persistSheetsDismissed(false);
              dispatch({ type: 'sheets', connected: false, dismissed: false });
              setSheetsPrefs({ sheetsNudgeDismissed: false });
              getGoogleAuthUrl()
                .then((url) => {
                  window.location.href = url;
                })
                .catch((error) => {
                  console.warn('[sheets] Failed to start OAuth flow', error);
                });
            }}
            onDismiss={() => {
              persistSheetsDismissed(true);
              dispatch({ type: 'sheets', connected: false, dismissed: true });
              setSheetsPrefs({ sheetsNudgeDismissed: true });
            }}
          />
        );
      case UiFlowState.TOUR:
        return <TourSpotlightOverlay onExit={() => dispatch({ type: 'tour', tourActive: false })} />;
      default:
        return null;
    }
  })();

  return (
    <div className="min-h-screen bg-slate-950">
      {(flow === UiFlowState.APP || flow === UiFlowState.TOUR) ? (
        <AppLayout>
          {isDashboardRoute ? <DashboardScreen /> : null}
          {isAccountsRoute ? <AccountsScreen /> : null}
          {isAccountIntegrationRoute && state.auth.planTier === 'tmm_plus' ? <AccountIntegrationScreen /> : null}
          {isGoalsRoute ? <GoalsScreen /> : null}
          {isPipelineRoute ? <PipelineScreen /> : null}
          {isSimulationRoute ? <SimulationScreen /> : null}
          {isSettingsRoute ? <SettingsScreen /> : null}
          {isPrivacyRoute ? <PrivacyScreen /> : null}
        </AppLayout>
      ) : null}
      {state.plaid.syncRunning && (flow === UiFlowState.APP || flow === UiFlowState.TOUR) ? (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 backdrop-blur-sm"
          role="status"
          aria-live="polite"
          aria-label="Fetching new data from Plaid"
        >
          <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-700/80 bg-slate-900/80 px-6 py-5">
            <AppSpinner />
            <p className="text-xs text-slate-200">Fetching new data from Plaid...</p>
          </div>
        </div>
      ) : null}
      {overlay}
    </div>
  );
}
