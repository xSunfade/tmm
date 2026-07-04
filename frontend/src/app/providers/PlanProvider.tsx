import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PlanStoreProvider, usePlanStore } from '../../lib/plan/planStore';
import {
  clearCorruptPlanBackup,
  getCorruptPlanBackup,
  loadPlanSnapshot,
  retryCorruptPlanBackup,
  savePlanSnapshot
} from '../../lib/plan/planPersistence';
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
  const { state, dispatch } = usePlanStore();
  const appState = useAppState();
  const [saveFailed, setSaveFailed] = useState(false);
  const [corruptBackup, setCorruptBackup] = useState<string | null>(null);
  const [corruptNoticeDismissed, setCorruptNoticeDismissed] = useState(false);

  useEffect(() => {
    if (!appState.readiness.authReady || appState.restore.available) {
      return;
    }
    const next = { ...state, lastSaved: new Date().toISOString() };
    setSaveFailed(!savePlanSnapshot(next));
  }, [appState.readiness.authReady, appState.restore.available, state]);

  useEffect(() => {
    if (!appState.readiness.authReady) return;
    setCorruptBackup(getCorruptPlanBackup());
  }, [appState.readiness.authReady]);

  const retrySave = useCallback(() => {
    const next = { ...state, lastSaved: new Date().toISOString() };
    setSaveFailed(!savePlanSnapshot(next));
  }, [state]);

  const downloadCorruptBackup = useCallback(() => {
    if (!corruptBackup) return;
    const blob = new Blob([corruptBackup], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'tmm-plan-backup.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [corruptBackup]);

  const retryCorruptParse = useCallback(() => {
    const recovered = retryCorruptPlanBackup();
    if (recovered) {
      dispatch({ type: 'hydrate', plan: recovered });
      setCorruptBackup(null);
    }
  }, [dispatch]);

  const discardCorruptBackup = useCallback(() => {
    clearCorruptPlanBackup();
    setCorruptBackup(null);
  }, []);

  return (
    <>
      {saveFailed ? (
        <div
          className="fixed inset-x-0 top-0 z-[10001] border-b border-rose-500/40 bg-rose-950/95 px-4 py-3 text-sm text-rose-200"
          role="alert"
          data-testid="plan-save-failed-banner"
        >
          <span className="font-semibold">Your changes are not being saved.</span>{' '}
          Writing to this device failed (storage may be full). Recent edits will be lost if you close this tab.
          <button
            type="button"
            className="ml-3 rounded border border-rose-300/50 px-2 py-1 text-xs font-semibold text-rose-100 hover:bg-rose-500/20"
            onClick={retrySave}
          >
            Retry save
          </button>
        </div>
      ) : null}
      {corruptBackup && !corruptNoticeDismissed ? (
        <div
          className="fixed inset-x-0 top-0 z-[10001] border-b border-amber-500/40 bg-amber-950/95 px-4 py-3 text-sm text-amber-200"
          role="alert"
          data-testid="plan-corrupt-banner"
        >
          <span className="font-semibold">Your saved plan could not be read.</span>{' '}
          A backup of the raw data was kept on this device. You are currently working from a fresh plan.
          <span className="ml-3 inline-flex gap-2">
            <button
              type="button"
              className="rounded border border-amber-300/50 px-2 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-500/20"
              onClick={retryCorruptParse}
            >
              Try to recover
            </button>
            <button
              type="button"
              className="rounded border border-amber-300/50 px-2 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-500/20"
              onClick={downloadCorruptBackup}
            >
              Download backup
            </button>
            <button
              type="button"
              className="rounded border border-amber-300/50 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
              onClick={() => setCorruptNoticeDismissed(true)}
            >
              Dismiss
            </button>
            <button
              type="button"
              className="rounded border border-amber-300/50 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
              onClick={discardCorruptBackup}
            >
              Discard backup
            </button>
          </span>
        </div>
      ) : null}
      {children}
    </>
  );
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

