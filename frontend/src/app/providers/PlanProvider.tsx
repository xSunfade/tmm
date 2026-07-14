import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlanStoreProvider, usePlanStore } from '../../lib/plan/planStore';
import {
  clearCorruptPlanBackup,
  getCorruptPlanBackup,
  loadPlanSnapshot,
  retryCorruptPlanBackup,
  savePlanSnapshot,
  subscribeToExternalPlanWrites
} from '../../lib/plan/planPersistence';
import {
  fetchServerPlan,
  isNewer,
  mergeServerPlanWithLocal,
  pushPlanToServer
} from '../../lib/plan/planSync';
import { migratePlan } from '../../lib/plan/migrations';
import { useAppState } from '../../state/appState';
import { DEFAULT_PLAN_STATE } from '../../lib/plan/defaults';
import { ensureForecastSeed } from '../../lib/simulation/forecastSeed';
import {
  LocalSaveStatusContext,
  ServerSyncStatusContext,
  type ServerSyncState
} from './planSaveStatus';

const SERVER_PUSH_DEBOUNCE_MS = 2500;

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

/**
 * Server sync (Phase 2.3, ADR-1): Supabase is the authoritative store; this
 * gate reconciles it with the localStorage cache.
 *  - on sign-in: newer-of (server client_saved_at vs local lastSaved)
 *  - on edit: debounced push with conflict detection (409 → prompt)
 *  - offline / backend down: localStorage keeps working; next session reconciles
 */
