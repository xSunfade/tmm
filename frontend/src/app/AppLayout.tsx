import React, { useMemo, useState, useRef, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { useAppDispatch, useAppState } from '../state/appState';
import { useAuth } from './providers/useAuth';
import { navigateToRoute, isRoute, usePathname } from './routing';
import { getSupabaseClient } from '../lib/supabaseClient';
import { getGoogleAuthUrl, createSpreadsheet, getSpreadsheetMetadata, isGoogleTokenError } from '../lib/sheets/api';
import { openGoogleSheetsPicker } from '../lib/sheets/picker';
import { getStoredSheetId, clearStoredSheetId, setStoredSheetId, getLastSyncedAt, setLastSyncedAt } from '../lib/sheets/storage';
import { SheetsTokenProvider } from '../lib/sheets/SheetsTokenContext';
import { setSheetsPrefs } from '../lib/sheets/sheetsPrefs';
import { persistSheetsOAuthDone } from '../state/localBootstrap';
import { syncPlanToSheets, loadPlanFromSheets, getSheetsQueueStatus, sanitizeSheetName } from '../lib/sheets/sync';
import { snapshotPlanBeforeReplace } from '../lib/plan/planSync';
import { getSheetsSessionToken } from '../lib/sheets/api';
import { usePlanStore } from '../lib/plan/planStore';
import { hasMeaningfulData } from '../features/restore/restoreEligibility';
import { runSimulationFromLedger } from '../lib/simulation/ledger';
import { loadSimulationSettings } from '../lib/simulation/simulationSettings';
import { saveLastRun } from '../lib/simulation/runHistory';
import { applyTheme, getStoredTheme, setStoredTheme } from '../lib/theme/theme';
import { clearPlaidStepUpVerification } from '../lib/security/mfa';
import { authFetch } from '../lib/api/authFetch';
import { AppSpinner } from '../components/AppSpinner';
import { usePlanSaveStatus } from './providers/planSaveStatus';
import { isPaidTier, tierLabel } from '../lib/entitlements/tier';
import {
  fetchEntitlements,
  joinTmmPlusWaitlist,
  redeemInviteCode,
  type EntitlementsResponse
} from '../lib/entitlements/api';
import type { ThemeId } from '../lib/theme/theme';
import type { AppRoute } from './routing';

/**
 * Save/backup truth indicator (Phase 2.3, UX-A): one persistent, honest line
 * answering "is my plan safe?". Local snapshot state comes first (losing the
 * device copy means losing edits now); the account backup state qualifies it.
 */
function PlanSaveIndicator() {
  const { local, server, serverSavedAt, serverMessage } = usePlanSaveStatus();

  let dotClass = 'bg-emerald-400';
  let label = 'Saved · backed up to account';
  let detail: string | null = serverSavedAt
    ? `Account copy: ${new Date(serverSavedAt).toLocaleString()}`
    : null;

  if (local === 'save_failed') {
    dotClass = 'bg-rose-400';
    label = 'Not saved — action needed';
    detail = 'Saving to this device failed. See the banner above.';
  } else if (server === 'saving') {
    dotClass = 'bg-cyan-400';
    label = 'Saved here · backing up…';
  } else if (server === 'checking') {
    dotClass = 'bg-slate-400';
    label = 'Saved here · checking account backup…';
    detail = null;
  } else if (server === 'offline') {
    dotClass = 'bg-amber-400';
    label = 'Saved on this device only';
    detail = 'Account backup unreachable — it will catch up when the server is back.';
  } else if (server === 'conflict') {
    dotClass = 'bg-amber-400';
    label = 'Saved here · sync conflict';
    detail = 'Another device saved a newer version. Choose which to keep in the banner.';
  } else if (server === 'limit_exceeded') {
    dotClass = 'bg-amber-400';
    label = 'Saved here · over plan limit';
    detail = serverMessage || 'Your plan exceeds free-tier limits. Remove scenarios or upgrade to TMM+ to back it up.';
  } else if (server === 'disabled') {
    dotClass = 'bg-slate-400';
    label = 'Saved on this device';
    detail = null;
  }

  return (
    <div
      className="mt-3 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs"
      data-testid="plan-save-indicator"
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${dotClass}`} aria-hidden />
        <span className="min-w-0 font-semibold text-slate-200">{label}</span>
      </div>
      {detail ? <div className="mt-1 text-[11px] text-slate-500">{detail}</div> : null}
    </div>
  );
}

type AppLayoutProps = {
  children: React.ReactNode;
};

export function AppLayout({ children }: AppLayoutProps) {
  const appState = useAppState();
  const appDispatch = useAppDispatch();
  const { state: planState, dispatch: planDispatch } = usePlanStore();
  const pathname = usePathname();
  const [isSyncing, setIsSyncing] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(() => getStoredTheme() ?? 'dark-green');
  const effectiveSheetId = appState.sheets.spreadsheetId ?? getStoredSheetId();
  const [sheetTitle, setSheetTitle] = useState<string | null>(null);
  const [sheetsDropdownOpen, setSheetsDropdownOpen] = useState(false);
  const [chooseModalOpen, setChooseModalOpen] = useState(false);
  const [chooseInput, setChooseInput] = useState('');
  const [chooseError, setChooseError] = useState<string | null>(null);
  const [createSheetModalOpen, setCreateSheetModalOpen] = useState(false);
  const [createSheetName, setCreateSheetName] = useState('The Money Machine Plan');
  const [createSheetError, setCreateSheetError] = useState<string | null>(null);
  const [showConnectGoogleForPicker, setShowConnectGoogleForPicker] = useState(false);
  const [sheetsToast, setSheetsToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [accountBillingError, setAccountBillingError] = useState<string | null>(null);
  const [accountActionBusy, setAccountActionBusy] = useState<'upgrade' | 'manage' | 'invite' | 'waitlist' | null>(null);
  const [entitlements, setEntitlements] = useState<EntitlementsResponse | null>(null);
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const accountModalRef = useRef<HTMLDivElement>(null);
  const accountModalFirstFocusRef = useRef<HTMLButtonElement>(null);
  const accountModalLastFocusRef = useRef<HTMLButtonElement>(null);
  const sheetsDropdownRef = useRef<HTMLDivElement>(null);
  const sheetsSessionTokenRef = useRef<string | null>(null);
  const hasAutoLoadedFromSheetRef = useRef(false);
  const [sheetsTokenReady, setSheetsTokenReady] = useState(false);
  const queueStatus = getSheetsQueueStatus();

  useEffect(() => {
    if (!appState.sheets.connectionVerified) return;
    getSheetsSessionToken()
      .then((t) => {
        sheetsSessionTokenRef.current = t;
        setSheetsTokenReady(true);
      })
      .catch(() => {});
  }, [appState.sheets.connectionVerified]);

  useEffect(() => {
    if (
      !appState.sheets.connectionVerified ||
      !effectiveSheetId ||
      hasMeaningfulData(planState) ||
      appState.restore.available ||
      !sheetsTokenReady ||
      hasAutoLoadedFromSheetRef.current
    ) {
      return;
    }
    hasAutoLoadedFromSheetRef.current = true;
    loadPlanFromSheets(effectiveSheetId, sheetsSessionTokenRef.current ?? undefined)
      .then((nextPlan) => {
        planDispatch({ type: 'hydrate', plan: { ...nextPlan, isSampleData: false } });
      })
      .catch((err) => {
        hasAutoLoadedFromSheetRef.current = false;
        console.warn('[sheets] Auto-load from sheet failed', err);
      });
  }, [
    appState.sheets.connectionVerified,
    appState.restore.available,
    effectiveSheetId,
    planState,
    planDispatch,
    sheetsTokenReady
  ]);
  const { refreshPlanTier } = useAuth();

  const handleLocalSignOut = async () => {
    const SIGNOUT_TIMEOUT_MS = 4000;
    clearPlaidStepUpVerification(appState.auth.userId);
    try {
      await Promise.race([
        getSupabaseClient().auth.signOut({ scope: 'local' }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('SIGNOUT_TIMEOUT')), SIGNOUT_TIMEOUT_MS)
        )
      ]);
    } catch (error) {
      const isTimeout = (error as Error)?.message === 'SIGNOUT_TIMEOUT';
      if (isTimeout) {
        // Fallback: Supabase signOut can hang after tab visibility changes.
        // Force clear local auth storage and reload into signed-out state.
        if (typeof window !== 'undefined') {
          try {
            Object.keys(localStorage).forEach((key) => {
              if (/^sb-.*-auth-token$/.test(key)) {
                localStorage.removeItem(key);
              }
            });
          } catch {
            // ignore localStorage errors
          }
          window.location.reload();
        }
        return;
      }
      throw error;
    }
  };

  function formatLastSynced(iso: string): string {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso;
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours} hr ago`;
    if (diffDays < 7) return `${diffDays} days ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function parseSpreadsheetId(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match) return match[1];
    if (/^[a-zA-Z0-9-_]+$/.test(trimmed)) return trimmed;
    return null;
  }

  function planHasData(plan: typeof planState): boolean {
    const alts = plan.alternatives || {};
    for (const alt of Object.values(alts)) {
      if (
        (alt.income?.length ?? 0) > 0 ||
        (alt.expense?.length ?? 0) > 0 ||
        (alt.asset?.length ?? 0) > 0 ||
        (alt.debt?.length ?? 0) > 0
      ) {
        return true;
      }
    }
    return false;
  }

  function openCreateSheetModal() {
    setCreateSheetError(null);
    setCreateSheetName(sheetTitle || 'The Money Machine Plan');
    setCreateSheetModalOpen(true);
  }

  async function createAndSyncSpreadsheet(rawName: string) {
    const trimmedName = rawName.trim();
    const spreadsheetName = trimmedName || 'The Money Machine Plan';
    setIsSyncing(true);
    setCreateSheetError(null);
    try {
      const altSheets = Object.keys(planState.alternatives || {}).flatMap((name) => {
        const suffix = ` - ${sanitizeSheetName(name)}`;
        return [
          `Income${suffix}`,
          `Expenses${suffix}`,
          `Assets${suffix}`,
          `Debts${suffix}`,
          `PB Layout${suffix}`,
          `PB Flows${suffix}`
        ];
      });
      const sheetNames = ['Settings', 'Alternatives', 'Augments', 'Checkpoints', 'TMM_META', ...altSheets];
      const created = await createSpreadsheet(spreadsheetName, sheetNames);
      setStoredSheetId(created.spreadsheetId);
      appDispatch({ type: 'sheets', connected: true, connectionVerified: true, spreadsheetId: created.spreadsheetId });
      setSheetsPrefs({ lastSpreadsheetId: created.spreadsheetId });
      setSheetTitle(spreadsheetName);
      await syncPlanToSheets(planState, created.spreadsheetId, sheetsSessionTokenRef.current ?? undefined);
      setCreateSheetModalOpen(false);
      setSheetsToast({ message: 'Spreadsheet created and connected', type: 'success' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Create failed';
      console.warn('[sheets] Create failed', error);
      setCreateSheetError(msg);
      setSheetsToast({ message: msg, type: 'error' });
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleChooseFromPicker() {
    setSheetsDropdownOpen(false);
    setChooseError(null);
    setShowConnectGoogleForPicker(false);
    try {
      const pickedId = await openGoogleSheetsPicker();
      if (!pickedId) {
        setSheetsToast({ message: 'No spreadsheet selected.', type: 'error' });
        return;
      }
      if (
        planHasData(planState) &&
        !window.confirm('Connecting this sheet will replace your current plan data with the sheet\'s data. Continue?')
      ) {
        return;
      }

      setIsSyncing(true);
      await snapshotPlanBeforeReplace(planState);
      const nextPlan = await loadPlanFromSheets(pickedId, sheetsSessionTokenRef.current ?? undefined);
      planDispatch({ type: 'hydrate', plan: { ...nextPlan, isSampleData: false } });
      setStoredSheetId(pickedId);
      appDispatch({ type: 'sheets', connected: true, connectionVerified: true, spreadsheetId: pickedId });
      setSheetsPrefs({ lastSpreadsheetId: pickedId });
      let title = 'Spreadsheet';
      try {
        const meta = await getSpreadsheetMetadata(pickedId);
        if (meta?.title) {
          title = meta.title;
          setSheetTitle(meta.title);
        }
      } catch {
        // use fallback title
      }
      setSheetsToast({ message: `Imported "${title}" successfully`, type: 'success' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Picker failed';
      if (message === 'Google not connected') {
        appDispatch({ type: 'sheets', connected: false, connectionVerified: true });
        persistSheetsOAuthDone(false);
        setShowConnectGoogleForPicker(true);
      } else {
        setSheetsToast({ message, type: 'error' });
        setChooseInput('');
        setChooseModalOpen(true);
        setChooseError(message);
      }
    } finally {
      flushSync(() => setIsSyncing(false));
    }
  }

  useEffect(() => {
    if (!effectiveSheetId) {
      setSheetTitle(null);
      return;
    }
    getSpreadsheetMetadata(effectiveSheetId)
      .then((meta) => setSheetTitle(meta?.title ?? null))
      .catch(() => setSheetTitle(null));
  }, [effectiveSheetId]);

  useEffect(() => {
    if (!sheetsToast) return;
    const t = setTimeout(() => setSheetsToast(null), 3000);
    return () => clearTimeout(t);
  }, [sheetsToast]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (sheetsDropdownRef.current && !sheetsDropdownRef.current.contains(event.target as Node)) {
        setSheetsDropdownOpen(false);
      }
    }
    if (sheetsDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [sheetsDropdownOpen]);

  // Refetch plan tier when Account modal opens so it shows authoritative state
  useEffect(() => {
    if (accountModalOpen) {
      setAccountBillingError(null);
      refreshPlanTier();
    }
  }, [accountModalOpen, refreshPlanTier]);

  // On load with Stripe success param, refetch plan tier and clear the param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const upgrade = params.get('upgrade');
    const stripe = params.get('stripe');
    if (upgrade === 'success' || stripe === 'success') {
      refreshPlanTier().then(() => {
        params.delete('upgrade');
        params.delete('stripe');
        const newSearch = params.toString();
        const newUrl = newSearch ? `${window.location.pathname}?${newSearch}` : window.location.pathname;
        window.history.replaceState({}, '', newUrl);
      });
    }
  }, [refreshPlanTier]);

  // Entitlement state for the dunning banner + invite/waitlist UI (Phase 4).
  // Refreshed on sign-in and whenever the resolved tier changes (e.g. after
  // checkout returns or a webhook lands).
  useEffect(() => {
    if (appState.auth.status !== 'authenticated' || !appState.auth.userId) {
      setEntitlements(null);
      return;
    }
    let cancelled = false;
    fetchEntitlements().then((data) => {
      if (!cancelled && data) setEntitlements(data);
    });
    return () => {
      cancelled = true;
    };
  }, [appState.auth.status, appState.auth.userId, appState.auth.planTier]);

  useEffect(() => {
    if (!accountModalOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountModalOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [accountModalOpen]);

  useEffect(() => {
    if (accountModalOpen && accountModalFirstFocusRef.current) {
      accountModalFirstFocusRef.current.focus();
    }
  }, [accountModalOpen]);

  function normalizeApiError(error: unknown, fallback: string) {
    if (!(error instanceof Error)) return fallback;
    const message = String(error.message || '').trim();
    if (!message) return fallback;
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === 'object') {
        const parsedMessage = parsed.error || parsed.message;
        if (typeof parsedMessage === 'string' && parsedMessage.trim()) {
          return parsedMessage.trim();
        }
      }
    } catch {
      // Keep original message when backend did not return JSON.
    }
    return message;
  }

  async function handleUpgradeToPlus() {
    setAccountBillingError(null);
    setAccountActionBusy('upgrade');
    try {
      const origin = window.location.origin;
      const response = await authFetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({
          success_url: `${origin}?stripe=success`,
          cancel_url: `${origin}?stripe=cancel`
        })
      }) as { url?: string };
      if (!response?.url) {
        throw new Error('Stripe checkout URL missing from server response');
      }
      window.location.assign(response.url);
    } catch (error) {
      setAccountBillingError(normalizeApiError(error, 'Unable to start Stripe checkout'));
      setAccountActionBusy(null);
    }
  }

  async function handleRedeemInvite() {
    const code = inviteCodeInput.trim();
    if (!code) return;
    setInviteNotice(null);
    setAccountActionBusy('invite');
    try {
      const result = await redeemInviteCode(code);
      if (result.ok) {
        setInviteNotice('Invite accepted — you can upgrade now.');
        setInviteCodeInput('');
        const refreshed = await fetchEntitlements();
        if (refreshed) setEntitlements(refreshed);
      } else {
        setInviteNotice(result.message || 'Invite code could not be redeemed');
      }
    } finally {
      setAccountActionBusy(null);
    }
  }

  async function handleJoinWaitlist() {
    setInviteNotice(null);
    setAccountActionBusy('waitlist');
    try {
      const ok = await joinTmmPlusWaitlist();
      if (ok) {
        setInviteNotice("You're on the TMM+ waitlist — we'll email your invite.");
        const refreshed = await fetchEntitlements();
        if (refreshed) setEntitlements(refreshed);
      } else {
        setInviteNotice('Could not join the waitlist right now. Try again later.');
      }
    } finally {
      setAccountActionBusy(null);
    }
  }

  async function handleManageSubscription() {
    setAccountBillingError(null);
    setAccountActionBusy('manage');
    try {
      const origin = window.location.origin;
      const response = await authFetch('/api/stripe/create-portal-session', {
        method: 'POST',
        body: JSON.stringify({
          return_url: `${origin}?stripe=success`
        })
      }) as { url?: string };
      if (!response?.url) {
        throw new Error('Stripe portal URL missing from server response');
      }
      window.location.assign(response.url);
    } catch (error) {
      setAccountBillingError(normalizeApiError(error, 'Unable to open subscription management'));
      setAccountActionBusy(null);
    }
  }

  const navItems = useMemo(
    (): Array<{ key: AppRoute; label: string; requiresPlus?: boolean }> => [
      { key: 'dashboard', label: 'Dashboard' },
      { key: 'accounts', label: 'Accounts' },
      { key: 'account-integration', label: 'Account Integration', requiresPlus: true },
      { key: 'goals', label: 'Goals' },
      { key: 'pipeline', label: 'Pipeline Builder' },
      { key: 'simulation', label: 'Simulation' },
      { key: 'settings', label: 'Settings' }
    ],
    []
  );

  const handleRunSimulation = () => {
    const settings = loadSimulationSettings();
    const result = runSimulationFromLedger(planState, settings.runYears, settings.granularity);
    saveLastRun({
      audit: result.audit,
      logs: result.logs,
      runYears: settings.runYears,
      granularity: settings.granularity,
      ranAt: new Date().toISOString()
    });
    window.dispatchEvent(new CustomEvent('tmm:run-simulation'));
  };

  const handleWeeklyCheckIn = () => {
    window.dispatchEvent(new CustomEvent('tmm:weekly-checkin'));
  };

  return (
    <SheetsTokenProvider getToken={() => sheetsSessionTokenRef.current}>
      <div className="flex min-h-screen bg-slate-950 text-slate-200">
        <aside className="flex w-72 flex-none flex-col border-r border-slate-800 bg-slate-950/95 px-4 py-6">
        <div className="flex flex-col">
          <div className="flex items-start justify-between gap-2">
            <div className="group relative inline-block min-w-0">
              <h1 className="sr-only">The Money Machine</h1>
              <div className="flex flex-col" style={{ fontSize: '1.5rem', letterSpacing: '0.02em' }}>
                <span className="font-bold uppercase leading-tight text-white" aria-hidden>THE</span>
                <span className="font-bold uppercase leading-tight text-white" aria-hidden>MONEY</span>
                <span className="font-bold uppercase leading-tight text-white" aria-hidden>
                  MACHINE<sup className="text-[0.65em] opacity-90">™</sup>
                </span>
              </div>
              <div
                className="absolute left-0 top-0 h-full w-0 overflow-hidden transition-[width] duration-300 ease-out group-hover:w-full"
                aria-hidden
              >
                <div className="flex flex-col text-emerald-400" style={{ fontSize: '1.5rem', letterSpacing: '0.02em' }}>
                  <span className="font-bold uppercase leading-tight">THE</span>
                  <span className="font-bold uppercase leading-tight">MONEY</span>
                  <span className="font-bold uppercase leading-tight">
                    MACHINE<sup className="text-[0.65em] opacity-90">™</sup>
                  </span>
                </div>
              </div>
            </div>
            <span
              className={`shrink-0 font-bold uppercase tracking-wide ${
                appState.auth.planTier === null
                  ? 'text-slate-500'
                  : isPaidTier(appState.auth.planTier)
                    ? 'text-emerald-400'
                    : 'text-slate-500'
              }`}
              style={{ fontSize: '1.4rem' }}
              aria-label={
                appState.auth.planTier === null
                  ? 'Loading plan'
                  : `${tierLabel(appState.auth.planTier)} plan`
              }
            >
              {appState.auth.planTier === null
                ? '…'
                : appState.auth.planTier === 'tmm_pro'
                  ? 'PRO'
                  : appState.auth.planTier === 'tmm_plus'
                    ? 'PLUS'
                    : 'FREE'}
            </span>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" className="h-5 w-5 flex-shrink-0" aria-hidden>
              <rect width="24" height="24" rx="3" fill="#34A853" />
              <path
                fill="white"
                fillOpacity="0.9"
                d="M5 8h4v1H5V8zm0 3h4v1H5v-1zm0 3h4v1H5v-1zm6-6h8v1h-8V8zm0 3h8v1h-8v-1zm0 3h8v1h-8v-1z"
              />
            </svg>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={`font-bold ${
                    appState.sheets.connected ? 'text-amber-400' : 'text-slate-500'
                  }`}
                >
                  {appState.sheets.connected ? 'SHEETS BACKUP' : 'SHEETS BACKUP OFF'}
                </span>
                <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-cyan-300">
                  Beta
                </span>
              </div>
              <div className="text-slate-400">
                {!appState.sheets.connected
                  ? 'Optional: export plan backups to Google Sheets'
                  : effectiveSheetId
                    ? (sheetTitle ?? 'Spreadsheet')
                    : 'Select or create a TMM template Google Sheet'}
              </div>
            </div>
          </div>
          {queueStatus.latestError ? (
            <div className="mt-2 text-[11px] text-amber-300">Queue error: {queueStatus.latestError}</div>
          ) : null}
          {effectiveSheetId ? (
            <div className="mt-2 text-[11px] text-slate-500">
              {!appState.sheets.connectionVerified
                ? 'Checking connection…'
                : queueStatus.pending > 0
                  ? `${queueStatus.pending} pending – not yet in sheet`
                  : getLastSyncedAt(effectiveSheetId)
                    ? `Last backup: ${formatLastSynced(getLastSyncedAt(effectiveSheetId)!)}`
                    : 'No backup exported yet'}
            </div>
          ) : null}
        </div>

        <PlanSaveIndicator />

        {/* Sheets action block: directly below status, above nav */}
        {!appState.sheets.connected ? (
          <div className="mt-3">
            <button
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
              type="button"
              onClick={async () => {
                try {
                  const url = await getGoogleAuthUrl();
                  window.location.href = url;
                } catch (error) {
                  const msg = error instanceof Error ? error.message : 'Failed to start Google Sheets connection.';
                  setSheetsToast({ message: msg, type: 'error' });
                  console.warn('[sheets] Connect failed', error);
                }
              }}
            >
              CONNECT SHEETS
            </button>
          </div>
        ) : appState.sheets.connected && !effectiveSheetId ? (
          <div className="mt-3" ref={sheetsDropdownRef}>
            <div className="relative min-w-0">
              <button
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
                type="button"
                onClick={() => setSheetsDropdownOpen((o) => !o)}
              >
                SHEETS . . .
              </button>
              {sheetsDropdownOpen ? (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-lg">
                  <button
                    className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                    type="button"
                    onClick={handleChooseFromPicker}
                    >
                      CHOOSE…
                    </button>
                    <button
                      className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                      type="button"
                      onClick={() => {
                        setSheetsDropdownOpen(false);
                        setChooseInput('');
                        setChooseError(null);
                        setChooseModalOpen(true);
                      }}
                    >
                      Paste URL or ID…
                    </button>
                    <button
                      className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                      type="button"
                      onClick={() => {
                        setSheetsDropdownOpen(false);
                        openCreateSheetModal();
                      }}
                  >
                    Create new spreadsheet
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2" ref={sheetsDropdownRef}>
              <button
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-rose-400 hover:bg-slate-800 hover:text-rose-300"
                type="button"
                title="Unlink spreadsheet (keeps you signed in to Google)"
                onClick={() => {
                  if (!window.confirm('Unlink this spreadsheet from TMM? Your data stays in the sheet; you can connect another later.')) return;
                  // Unlink: only clear TMM’s stored sheet and hides sheet actions; Must NEVER call signOut() or clear auth storage — user stays signed in to TMM and Google.
                  clearStoredSheetId();
                  setSheetTitle(null);
                  appDispatch({ type: 'sheets', connected: appState.sheets.connected, connectionVerified: appState.sheets.connectionVerified, spreadsheetId: null });
                  setSheetsPrefs({ lastSpreadsheetId: null });
                }}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  <path d="M2 2l20 20" />
                </svg>
              </button>
              <div className="relative min-w-0 flex-1">
                <button
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
                  type="button"
                  onClick={() => setSheetsDropdownOpen((o) => !o)}
                >
                  SHEETS . . .
                </button>
                {sheetsDropdownOpen ? (
                  <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-slate-700 bg-slate-900 py-1 shadow-lg">
                    <button
                      className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                      type="button"
                      onClick={handleChooseFromPicker}
                    >
                      CHOOSE…
                    </button>
                    <button
                      className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                      type="button"
                      onClick={() => {
                        setSheetsDropdownOpen(false);
                        setChooseInput('');
                        setChooseError(null);
                        setChooseModalOpen(true);
                      }}
                    >
                      Paste URL or ID…
                    </button>
                    <button
                      className="w-full px-3 py-2 text-left text-xs text-slate-200 hover:bg-slate-800"
                      type="button"
                      onClick={() => {
                        setSheetsDropdownOpen(false);
                        openCreateSheetModal();
                      }}
                    >
                      Create new spreadsheet
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed"
                type="button"
                disabled={isSyncing || !appState.sheets.connectionVerified}
                title={!appState.sheets.connectionVerified ? 'Checking Google connection…' : undefined}
                onClick={async () => {
                  if (!effectiveSheetId) return;
                  setIsSyncing(true);
                  try {
                    const result = await syncPlanToSheets(planState, effectiveSheetId, sheetsSessionTokenRef.current ?? undefined);
                    if (result.ok) {
                      setLastSyncedAt(effectiveSheetId, new Date().toISOString());
                      setSheetsToast({ message: 'Backup exported to sheet.', type: 'success' });
                    } else {
                      const msg =
                        result.errors.length > 0
                          ? result.errors[0]
                          : `Export incomplete: ${result.queued} changes queued`;
                      setSheetsToast({ message: msg, type: 'error' });
                      if (result.errors.some((e) => isGoogleTokenError(e))) {
                        clearStoredSheetId();
                        setSheetTitle(null);
                        persistSheetsOAuthDone(false);
                        appDispatch({ type: 'sheets', connected: false, connectionVerified: true, spreadsheetId: null });
                      }
                    }
                  } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    setSheetsToast({ message: 'Export failed', type: 'error' });
                    if (isGoogleTokenError(msg)) {
                      clearStoredSheetId();
                      setSheetTitle(null);
                      persistSheetsOAuthDone(false);
                      appDispatch({ type: 'sheets', connected: false, connectionVerified: true, spreadsheetId: null });
                    }
                  } finally {
                    flushSync(() => setIsSyncing(false));
                  }
                }}
              >
                {isSyncing ? 'Exporting…' : 'Export backup'}
              </button>
              <button
                className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed"
                type="button"
                disabled={isSyncing || !appState.sheets.connectionVerified}
                title={!appState.sheets.connectionVerified ? 'Checking Google connection…' : undefined}
                onClick={async () => {
                  if (!effectiveSheetId) return;
                  setIsSyncing(true);
                  try {
                    await snapshotPlanBeforeReplace(planState);
                    const nextPlan = await loadPlanFromSheets(effectiveSheetId, sheetsSessionTokenRef.current ?? undefined);
                    planDispatch({ type: 'hydrate', plan: { ...nextPlan, isSampleData: false } });
                    setSheetsToast({ message: 'Imported from sheet', type: 'success' });
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Import failed';
                    setSheetsToast({ message: msg, type: 'error' });
                    if (isGoogleTokenError(msg)) {
                      clearStoredSheetId();
                      setSheetTitle(null);
                      persistSheetsOAuthDone(false);
                      appDispatch({ type: 'sheets', connected: false, connectionVerified: true, spreadsheetId: null });
                    }
                  } finally {
                    flushSync(() => setIsSyncing(false));
                  }
                }}
              >
                Import from sheet
              </button>
              {queueStatus.pending > 0 ? (
                <span className="rounded-md bg-amber-400 px-2 py-1 text-[10px] font-semibold text-slate-900">
                  {queueStatus.pending} queued
                </span>
              ) : null}
            </div>
          </div>
        )}

        {planState.isSampleData === true ? (
          <div className="mt-3 rounded-lg bg-amber-400/30 px-3 py-2 text-center">
            <span className="text-sm font-bold text-slate-900">SAMPLE DATA IMPORTED</span>
          </div>
        ) : null}

        <nav className="mt-6 space-y-1 text-sm">
          {navItems.map((item) => {
            const isPlus = isPaidTier(appState.auth.planTier);
            const isLocked = Boolean(item.requiresPlus && !isPlus);
            const isActive = isRoute(pathname, item.key);
            const isAccountIntegration = item.key === 'account-integration';
            const navClass = isActive
              ? 'border border-emerald-400/40 bg-emerald-500/20 text-emerald-100 shadow-[0_0_10px_rgba(16,185,129,0.18)]'
              : 'border border-transparent text-slate-300 hover:bg-slate-900';
            return (
              <button
                key={item.key}
                type="button"
                data-tour={`nav-${item.key}`}
                aria-disabled={isLocked}
                title={isLocked && !isAccountIntegration ? 'TMM+ required' : undefined}
                className={`w-full rounded-lg px-3 py-2 text-left transition ${navClass}`}
                onClick={() => {
                  if (isLocked) {
                    setAccountModalOpen(true);
                    return;
                  }
                  navigateToRoute(item.key);
                }}
              >
                <span className="flex w-full items-center gap-2">
                  <span>{item.label}</span>
                  {isAccountIntegration ? (
                    <span className="tmm-plus-badge" title="TMM+" aria-label="TMM+">
                      +
                    </span>
                  ) : isLocked ? (
                    <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 text-current" aria-hidden>
                      <path
                        fill="currentColor"
                        d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 0 1 6 0v3H9Zm3 4a2 2 0 0 1 1 3.732V19h-2v-1.268A2 2 0 0 1 12 14Z"
                      />
                    </svg>
                  ) : null}
                </span>
              </button>
            );
          })}
        </nav>

        <hr className="my-5 border-slate-800" />

        <div className="space-y-3">
          <button
            className="w-full rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950"
            data-tour="run-simulation"
            type="button"
            onClick={handleRunSimulation}
          >
            Run Simulation
          </button>
          <button
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200"
            type="button"
            onClick={handleWeeklyCheckIn}
          >
            📅 Weekly Check-In
          </button>
        </div>

        <hr className="my-5 border-slate-800" />

        <div className="space-y-3 text-xs text-slate-300">
          <button
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
            type="button"
            onClick={() => setAccountModalOpen(true)}
          >
            ACCOUNT
          </button>
          <button
            className="w-full rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/20"
            type="button"
            onClick={async () => {
              try {
                await handleLocalSignOut();
              } catch (error) {
                console.warn('[auth] Sign out failed', error);
              }
            }}
          >
            Sign Out
          </button>
        </div>

        {showConnectGoogleForPicker ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur">
            <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-xl">
              <h3 className="text-sm font-semibold text-slate-100">Connect Google first</h3>
              <p className="mt-2 text-xs text-slate-400">
                The file picker needs access to your Google account. Connect Google Sheets once, then you can choose a spreadsheet from the picker.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200"
                  type="button"
                  onClick={() => setShowConnectGoogleForPicker(false)}
                >
                  Cancel
                </button>
                <button
                  className="rounded-lg border border-cyan-500/60 bg-cyan-500/20 px-3 py-2 text-xs text-cyan-200"
                  type="button"
                  onClick={async () => {
                    const url = await getGoogleAuthUrl();
                    window.location.href = url;
                  }}
                >
                  Connect Google
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {chooseModalOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur">
            <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-xl">
              <h3 className="text-sm font-semibold text-slate-100">Choose spreadsheet</h3>
              <p className="mt-1 text-xs text-slate-400">
                Paste your spreadsheet URL or ID from the address bar (e.g. docs.google.com/spreadsheets/d/…)
              </p>
              <input
                className="mt-3 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500"
                type="text"
                placeholder="URL or spreadsheet ID"
                value={chooseInput}
                onChange={(e) => {
                  setChooseInput(e.target.value);
                  setChooseError(null);
                }}
              />
              {chooseError ? <p className="mt-2 text-xs text-rose-400">{chooseError}</p> : null}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200"
                  type="button"
                  onClick={() => {
                    setChooseModalOpen(false);
                    setChooseInput('');
                    setChooseError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="rounded-lg border border-cyan-500/60 bg-cyan-500/20 px-3 py-2 text-xs text-cyan-200 disabled:opacity-50"
                  type="button"
                  disabled={isSyncing}
                  onClick={async () => {
                      const id = parseSpreadsheetId(chooseInput);
                      if (!id) {
                        setChooseError('Enter a valid spreadsheet URL or ID');
                        return;
                      }
                      if (planHasData(planState) && !window.confirm('Connecting this sheet will replace your current plan data with the sheet\'s data. Continue?')) {
                        return;
                      }
                      setIsSyncing(true);
                      setChooseError(null);
                      try {
                        await snapshotPlanBeforeReplace(planState);
                        const nextPlan = await loadPlanFromSheets(id, sheetsSessionTokenRef.current ?? undefined);
                        planDispatch({ type: 'hydrate', plan: { ...nextPlan, isSampleData: false } });
                        setStoredSheetId(id);
                        appDispatch({ type: 'sheets', connected: true, connectionVerified: true, spreadsheetId: id });
                        setSheetsPrefs({ lastSpreadsheetId: id });
                        setChooseModalOpen(false);
                        setChooseInput('');
                        let title = 'Spreadsheet';
                        try {
                          const meta = await getSpreadsheetMetadata(id);
                          if (meta?.title) {
                            title = meta.title;
                            setSheetTitle(meta.title);
                          }
                        } catch {
                          // use fallback
                        }
                        setSheetsToast({ message: `Imported "${title}" successfully`, type: 'success' });
                      } catch (error) {
                        const msg = error instanceof Error ? error.message : 'Failed to load spreadsheet';
                        setChooseError(msg);
                        setSheetsToast({ message: msg, type: 'error' });
                      } finally {
                        setIsSyncing(false);
                      }
                  }}
                >
                  {isSyncing ? 'Loading…' : 'Connect'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {createSheetModalOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur">
            <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-xl">
              <h3 className="text-sm font-semibold text-slate-100">Create spreadsheet</h3>
              <p className="mt-1 text-xs text-slate-400">
                Enter a name for your new Google Sheet.
              </p>
              <input
                className="mt-3 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500"
                type="text"
                placeholder="The Money Machine Plan"
                value={createSheetName}
                onChange={(e) => {
                  setCreateSheetName(e.target.value);
                  setCreateSheetError(null);
                }}
              />
              {createSheetError ? <p className="mt-2 text-xs text-rose-400">{createSheetError}</p> : null}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200"
                  type="button"
                  onClick={() => {
                    if (isSyncing) return;
                    setCreateSheetModalOpen(false);
                    setCreateSheetError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="rounded-lg border border-cyan-500/60 bg-cyan-500/20 px-3 py-2 text-xs text-cyan-200 disabled:opacity-50"
                  type="button"
                  disabled={isSyncing}
                  onClick={() => createAndSyncSpreadsheet(createSheetName)}
                >
                  {isSyncing ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {accountModalOpen ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur"
            ref={accountModalRef}
            onClick={(e) => {
              if (e.target === e.currentTarget) setAccountModalOpen(false);
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-modal-title"
          >
            <div
              className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-xl"
              onKeyDown={(e) => {
                if (e.key !== 'Tab') return;
                const target = e.target as HTMLElement;
                if (e.shiftKey && target === accountModalFirstFocusRef.current) {
                  e.preventDefault();
                  accountModalLastFocusRef.current?.focus();
                } else if (!e.shiftKey && target === accountModalLastFocusRef.current) {
                  e.preventDefault();
                  accountModalFirstFocusRef.current?.focus();
                }
              }}
            >
              <h3 id="account-modal-title" className="text-sm font-semibold text-slate-100">
                Account
              </h3>
              <div className="mt-3 space-y-2 text-xs text-slate-300">
                <div>
                  <span className="text-slate-500">Plan: </span>
                  {appState.auth.planTier === null ? '…' : tierLabel(appState.auth.planTier)}
                </div>
                {appState.auth.email ? (
                  <div>
                    <span className="text-slate-500">Email: </span>
                    <span className="text-slate-200">{appState.auth.email}</span>
                  </div>
                ) : null}
              </div>
              <div className="mt-4 flex flex-col gap-2">
                {isPaidTier(appState.auth.planTier) ? (
                  <button
                    ref={accountModalFirstFocusRef}
                    type="button"
                    disabled={accountActionBusy !== null || appState.auth.planTier === null}
                    className="w-full rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-400"
                    onClick={() => {
                      handleManageSubscription();
                    }}
                  >
                    {accountActionBusy === 'manage' ? 'Opening…' : 'Manage subscription'}
                  </button>
                ) : (
                  <>
                    <button
                      ref={accountModalFirstFocusRef}
                      type="button"
                      disabled={accountActionBusy !== null || appState.auth.planTier === null}
                      className="w-full rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-400"
                      onClick={() => {
                        handleUpgradeToPlus();
                      }}
                    >
                      {accountActionBusy === 'upgrade' ? 'Redirecting…' : 'Upgrade to TMM+'}
                    </button>
                    {entitlements && !entitlements.invite.redeemed ? (
                      <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                        <div className="text-[11px] text-slate-400">
                          TMM+ is invite-based during early access.
                        </div>
                        <div className="mt-2 flex gap-2">
                          <input
                            type="text"
                            value={inviteCodeInput}
                            onChange={(e) => setInviteCodeInput(e.target.value)}
                            placeholder="Invite code"
                            aria-label="Invite code"
                            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-600"
                          />
                          <button
                            type="button"
                            disabled={accountActionBusy !== null || !inviteCodeInput.trim()}
                            className="rounded border border-slate-700 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500"
                            onClick={() => {
                              handleRedeemInvite();
                            }}
                          >
                            {accountActionBusy === 'invite' ? '…' : 'Redeem'}
                          </button>
                        </div>
                        {!entitlements.waitlist.joined ? (
                          <button
                            type="button"
                            disabled={accountActionBusy !== null}
                            className="mt-2 w-full rounded border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500"
                            onClick={() => {
                              handleJoinWaitlist();
                            }}
                          >
                            {accountActionBusy === 'waitlist' ? 'Joining…' : 'Join the TMM+ waitlist'}
                          </button>
                        ) : (
                          <div className="mt-2 text-[11px] text-emerald-300">
                            You're on the waitlist ({entitlements.waitlist.status}).
                          </div>
                        )}
                      </div>
                    ) : null}
                    {inviteNotice ? (
                      <div className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200">
                        {inviteNotice}
                      </div>
                    ) : null}
                  </>
                )}
                {accountBillingError ? (
                  <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                    {accountBillingError}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="w-full rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
                  onClick={() => setAccountModalOpen(false)}
                >
                  Close
                </button>
                <button
                  ref={accountModalLastFocusRef}
                  type="button"
                  className="w-full rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/20"
                  onClick={async () => {
                    try {
                      await handleLocalSignOut();
                      setAccountModalOpen(false);
                    } catch (error) {
                      console.warn('[auth] Sign out failed', error);
                    }
                  }}
                >
                  Sign Out
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-4 text-xs text-slate-400">
          {appState.auth.email ? (
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span>{appState.auth.email}</span>
            </div>
          ) : null}
        </div>

        <hr className="my-5 border-slate-800" />

        <div className="text-xs text-slate-300">
          <div className="mb-2 font-semibold text-slate-100">Theme</div>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: 'dark-green', label: 'Dark Green' },
                { id: 'dark-blue', label: 'Dark Blue' },
                { id: 'light-green', label: 'Light Green' }
              ] as const
            ).map((option) => {
              const selected = theme === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  className={`rounded-lg border px-2 py-2 text-[11px] font-semibold transition ${
                    selected
                      ? 'border-slate-700 bg-slate-800 text-white'
                      : 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-900'
                  }`}
                  onClick={() => {
                    setTheme(option.id);
                    applyTheme(option.id);
                    setStoredTheme(option.id);
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-6 text-[11px] text-slate-500">
          Your plan is saved to your account. Google Sheets is an optional backup you control.
        </div>
      </aside>

      <main className="flex-1">
        {entitlements?.subscription.status === 'past_due' ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-100"
            role="alert"
            data-testid="dunning-banner"
          >
            <span>
              <span className="font-semibold">Payment issue:</span> your last TMM+ payment failed.
              {entitlements.subscription.grace_expires_at
                ? ` Update your card to keep TMM+ — access continues until ${new Date(entitlements.subscription.grace_expires_at).toLocaleDateString()}.`
                : ' Update your card to keep TMM+.'}
            </span>
            <button
              type="button"
              disabled={accountActionBusy !== null}
              className="rounded border border-amber-400/60 px-2.5 py-1 font-semibold text-amber-100 hover:bg-amber-500/20 disabled:cursor-not-allowed"
              onClick={() => {
                handleManageSubscription();
              }}
            >
              {accountActionBusy === 'manage' ? 'Opening…' : 'Update payment method'}
            </button>
          </div>
        ) : null}
        {children}
      </main>

      {isSyncing ? (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 backdrop-blur-sm"
          role="status"
          aria-live="polite"
          aria-label="Working with Google Sheets"
        >
          <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-700/80 bg-slate-900/80 px-6 py-5">
            <AppSpinner />
            <p className="text-xs text-slate-200">Working with your sheet…</p>
          </div>
        </div>
      ) : null}

      {sheetsToast ? (
        <div
          role="status"
          aria-live="polite"
          className={`fixed top-5 right-5 z-[10002] max-w-sm rounded-lg border px-4 py-3 shadow-lg ${
            sheetsToast.type === 'success'
              ? 'border-emerald-500/50 bg-emerald-950/95 text-emerald-100'
              : 'border-rose-500/50 bg-rose-950/95 text-rose-100'
          }`}
        >
          <p className="text-sm font-medium">{sheetsToast.message}</p>
        </div>
      ) : null}
      </div>
    </SheetsTokenProvider>
  );
}
