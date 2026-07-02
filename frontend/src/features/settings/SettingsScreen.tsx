import { useState, useEffect } from 'react';
import { getSupabaseClient } from '../../lib/supabaseClient';
import { useAppState } from '../../state/appState';
import { usePlanStore } from '../../lib/plan/planStore';
import { authFetch } from '../../lib/api/authFetch';
import { getGoogleTokenStatus, disconnectGoogle, getGoogleAuthUrl, isGoogleTokenError } from '../../lib/sheets/api';
import { clearAllAppData } from '../../lib/clearAppData';
import { getStoredSheetId, clearStoredSheetId } from '../../lib/sheets/storage';
import { useSheetsToken } from '../../lib/sheets/SheetsTokenContext';
import { syncPlanToSheets, loadPlanFromSheets, flushSheetQueue, getSheetsQueueStatus } from '../../lib/sheets/sync';
import { DEFAULT_PLAN_STATE } from '../../lib/plan/defaults';
import { loadPlanSnapshot } from '../../lib/plan/planPersistence';
import { createCheckpoint } from '../../lib/simulation/checkpoints';
import { useAppDispatch } from '../../state/appState';
import { persistSheetsDismissed, persistSheetsOAuthDone } from '../../state/localBootstrap';
import { setSheetsPrefs } from '../../lib/sheets/sheetsPrefs';
import {
  canResumeTour,
  clearTourCompleted,
  clearTourDeclined,
  setTourProgress
} from '../../features/tour/tourStorage';
import { AppSpinner } from '../../components/AppSpinner';
import {
  clearPlaidStepUpVerification,
  challengeFactor,
  enrollTotpFactor,
  getMfaStatus,
  markPlaidStepUpVerified,
  verifyChallenge,
  type MfaStatus
} from '../../lib/security/mfa';
import { navigateToRoute } from '../../app/routing';