function PlanServerSyncGate({ children }: { children: React.ReactNode }) {
  const { state, dispatch } = usePlanStore();
  const appState = useAppState();
  const syncEnabled =
    appState.readiness.authReady && !!appState.auth.userId && !appState.restore.available;
  const [conflict, setConflict] = useState<{ serverClientSavedAt: string | null } | null>(null);
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const [syncState, setSyncState] = useState<ServerSyncState>({
    status: 'disabled',
    savedAt: null
  });
  const serverSavedAtRef = useRef<string | null>(null);
  const hydratedRef = useRef(false);
  const skipNextPushRef = useRef(false);
  const pushTimerRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Initial reconcile per signed-in user.
  useEffect(() => {
    if (!syncEnabled) {
      setSyncState({ status: 'disabled', savedAt: null });
      return;
    }
    let cancelled = false;
    hydratedRef.current = false;
    setSyncState({ status: 'checking', savedAt: null });
    (async () => {
      const server = await fetchServerPlan();
      if (cancelled) return;
      if (server === null) {
        // Backend unreachable: stay local-only this session; a later session reconciles.
        setSyncState({ status: 'offline', savedAt: null });
        return;
      }
      if (server.plan) {
        serverSavedAtRef.current = server.client_saved_at ?? null;
        const local = stateRef.current;
        if (isNewer(server.client_saved_at, local.lastSaved ?? null)) {
          const merged = migratePlan(mergeServerPlanWithLocal(server.plan, local));
          merged.lastSaved = server.client_saved_at ?? merged.lastSaved;
          skipNextPushRef.current = true;
          hydratedRef.current = true;
          dispatch({ type: 'hydrate', plan: merged });
          setSyncState({ status: 'synced', savedAt: serverSavedAtRef.current });
          return;
        }
      }
      hydratedRef.current = true;
      const result = await pushPlanToServer(stateRef.current, {
        baseClientSavedAt: serverSavedAtRef.current
      });
      if (cancelled) return;
      if (result.status === 'saved') {
        serverSavedAtRef.current = result.clientSavedAt;
        setSyncState({ status: 'synced', savedAt: result.clientSavedAt });
      } else if (result.status === 'conflict') {
        setConflict({ serverClientSavedAt: result.serverClientSavedAt });
        setSyncState({ status: 'conflict', savedAt: serverSavedAtRef.current });
      } else {
        setSyncState({ status: 'offline', savedAt: serverSavedAtRef.current });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncEnabled, appState.auth.userId, dispatch]);

  // Debounced push on edits.
  useEffect(() => {
    if (!syncEnabled || !hydratedRef.current || conflict) return;
    if (skipNextPushRef.current) {
      skipNextPushRef.current = false;
      return;
    }
    if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current);
    setSyncState((prev) => ({ status: 'saving', savedAt: prev.savedAt }));
    pushTimerRef.current = window.setTimeout(async () => {
      const result = await pushPlanToServer(stateRef.current, {
        baseClientSavedAt: serverSavedAtRef.current
      });
      if (result.status === 'saved') {
        serverSavedAtRef.current = result.clientSavedAt;
        setSyncState({ status: 'synced', savedAt: result.clientSavedAt });
      } else if (result.status === 'conflict') {
        setConflict({ serverClientSavedAt: result.serverClientSavedAt });
        setSyncState({ status: 'conflict', savedAt: serverSavedAtRef.current });
      } else {
        // Offline / server down: local snapshot still saves; the indicator
        // shows local-only so the user knows the account copy is behind.
        setSyncState({ status: 'offline', savedAt: serverSavedAtRef.current });
      }
    }, SERVER_PUSH_DEBOUNCE_MS);
    return () => {
      if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current);
    };
  }, [state, syncEnabled, conflict]);

  const useServerVersion = useCallback(async () => {
    setResolvingConflict(true);
    try {
      const server = await fetchServerPlan();
      if (server?.plan) {
        const merged = migratePlan(mergeServerPlanWithLocal(server.plan, stateRef.current));
        merged.lastSaved = server.client_saved_at ?? merged.lastSaved;
        serverSavedAtRef.current = server.client_saved_at ?? null;
        skipNextPushRef.current = true;
        dispatch({ type: 'hydrate', plan: merged });
      }
      setConflict(null);
      setSyncState({ status: 'synced', savedAt: serverSavedAtRef.current });
    } finally {
      setResolvingConflict(false);
    }
  }, [dispatch]);

  const keepLocalVersion = useCallback(async () => {
    setResolvingConflict(true);
    try {
      // Force push (no base): the user explicitly chose to overwrite.
      const result = await pushPlanToServer(stateRef.current, { baseClientSavedAt: undefined });
      if (result.status === 'saved') {
        serverSavedAtRef.current = result.clientSavedAt;
        setConflict(null);
        setSyncState({ status: 'synced', savedAt: result.clientSavedAt });
      }
    } finally {
      setResolvingConflict(false);
    }
  }, []);

  return (
    <ServerSyncStatusContext.Provider value={syncState}>
      {conflict ? (
        <div
          className="fixed inset-x-0 top-0 z-[10002] border-b border-cyan-500/40 bg-cyan-950/95 px-4 py-3 text-sm text-cyan-100"
          role="alert"
          data-testid="plan-conflict-banner"
        >
          <span className="font-semibold">This plan was changed somewhere else.</span>{' '}
          Another device or session saved a newer version to your account. Choose which one to keep.
          <span className="ml-3 inline-flex gap-2">
            <button
              type="button"
              disabled={resolvingConflict}
              className="rounded border border-cyan-300/50 px-2 py-1 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
              onClick={useServerVersion}
            >
              Use the newer version
            </button>
            <button
              type="button"
              disabled={resolvingConflict}
              className="rounded border border-cyan-300/50 px-2 py-1 text-xs text-cyan-100 hover:bg-cyan-500/20 disabled:opacity-50"
              onClick={keepLocalVersion}
            >
              Keep this device's version
            </button>
          </span>
        </div>
      ) : null}
      {children}
    </ServerSyncStatusContext.Provider>
  );
}

function PlanPersistenceGate({ children }: { children: React.ReactNode }) {
  const { state, dispatch } = usePlanStore();
  const appState = useAppState();
  const [saveFailed, setSaveFailed] = useState(false);
  const [corruptBackup, setCorruptBackup] = useState<string | null>(null);
  const [corruptNoticeDismissed, setCorruptNoticeDismissed] = useState(false);
  const [staleFromOtherTab, setStaleFromOtherTab] = useState(false);

  // Cross-tab guard (Phase 2.7): another tab saved this user's plan. Pause
  // local saves so this (stale) tab doesn't clobber it, and let the user pick.
  useEffect(() => {
    if (!appState.readiness.authReady) return;
    return subscribeToExternalPlanWrites(() => setStaleFromOtherTab(true));
  }, [appState.readiness.authReady]);

  useEffect(() => {
    if (!appState.readiness.authReady || appState.restore.available || staleFromOtherTab) {
      return;
    }
    const next = { ...state, lastSaved: new Date().toISOString() };
    setSaveFailed(!savePlanSnapshot(next));
  }, [appState.readiness.authReady, appState.restore.available, staleFromOtherTab, state]);

  const useOtherTabVersion = useCallback(() => {
    dispatch({ type: 'hydrate', plan: loadPlanSnapshot() });
    setStaleFromOtherTab(false);
  }, [dispatch]);

  const keepThisTabVersion = useCallback(() => {
    const next = { ...state, lastSaved: new Date().toISOString() };
    setSaveFailed(!savePlanSnapshot(next));
    setStaleFromOtherTab(false);
  }, [state]);

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
    <LocalSaveStatusContext.Provider value={saveFailed ? 'save_failed' : 'saved'}>
      {staleFromOtherTab ? (
        <div
          className="fixed inset-x-0 top-0 z-[10001] border-b border-indigo-500/40 bg-indigo-950/95 px-4 py-3 text-sm text-indigo-100"
          role="alert"
          data-testid="plan-stale-tab-banner"
        >
          <span className="font-semibold">This plan was changed in another tab.</span>{' '}
          Saving from this tab is paused so it doesn't overwrite that version. Choose which one to keep.
          <span className="ml-3 inline-flex gap-2">
            <button
              type="button"
              className="rounded border border-indigo-300/50 px-2 py-1 text-xs font-semibold text-indigo-100 hover:bg-indigo-500/20"
              onClick={useOtherTabVersion}
            >
              Load the other tab's version
            </button>
            <button
              type="button"
              className="rounded border border-indigo-300/50 px-2 py-1 text-xs text-indigo-100 hover:bg-indigo-500/20"
              onClick={keepThisTabVersion}
            >
              Keep this tab's version
            </button>
          </span>
        </div>
      ) : null}
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
    </LocalSaveStatusContext.Provider>
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
        <PlanPersistenceGate>
          <PlanServerSyncGate>{children}</PlanServerSyncGate>
        </PlanPersistenceGate>
      </ForecastSeedGate>
    </PlanStoreProvider>
  );
}

