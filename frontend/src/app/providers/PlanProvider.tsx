import React, { useEffect, useMemo } from 'react';
import { PlanStoreProvider, usePlanStore } from '../../lib/plan/planStore';
import { loadPlanSnapshot, savePlanSnapshot } from '../../lib/plan/planPersistence';
import { useAppState } from '../../state/appState';
import { DEFAULT_PLAN_STATE } from '../../lib/plan/defaults';
import { ensureForecastSeed } from '../../lib/simulation/forecastSeed';

function ForecastSeedGate({ children }: { children: React.ReactNode }) {
  const { state, dispatch } = usePlanStore();
  const appState = useAppState();

  useEffect(() => {
    if (!appState.readiness.authReady || appState.restore.available) return;
    const next = ensureForecastSeed(state);
    if (next !== state) {
      dispatch({ type: 'hydrate', plan: next });
    }
  }, [appState.readiness.authReady, appState.restore.available, dispatch, state]);

  return <>{children}</>;
}

function PlanPersistenceGate({ children }: { children: React.ReactNode }) {
  const { state } = usePlanStore();
  const appState = useAppState();

  useEffect(() => {
    if (!appState.readiness.authReady || appState.restore.available) {
      return;
    }
    const next = { ...state, lastSaved: new Date().toISOString() };
    savePlanSnapshot(next);
  }, [appState.readiness.authReady, appState.restore.available, state]);

  return <>{children}</>;
}

export function PlanProvider({ children }: { children: React.ReactNode }) {
  const appState = useAppState();
  const storageScope = appState.readiness.authReady
    ? (appState.auth.userId || 'anon')
    : 'boot';
  const initialState = useMemo(
    () => (appState.readiness.authReady ? loadPlanSnapshot() : { ...DEFAULT_PLAN_STATE }),
    [appState.readiness.authReady, storageScope]
  );
  return (
    <PlanStoreProvider key={storageScope} initialState={initialState}>
      <ForecastSeedGate>
        <PlanPersistenceGate>{children}</PlanPersistenceGate>
      </ForecastSeedGate>
    </PlanStoreProvider>
  );
}