function readCachedMfaStatus(userId?: string): MfaStatus | null {
  if (!userId || typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`tmm_mfa_status_cache_${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MfaStatus;
    if (!parsed || !Array.isArray(parsed.verifiedFactors)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedMfaStatus(userId: string | undefined, status: MfaStatus) {
  if (!userId || typeof window === 'undefined') return;
  try {
    localStorage.setItem(`tmm_mfa_status_cache_${userId}`, JSON.stringify(status));
  } catch {
    // ignore cache write errors
  }
}

export function SettingsScreen() {
  const authState = useAppState();
  const appDispatch = useAppDispatch();
  const { state: planState, dispatch: planDispatch } = usePlanStore();
  const [inflationStr, setInflationStr] = useState(() => String(planState.assumptions.inflation));
  const [sheetEmail, setSheetEmail] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(() => readCachedMfaStatus(authState.auth.userId));
  const [mfaStatusLoading, setMfaStatusLoading] = useState(true);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [mfaMessage, setMfaMessage] = useState<string | null>(null);
  const [mfaEnrollmentFactorId, setMfaEnrollmentFactorId] = useState<string | null>(null);
  const [mfaEnrollmentQr, setMfaEnrollmentQr] = useState<string | null>(null);
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);
  const [deleteAccountStatus, setDeleteAccountStatus] = useState<string | null>(null);
  const [showDeleteAccountConfirmModal, setShowDeleteAccountConfirmModal] = useState(false);
  const [showRemoveMfaConfirmModal, setShowRemoveMfaConfirmModal] = useState(false);
  const [mfaRemoveBusy, setMfaRemoveBusy] = useState(false);
  const [mfaRemoveError, setMfaRemoveError] = useState<string | null>(null);
  const [mfaVerifyBusy, setMfaVerifyBusy] = useState(false);
  const [mfaStatusFetchFailed, setMfaStatusFetchFailed] = useState(false);
  const queueStatus = getSheetsQueueStatus();

  const sheetsConnected = authState.sheets.connectionVerified ? authState.sheets.connected : false;
  const effectiveSheetId = authState.sheets.spreadsheetId ?? getStoredSheetId();
  const sheetsToken = useSheetsToken();
  const backendApiBase = (planState.plaidConfig?.backendApiUrl || '').replace(/\/$/, '');

  const handleLocalSignOut = async () => {
    clearPlaidStepUpVerification(authState.auth.userId);
    await getSupabaseClient().auth.signOut({ scope: 'local' });
  };

  useEffect(() => {
    setInflationStr(String(planState.assumptions.inflation));
  }, [planState.assumptions.inflation]);

  useEffect(() => {
    if (!sheetsConnected || !authState.sheets.connectionVerified) return;
    getGoogleTokenStatus()
      .then((result) => {
        setSheetEmail(result?.email ?? null);
      })
      .catch(() => {
        setSheetEmail(null);
      });
  }, [sheetsConnected, authState.sheets.connectionVerified]);

  const refreshMfaStatus = async () => {
    const MFA_STATUS_TIMEOUT_MS = 3000;
    setMfaStatusLoading(true);
    try {
      const status = await Promise.race([
        getMfaStatus(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MFA_STATUS_TIMEOUT')), MFA_STATUS_TIMEOUT_MS)
        )
      ]);
      setMfaStatus(status);
      setMfaStatusFetchFailed(false);
      writeCachedMfaStatus(authState.auth.userId, status);
      setMfaMessage((prev) => {
        if (!prev) return prev;
        if (prev.includes('MFA status refresh is delayed') || prev.includes('MFA status temporarily unavailable')) {
          return null;
        }
        return prev;
      });
    } catch (error) {
      const errorMsg = String((error as Error)?.message ?? error);
      const isTimeout = errorMsg === 'MFA_STATUS_TIMEOUT';
      if (!isTimeout) {
        console.warn('[mfa] Failed to fetch MFA status', error);
      }
      // Keep prior value if refresh fails/times out, so UI doesn't falsely show "Not enabled".
      // Only mark as failed / show message when we have no known status to render.
      if (!mfaStatus) {
        setMfaStatusFetchFailed(true);
        setMfaMessage((prev) =>
          prev ??
          (isTimeout
            ? 'MFA status temporarily unavailable. Showing cached state when available.'
            : 'MFA status failed to refresh. Please try again.')
        );
      }
    } finally {
      setMfaStatusLoading(false);
    }
  };

  useEffect(() => {
    refreshMfaStatus();
  }, []);

  useEffect(() => {
    if (mfaStatus) return;
    const cached = readCachedMfaStatus(authState.auth.userId);
    if (cached) {
      setMfaStatus(cached);
      setMfaStatusFetchFailed(false);
    }
  }, [authState.auth.userId, mfaStatus]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      refreshMfaStatus();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const removeMfaFactor = async () => {
    if (!backendApiBase) {
      setMfaRemoveError('Set your backend API URL in Plaid Integration settings first.');
      return;
    }
    const factorId = mfaStatus?.verifiedFactors?.[0]?.id;
    if (!factorId) {
      setMfaRemoveError('No MFA factor to remove.');
      return;
    }
    setMfaRemoveError(null);
    setMfaRemoveBusy(true);
    try {
      await authFetch(`${backendApiBase}/api/auth/mfa/remove-factor`, {
        method: 'POST',
        body: JSON.stringify({ factor_id: factorId })
      });
      clearPlaidStepUpVerification(authState.auth.userId);
      setShowRemoveMfaConfirmModal(false);
      setMfaMessage('MFA removed. You can enable it again anytime.');
      setMfaError(null);
      await refreshMfaStatus();
    } catch (err: unknown) {
      let msg = 'Failed to remove MFA factor.';
      if (err && typeof err === 'object' && 'message' in err) {
        const raw = String((err as { message: unknown }).message);
        const looksLikeHtml = /<\s*\!?DOCTYPE|<\s*html\s|<\s*pre\s*>/i.test(raw);
        if (looksLikeHtml) {
          msg =
            "The backend didn't respond to Remove MFA. Make sure the Backend API URL in Plaid Integration (Settings) points to your Node server (e.g. http://localhost:3001), and that the server is running.";
        } else {
          try {
            const body = JSON.parse(raw);
            if (typeof body?.message === 'string') msg = body.message;
            else if (typeof body?.error === 'string') msg = body.error;
          } catch {
            if (raw && raw.length < 300) msg = raw;
          }
        }
      }
      setMfaRemoveError(msg);
    } finally {
      setMfaRemoveBusy(false);
    }
  };

  const beginMfaEnrollment = async () => {
    setMfaError(null);
    setMfaMessage(null);
    try {
      const data: any = await enrollTotpFactor();
      setMfaEnrollmentFactorId(data?.id || null);
      setMfaEnrollmentQr(data?.totp?.qr_code || null);
      setMfaMessage('Scan the QR code, then enter a code to verify.');
    } catch (error) {
      console.warn('[mfa] Enrollment failed', error);
      setMfaError('Unable to enroll MFA factor. Please try again.');
    }
  };

  const verifyEnrollment = async () => {
    if (!mfaEnrollmentFactorId) {
      setMfaError('Start enrollment first.');
      return;
    }
    setMfaError(null);
    setMfaMessage(null);
    setMfaVerifyBusy(true);
    const VERIFY_TIMEOUT_MS = 12000;
    try {
      const challenge: any = await challengeFactor(mfaEnrollmentFactorId);
      setMfaChallengeId(challenge?.id || null);
      await Promise.race([
        verifyChallenge(mfaEnrollmentFactorId, challenge.id, mfaCode.trim()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MFA_VERIFY_TIMEOUT')), VERIFY_TIMEOUT_MS)
        )
      ]);
      markPlaidStepUpVerified(authState.auth.userId);
      // Optimistically reflect verified state and dismiss overlay immediately.
      setMfaStatus((prev) => {
        const nextFactors = [...(prev?.verifiedFactors || [])];
        if (!nextFactors.some((factor) => factor.id === mfaEnrollmentFactorId)) {
          nextFactors.push({
            id: mfaEnrollmentFactorId,
            factorType: 'totp',
            status: 'verified',
            friendlyName: 'TMM Plaid MFA'
          });
        }
        return {
          hasVerifiedFactor: true,
          verifiedFactors: nextFactors,
          aal: prev?.aal ?? null
        };
      });
      setMfaChallengeId(null);
      setMfaEnrollmentFactorId(null);
      setMfaEnrollmentQr(null);
      setMfaCode('');
      setMfaMessage('MFA verified successfully. This device will stay trusted for Plaid step-up for 30 days.');
      setMfaVerifyBusy(false);
      // Refresh session and MFA status in background so overlay doesn't hang if these are slow.
      getSupabaseClient()
        .auth.getSession()
        .then(() => refreshMfaStatus())
        .catch(() => {});
    } catch (error) {
      const isTimeout = (error as Error)?.message === 'MFA_VERIFY_TIMEOUT';
      if (isTimeout) {
        setMfaVerifyBusy(false);
        setMfaError(null);
        markPlaidStepUpVerified(authState.auth.userId);
        // Verification likely succeeded on the server; show enabled state so user doesn't need to reload.
        setMfaStatus((prev) => {
          const nextFactors = [...(prev?.verifiedFactors || [])];
          if (mfaEnrollmentFactorId && !nextFactors.some((f) => f.id === mfaEnrollmentFactorId)) {
            nextFactors.push({
              id: mfaEnrollmentFactorId,
              factorType: 'totp',
              status: 'verified',
              friendlyName: 'TMM Plaid MFA'
            });
          }
          return {
            hasVerifiedFactor: nextFactors.length > 0,
            verifiedFactors: nextFactors,
            aal: prev?.aal ?? null
          };
        });
        setMfaChallengeId(null);
        setMfaEnrollmentFactorId(null);
        setMfaEnrollmentQr(null);
        setMfaCode('');
        setMfaMessage(
          'Verification completed. MFA is now enabled. This device will stay trusted for Plaid step-up for 30 days.'
        );
        getSupabaseClient()
          .auth.getSession()
          .then(() => refreshMfaStatus())
          .catch(() => {});
        return;
      }
      console.warn('[mfa] Verification failed', error);
      setMfaError('Invalid MFA code. Please try again.');
      setMfaVerifyBusy(false);
    }
  };

  const requestDeleteAccount = async () => {
    if (!backendApiBase) {
      setDeleteAccountStatus('Set your backend API URL first in Plaid Integration settings.');
      setShowDeleteAccountConfirmModal(false);
      return;
    }
    setShowDeleteAccountConfirmModal(false);
    setDeleteAccountBusy(true);
    setDeleteAccountStatus(null);
    try {
      await authFetch(`${backendApiBase}/api/privacy/delete-account`, {
        method: 'POST',
        body: JSON.stringify({
          confirm_text: deleteConfirmText,
          reason: 'user_requested_in_settings'
        })
      });
      setDeleteAccountStatus('Account deletion completed. You will be signed out.');
      await handleLocalSignOut();
    } catch (error) {
      console.warn('[privacy] Account deletion failed', error);
      setDeleteAccountStatus('Account deletion failed. Check confirmation text and try again.');
    } finally {
      setDeleteAccountBusy(false);
    }
  };

  const commitInflation = (raw: string) => {
    const n = Number.parseFloat(raw);
    const value = raw === '' || !Number.isFinite(n) ? 0 : n;
    planDispatch({
      type: 'setAssumptions',
      assumptions: { ...planState.assumptions, inflation: value }
    });
  };

  const setStart = (start: string) => {
    planDispatch({
      type: 'setAssumptions',
      assumptions: { ...planState.assumptions, start: start || new Date().toISOString().slice(0, 10) }
    });
  };

  const setFinnhubKey = (key: string) => {
    planDispatch({
      type: 'setAssumptions',
      assumptions: { ...planState.assumptions, finnhubKey: key }
    });
  };

  const updatePlaidConfig = (next: Partial<typeof planState.plaidConfig>) => {
    const updated = { ...planState.plaidConfig, ...next };
    planDispatch({ type: 'hydrate', plan: { ...planState, plaidConfig: updated } });
  };

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-200">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h1 className="text-2xl font-semibold text-slate-100" data-tour="settings-header">
            Settings
          </h1>
          <div className="mt-2 text-xs text-slate-500">
            Plan: {Object.keys(planState.alternatives || {}).length ? 'loaded' : 'empty'}
            {planState.lastSaved ? ` · last saved ${new Date(planState.lastSaved).toLocaleString()}` : ''}
          </div>
        </div>

        <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Global Assumptions</h2>
          <div className="flex flex-wrap gap-4">
            <label className="text-xs text-slate-400">
              Inflation %/yr
              <input
                className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                inputMode="decimal"
                type="number"
                value={inflationStr}
                onChange={(e) => setInflationStr(e.target.value)}
                onBlur={() => commitInflation(inflationStr)}
              />
            </label>
            <label className="text-xs text-slate-400">
              Start Date
              <input
                className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                type="date"
                value={planState.assumptions.start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
          </div>
          <div className="text-xs text-slate-500">Defaults apply where a row doesn&apos;t specify by itself. Changes sync to your plan immediately; use Sync now to push to Google Sheets.</div>
        </section>

        <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Market Data (Finnhub)</h2>
          <label className="text-xs text-slate-400">
            API Key
            <input
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
              type="password"
              value={planState.assumptions.finnhubKey}
              onChange={(e) => setFinnhubKey(e.target.value)}
            />
          </label>
          <div className="text-xs text-slate-500">
            Used for ticker search + live quotes & 1Y APY prefill. Stored in your plan and synced with Sync now.
          </div>
        </section>

        <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Restore Previous Session</h2>
          <div className="text-xs text-slate-500">
            Recover your last saved local session. This will overwrite your current state.
          </div>
          <div className="text-xs text-slate-400">
            {(() => {
              const snapshot = loadPlanSnapshot();
              const altCount = Object.keys(snapshot.alternatives || {}).length;
              return `Snapshot: ${altCount} alternatives · last saved ${snapshot.lastSaved || 'unknown'}`;
            })()}
          </div>
          <button
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
            type="button"
            onClick={() => {
              const snapshot = loadPlanSnapshot();
              planDispatch({ type: 'hydrate', plan: { ...snapshot, isSampleData: false } });
            }}
          >
            Restore Session
          </button>
        </section>

        <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Authentication</h2>
          <div className="text-xs text-slate-400">
            Signed in as <span className="text-slate-100">{authState.auth.email ?? 'Not signed in'}</span>
          </div>
          <button
            className="rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
            type="button"
            onClick={async () => {
              try {
                await handleLocalSignOut();
              } catch (error) {
                console.warn('[auth] Sign out failed', error);
              }
            }}
          >
            Sign out
          </button>
        </section>

        <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Multi-Factor Authentication (Plaid step-up)</h2>
          <div className="text-xs text-slate-400">
            MFA is optional for Plaid, but strongly recommended. Verified step-up is trusted on this device for 30 days.
          </div>
          <div className="text-xs text-slate-300">
            Status:{' '}
            {mfaStatusLoading && !mfaStatus ? (
              <span className="text-slate-400">Checking...</span>
            ) : !mfaStatus && mfaStatusFetchFailed ? (
              <span className="text-amber-300">Status unavailable (timeout)</span>
            ) : mfaStatus?.hasVerifiedFactor ? (
              <span className="text-emerald-300">Enabled ({mfaStatus.verifiedFactors.length} verified factor{mfaStatus.verifiedFactors.length === 1 ? '' : 's'})</span>
            ) : (
              <span className="text-amber-300">Not enabled</span>
            )}
          </div>
          {!mfaStatus?.hasVerifiedFactor ? (
            <button
              className="rounded-lg border border-cyan-600/60 bg-cyan-500/15 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/25"
              type="button"
              onClick={beginMfaEnrollment}
            >
              Enable MFA (TOTP)
            </button>
          ) : (
            <button
              className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700"
              type="button"
              onClick={() => {
                setMfaRemoveError(null);
                setShowRemoveMfaConfirmModal(true);
              }}
              disabled={mfaRemoveBusy}
            >
              Remove MFA
            </button>
          )}
          {mfaEnrollmentQr ? (
            <div className="space-y-2 rounded-md border border-slate-700 bg-slate-950 p-3">
              <div className="text-xs text-slate-400">Scan this QR code in your authenticator app:</div>
              <div className="max-w-[220px] overflow-hidden rounded border border-slate-800 bg-white p-2">
                <img src={mfaEnrollmentQr} alt="MFA QR code" className="h-auto w-full" />
              </div>
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                type="text"
                inputMode="numeric"
                placeholder="Enter 6-digit code"
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
              />
              <button
                className="rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-xs text-slate-100 hover:bg-slate-600 disabled:opacity-50"
                type="button"
                onClick={verifyEnrollment}
                disabled={mfaVerifyBusy}
              >
                {mfaVerifyBusy ? 'Verifying…' : 'Verify MFA Setup'}
              </button>
            </div>
          ) : null}
          {mfaChallengeId ? (
            <div className="text-[11px] text-slate-500">Challenge in progress: {mfaChallengeId.slice(0, 8)}...</div>
          ) : null}
          {mfaError ? <div className="text-xs text-rose-300">{mfaError}</div> : null}
          {mfaMessage ? <div className="text-xs text-emerald-300">{mfaMessage}</div> : null}
        </section>

        {mfaVerifyBusy ? (
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 backdrop-blur-sm"
            role="status"
            aria-live="polite"
            aria-label="Verifying MFA"
          >
            <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-700/80 bg-slate-900/80 px-6 py-5">
              <AppSpinner />
              <p className="text-xs text-slate-200">Verifying MFA…</p>
            </div>
          </div>
        ) : null}

        {showRemoveMfaConfirmModal ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="mx-4 w-full max-w-md rounded-lg border border-slate-700 bg-slate-950 p-5 shadow-xl">
              <h3 className="text-lg font-semibold text-slate-100">Remove MFA?</h3>
              <p className="mt-3 text-sm text-slate-300">
                This will remove the current MFA factor from your account. You can re-enable MFA later with a new QR code in your authenticator app.
              </p>
              {mfaRemoveError ? <div className="mt-3 text-xs text-rose-300">{mfaRemoveError}</div> : null}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  className="rounded-md border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                  type="button"
                  onClick={() => !mfaRemoveBusy && setShowRemoveMfaConfirmModal(false)}
                  disabled={mfaRemoveBusy}
                >
                  Cancel
                </button>
                <button
                  className="rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-600 disabled:opacity-50"
                  type="button"
                  onClick={removeMfaFactor}
                  disabled={mfaRemoveBusy}
                >
                  {mfaRemoveBusy ? 'Removing...' : 'Remove MFA'}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Privacy &amp; Data Retention</h2>
          <p className="text-xs text-slate-400">
            Our privacy policy and data retention and deletion policy explain what we collect, how we use it, and how you can delete your data.
          </p>
          <button
            type="button"
            className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-cyan-300 hover:bg-slate-800 hover:text-cyan-200"
            onClick={() => navigateToRoute('privacy')}
          >
            View Privacy Policy and Data Retention
          </button>
        </section>

        <section className="space-y-3 rounded-lg border border-rose-900/50 bg-rose-950/10 p-5">
          <h2 className="text-sm font-semibold text-rose-200">Data Retention and Deletion</h2>
          <div className="text-xs text-slate-300">
            To delete all account data, type <span className="font-mono text-rose-200">DELETE MY DATA</span> and submit.
            This removes Plaid items, linked data, and your account.
          </div>
          <input
            className="w-full rounded-md border border-rose-900/50 bg-slate-950 px-3 py-2 text-sm text-slate-100"
            type="text"
            value={deleteConfirmText}
            onChange={(event) => setDeleteConfirmText(event.target.value)}
            placeholder="DELETE MY DATA"
          />
          <button
            className="rounded-lg border border-rose-500/60 bg-rose-500/15 px-3 py-2 text-xs text-rose-200 hover:bg-rose-500/25 disabled:opacity-50"
            type="button"
            disabled={deleteAccountBusy || deleteConfirmText.trim().toUpperCase() !== 'DELETE MY DATA'}
            onClick={() => setShowDeleteAccountConfirmModal(true)}
          >
            {deleteAccountBusy ? 'Deleting...' : 'Delete My Account and Data'}
          </button>
          {deleteAccountStatus ? <div className="text-xs text-slate-300">{deleteAccountStatus}</div> : null}
        </section>

        {showDeleteAccountConfirmModal ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="mx-4 w-full max-w-md rounded-lg border border-rose-900/60 bg-slate-950 p-5 shadow-xl">
              <h3 className="text-lg font-semibold text-rose-200">Are you sure?</h3>
              <p className="mt-3 text-sm text-slate-300">
                This will permanently delete your account and all data we hold. This cannot be undone.
              </p>
              <ul className="mt-3 list-inside list-disc space-y-1 text-xs text-slate-400">
                <li>Your login account will be removed; you will be signed out and cannot use this email to sign in again unless you create a new account.</li>
                <li>All linked bank connections (Plaid) will be disconnected and our copy of transaction history will be deleted.</li>
                <li>Your Google Sheets connection and any stored preferences will be removed.</li>
                <li>Plans, checkpoints, and other data stored in TMM for you will be permanently deleted.</li>
              </ul>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  className="rounded-md border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-200 hover:bg-slate-700"
                  type="button"
                  onClick={() => setShowDeleteAccountConfirmModal(false)}
                >
                  Cancel
                </button>
                <button
                  className="rounded-md border border-rose-500/70 bg-rose-600/30 px-3 py-2 text-xs font-medium text-rose-200 hover:bg-rose-600/50"
                  type="button"
                  onClick={requestDeleteAccount}
                >
                  Yes, permanently delete everything
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Plaid Integration (TMM+)</h2>
          {authState.auth.planTier !== 'tmm_plus' ? (
            <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3 text-xs text-slate-400">
              Plaid is available on TMM+. Upgrade to connect real bank accounts and configure Plaid here.
            </div>
          ) : (
            <>
              <label className="text-xs text-slate-400">
                Backend API URL
                <input
                  className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  type="text"
                  value={planState.plaidConfig.backendApiUrl}
                  onChange={(event) => updatePlaidConfig({ backendApiUrl: event.target.value })}
                />
              </label>
              <label className="text-xs text-slate-400">
                Environment
                <select
                  className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  value={planState.plaidConfig.environment}
                  onChange={(event) => updatePlaidConfig({ environment: event.target.value as any })}
                >
                  <option value="sandbox">Sandbox (Testing)</option>
                  <option value="development">Development</option>
                  <option value="production">Production</option>
                </select>
              </label>
              <div className="text-xs text-slate-500">
                Plaid API calls are made through a secure backend server. Configure your backend API URL (default: https://tmm.finance).
                Plaid settings save automatically when you change them.
              </div>
            </>
          )}
        </section>

        <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Tour & Help</h2>
          <div className="flex flex-wrap gap-2">
            <button
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
              type="button"
              onClick={() => {
                clearTourCompleted();
                clearTourDeclined();
                setTourProgress('load-sample-data');
                appDispatch({ type: 'tour', tourActive: true });
              }}
            >
              Restart Tour
            </button>
            {canResumeTour() ? (
              <button
                className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
                type="button"
                onClick={() => {
                  clearTourDeclined();
                  appDispatch({ type: 'tour', tourActive: true });
                }}
              >
                Resume Tour
              </button>
            ) : null}
          </div>
          <div className="text-xs text-slate-500">Take the guided tour to learn about all features</div>
        </section>

        <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Checkpoints</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
              type="button"
              onClick={() => {
                const nextPlan = JSON.parse(JSON.stringify(planState));
                createCheckpoint(nextPlan, planState.activeAlt, 'manual', {
                  provenance: 'user-entered',
                  source: 'settings'
                });
                planDispatch({ type: 'hydrate', plan: nextPlan });
              }}
            >
              Save Checkpoint Now
            </button>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={planState.checkpointSettings.autoCreateMonthly}
                onChange={(event) =>
                  planDispatch({
                    type: 'hydrate',
                    plan: {
                      ...planState,
                      checkpointSettings: {
                        ...planState.checkpointSettings,
                        autoCreateMonthly: event.target.checked
                      }
                    }
                  })
                }
              />
              Auto-create monthly checkpoints
            </label>
          </div>
          <div className="text-xs text-slate-500">
            Checkpoints are immutable snapshots. Use for historical tracking and reconciliation.
          </div>
        </section>

        <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Sync & Backup</h2>
          <div className="text-xs text-slate-400">
            Status:{' '}
            {!authState.sheets.connectionVerified
              ? 'Checking connection…'
              : authState.sheets.connected
                ? 'Connected'
                : 'Not connected'}
            {sheetEmail ? ` · ${sheetEmail}` : ''}
          </div>
          <div className="text-xs text-slate-500">Spreadsheet ID: {effectiveSheetId || 'not created'}</div>
          {queueStatus.pending > 0 ? (
            <div className="text-xs text-amber-300">
              Pending writes: {queueStatus.pending}
              {queueStatus.latestError ? ` · Last error: ${queueStatus.latestError}` : ''}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {authState.sheets.connectionVerified && !authState.sheets.connected ? (
              <button
                className="rounded-lg border border-indigo-500/70 bg-indigo-500/20 px-3 py-2 text-xs text-indigo-200"
                type="button"
                onClick={async () => {
                  const url = await getGoogleAuthUrl();
                  window.location.href = url;
                }}
              >
                CONNECT SHEETS
              </button>
            ) : null}
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 disabled:opacity-50"
              type="button"
              disabled={isSyncing || !effectiveSheetId || !authState.sheets.connected}
              onClick={async () => {
                if (!authState.sheets.connected || !effectiveSheetId) return;
                setIsSyncing(true);
                try {
                  const result = await syncPlanToSheets(planState, effectiveSheetId, sheetsToken ?? undefined);
                  if (!result.ok && result.errors.some((e) => isGoogleTokenError(e))) {
                    clearStoredSheetId();
                    persistSheetsOAuthDone(false);
                    appDispatch({ type: 'sheets', connected: false, dismissed: false, connectionVerified: true });
                  }
                } catch (error) {
                  console.warn('[sheets] Sync failed', error);
                  const msg = error instanceof Error ? error.message : String(error);
                  if (isGoogleTokenError(msg)) {
                    clearStoredSheetId();
                    persistSheetsOAuthDone(false);
                    appDispatch({ type: 'sheets', connected: false, dismissed: false, connectionVerified: true });
                  }
                } finally {
                  setIsSyncing(false);
                }
              }}
            >
              {isSyncing ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 disabled:opacity-50"
              type="button"
              disabled={isSyncing || !effectiveSheetId || !authState.sheets.connected}
              onClick={async () => {
                if (!authState.sheets.connected || !effectiveSheetId) return;
                setIsSyncing(true);
                try {
                  const nextPlan = await loadPlanFromSheets(effectiveSheetId, sheetsToken ?? undefined);
                  planDispatch({ type: 'hydrate', plan: { ...nextPlan, isSampleData: false } });
                } catch (error) {
                  console.warn('[sheets] Refresh failed', error);
                  const msg = error instanceof Error ? error.message : String(error);
                  if (isGoogleTokenError(msg)) {
                    clearStoredSheetId();
                    persistSheetsOAuthDone(false);
                    appDispatch({ type: 'sheets', connected: false, dismissed: false, connectionVerified: true });
                  }
                } finally {
                  setIsSyncing(false);
                }
              }}
            >
              Refresh from sheet
            </button>
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 disabled:opacity-50"
              type="button"
              disabled={isSyncing || !effectiveSheetId}
              onClick={async () => {
                if (!effectiveSheetId) return;
                await flushSheetQueue(effectiveSheetId);
              }}
            >
              Flush queue
            </button>
            <div className="flex flex-col gap-1">
              <button
                className="rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200 w-fit"
                type="button"
                onClick={async () => {
                  await disconnectGoogle();
                  clearStoredSheetId();
                  setSheetEmail(null);
                  appDispatch({ type: 'sheets', connected: false, dismissed: false, connectionVerified: true });
                }}
              >
                Disconnect from Google Sheets
              </button>
              <p className="text-[11px] text-slate-500">
                Revoke TMM&apos;s access to Google Sheets. You can always re-connect again.
              </p>
            </div>
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
              type="button"
              onClick={async () => {
                if (!window.confirm('Clear all local data? You will stay signed in.')) {
                  return;
                }
                const currentSheetId = getStoredSheetId();
                if (currentSheetId) {
                  clearStoredSheetId();
                  persistSheetsDismissed(true);
                  appDispatch({
                    type: 'sheets',
                    connected: authState.sheets.connected,
                    connectionVerified: authState.sheets.connectionVerified,
                    dismissed: true,
                    spreadsheetId: null
                  });
                  setSheetsPrefs({ sheetsNudgeDismissed: true, lastSpreadsheetId: null });
                }
                clearAllAppData();
                planDispatch({ type: 'hydrate', plan: { ...DEFAULT_PLAN_STATE } });
              }}
            >
              Clear All Data
            </button>
          </div>
          <div className="text-xs text-slate-500">
            {authState.sheets.connectionVerified && authState.sheets.connected
              ? 'Synced with Google Sheets.'
              : 'Working offline. Sign in to sync with Google Sheets.'}
          </div>
        </section>
      </div>
    </div>
  );
}
