import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import {
  flattenPlaidItemsToConnectedAccounts,
  loadMockAccountsOnly,
  loadPlaidItemsWithAccountsResponse,
  saveConnectedAccounts,
  type ConnectedAccount
} from './legacyAdapters';
import { connectMockAccount, disconnectMockAccount } from './mockBankAdapter';
import { authFetch } from '../../lib/api/authFetch';
import { describePlaidSyncResult, triggerPlaidTransactionsSync } from '../../lib/plaid/transactionsSync';
import { usePlanStore } from '../../lib/plan/planStore';
import { applyManualOverride, revertToConnected, getEffectiveValue } from '../../lib/plan/overrideManager';
import { useAppState } from '../../state/appState';
import { navigateToRoute, dispatchNavigationEvent } from '../../app/routing';
import { isPaidTier } from '../../lib/entitlements/tier';
import { resolveBackendBaseUrl } from '../../lib/api/backendBase';
import { AppSpinner } from '../../components/AppSpinner';
import {
  challengeFactor,
  dismissMfaRecommendation,
  getMfaStatus,
  hasFreshPlaidStepUp,
  markPlaidStepUpVerified,
  shouldShowMfaRecommendation,
  verifyChallenge,
  type MfaStatus
} from '../../lib/security/mfa';
import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';
import { applyConnectedBalancesToPlan, revertStalePlanLinks } from './applyConnectedToPlan';

/** Stable component so usePlaidLink runs once per token; avoids "embedded more than once" and update loops. */
type PlaidSuccessAccountMetadata = {
  name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
};

type PlaidSuccessMetadata = {
  institution?: {
    institution_id?: string | null;
    name?: string | null;
  } | null;
  accounts?: PlaidSuccessAccountMetadata[];
  link_session_id?: string | null;
};

type PlaidLinkEventMetadata = {
  institution_id?: string | null;
  institution_name?: string | null;
  link_session_id?: string | null;
  request_id?: string | null;
  view_name?: string | null;
};

type PlaidLinkExitError = {
  error_type?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

type PlaidLinkExitMetadata = PlaidLinkEventMetadata & {
  status?: string | null;
};

type ApiErrorPayload = {
  error?: string;
  code?: string;
  retry_after_date?: string | null;
};

type PlaidSyncStatusItem = {
  item_id: string;
  needs_update_mode?: boolean;
  last_sync_finished_at?: string | null;
  next_eligible_at?: string | null;
};

type PlaidSyncStatusResponse = {
  running?: boolean;
  now_iso?: string | null;
  items?: PlaidSyncStatusItem[];
};

function parseApiError(error: unknown): ApiErrorPayload | null {
  if (!(error instanceof Error)) return null;
  const raw = String(error.message || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as ApiErrorPayload : null;
  } catch {
    return { error: raw };
  }
}

function formatDateTimeLabel(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString();
}

function formatRelativeFutureLabel(value?: string | null): string | null {
  if (!value) return null;
  const atMs = new Date(value).getTime();
  if (!Number.isFinite(atMs)) return null;
  const diffMs = atMs - Date.now();
  if (diffMs <= 0) return 'soon';
  const minutes = Math.ceil(diffMs / 60000);
  if (minutes < 60) return `in ~${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `in ~${hours} hr`;
}

function PlaidBridge({
  token,
  onSuccess,
  onEvent,
  onExit,
  onOpen,
  openRef,
  onReadyChange
}: {
  token: string;
  onSuccess: (publicToken: string, metadata: PlaidSuccessMetadata) => void;
  onEvent: (eventName: string, metadata: PlaidLinkEventMetadata) => void;
  onExit: (error: PlaidLinkExitError | null, metadata: PlaidLinkExitMetadata) => void;
  onOpen: (source: string) => void;
  openRef: React.MutableRefObject<(source?: string) => void>;
  onReadyChange: (ready: boolean) => void;
}) {
  const { open, ready } = usePlaidLink({ token, onSuccess, onEvent, onExit });
  const prevReadyRef = useRef<boolean | null>(null);

  useEffect(() => {
    openRef.current = (source = 'unknown') => {
      onOpen(source);
      (open as () => void)();
    };
    if (prevReadyRef.current !== ready) {
      prevReadyRef.current = ready;
      onReadyChange(ready);
    }
  }, [open, ready, openRef, onReadyChange, onOpen]);

  return null;
}

export function AccountIntegrationScreen() {
  const { state: planState, dispatch } = usePlanStore();
  const appState = useAppState();
  const planTier = appState.auth.planTier;
  const isTmmPlus = isPaidTier(planTier);
  const formatCurrency = (value: number | null | undefined, currencyCode?: string) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode || 'USD',
        maximumFractionDigits: 2
      }).format(value);
    } catch {
      return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    }
  };
  const [accounts, setAccounts] = React.useState<ConnectedAccount[]>(() => loadMockAccountsOnly());
  const [linkToken, setLinkToken] = React.useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'account' | 'income' | 'expense' | 'debt' | 'asset'>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'connected' | 'unconnected' | 'overridden'>('all');
  const [showDrawer, setShowDrawer] = useState(false);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showMfaGateModal, setShowMfaGateModal] = useState(false);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [showMockModal, setShowMockModal] = useState(false);
  const [pendingRemoveItemId, setPendingRemoveItemId] = useState<string | null>(null);
  const [plaidActionLoading, setPlaidActionLoading] = useState(false);
  const [plaidSyncOverlayVisible, setPlaidSyncOverlayVisible] = useState(false);
  const [plaidSyncStatus, setPlaidSyncStatus] = useState<PlaidSyncStatusResponse | null>(null);
  const [plaidSyncFeedback, setPlaidSyncFeedback] = useState<string | null>(null);
  const [plaidSyncRefreshing, setPlaidSyncRefreshing] = useState(false);
  const [plaidLinkMessage, setPlaidLinkMessage] = useState<string | null>(null);
  const [plaidItemCount, setPlaidItemCount] = useState(0);
  const [plaidItemCap, setPlaidItemCap] = useState(5);
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [mfaStatusLoading, setMfaStatusLoading] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaChallengeId, setMfaChallengeId] = useState<string | null>(null);
  const [mfaError, setMfaError] = useState<string | null>(null);
  const [plaidConsentAccepted, setPlaidConsentAccepted] = useState(false);
  const [plaidConsentRequiresReconsent, setPlaidConsentRequiresReconsent] = useState(false);
  const [plaidConsentVersion, setPlaidConsentVersion] = useState('2026-02-09');
  const [consentSaving, setConsentSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const accountRefs = useRef(new Map<string, HTMLDivElement>());
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const sectionHeaderRefs = useRef(new Map<string, HTMLDivElement>());
  const [lines, setLines] = useState<Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }>>([]);
  const COLLAPSE_STORAGE_PREFIX = 'accountIntegration_collapse_';
  const COLLAPSE_ITEM_PREFIX = 'accountIntegration_collapse_item_';
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => {
    if (typeof window === 'undefined') return {};
    const init: Record<string, boolean> = {};
    (['income', 'expense', 'asset', 'debt'] as const).forEach((type) => {
      init[type] = getScopedLocalStorageItem(`${COLLAPSE_STORAGE_PREFIX}${type}`) === 'true';
    });
    return init;
  });
  const [collapsedPlaidItems, setCollapsedPlaidItems] = useState<Record<string, boolean>>({});
  const plaidItemHeaderRefs = useRef(new Map<string, HTMLDivElement>());
  const toggleSection = (type: string) => {
    setCollapsedSections((prev) => {
      const next = { ...prev, [type]: !prev[type] };
      if (typeof window !== 'undefined') {
        setScopedLocalStorageItem(`${COLLAPSE_STORAGE_PREFIX}${type}`, String(next[type]));
      }
      return next;
    });
  };
  const togglePlaidItem = (itemId: string) => {
    setCollapsedPlaidItems((prev) => {
      const next = { ...prev, [itemId]: !prev[itemId] };
      if (typeof window !== 'undefined') {
        setScopedLocalStorageItem(`${COLLAPSE_ITEM_PREFIX}${itemId}`, String(next[itemId]));
      }
      return next;
    });
  };
  const plaidBaseUrl = useMemo(
    () => resolveBackendBaseUrl(planState.plaidConfig?.backendApiUrl),
    [planState.plaidConfig?.backendApiUrl]
  );
  const plaidEnabled = Boolean(isTmmPlus && plaidBaseUrl);

  const hasPlaidAccountsFetchedRef = useRef(false);
  const refetchPlaidAccounts = React.useCallback(async () => {
    if (!plaidEnabled || !appState.auth.userId) return;
    try {
      const response = await loadPlaidItemsWithAccountsResponse(plaidBaseUrl, authFetch);
      const plaidAccounts = flattenPlaidItemsToConnectedAccounts(response.items || []);
      setAccounts([...plaidAccounts, ...loadMockAccountsOnly()]);
      hasPlaidAccountsFetchedRef.current = true;
      setPlaidItemCount(typeof response.item_count === 'number' ? response.item_count : 0);
      setPlaidItemCap(typeof response.item_cap === 'number' ? response.item_cap : 5);
    } catch (err) {
      console.warn('[account-integration] Failed to load Plaid accounts from backend', err);
    }
  }, [plaidEnabled, plaidBaseUrl, appState.auth.userId]);

  const fetchPlaidSyncStatus = React.useCallback(async () => {
    if (!plaidEnabled || !plaidBaseUrl || !appState.auth.userId) return null;
    try {
      const status = await authFetch(`${plaidBaseUrl}/api/plaid/sync/status`, { method: 'GET' });
      setPlaidSyncStatus(status || null);
      return status || null;
    } catch (error) {
      console.warn('[plaid] Failed to load sync status', error);
      setPlaidSyncStatus(null);
      return null;
    }
  }, [plaidEnabled, plaidBaseUrl, appState.auth.userId]);

  const runPlaidSyncTrigger = React.useCallback(
    async (userInitiated: boolean, options: { quietSkips?: boolean } = {}) => {
      if (!plaidEnabled || !plaidBaseUrl || !appState.auth.userId) return null;
      const result = await triggerPlaidTransactionsSync(plaidBaseUrl, { userInitiated });
      // Background (page-visit) triggers are expected to be skipped by the server's
      // 15-minute gate most of the time — don't surface that as user-facing feedback.
      if (!(options.quietSkips && result.skipped)) {
        setPlaidSyncFeedback(describePlaidSyncResult(result));
      }
      if (result.running) {
        setPlaidSyncOverlayVisible(true);
      } else if (result.ok && (result.reason === 'accounts_refresh_only' || !result.skipped)) {
        await refetchPlaidAccounts();
        await fetchPlaidSyncStatus();
      }
      return result;
    },
    [plaidEnabled, plaidBaseUrl, appState.auth.userId, refetchPlaidAccounts, fetchPlaidSyncStatus]
  );

  const handleRefreshPlaidData = React.useCallback(async () => {
    if (!plaidEnabled || plaidSyncRefreshing || plaidSyncOverlayVisible) return;
    setPlaidSyncRefreshing(true);
    setPlaidSyncFeedback(null);
    try {
      const status = await fetchPlaidSyncStatus();
      if (status?.running) {
        setPlaidSyncOverlayVisible(true);
        setPlaidSyncFeedback('Bank data sync is already running…');
        return;
      }
      await runPlaidSyncTrigger(true);
      const statusAfter = await fetchPlaidSyncStatus();
      if (statusAfter?.running) {
        setPlaidSyncOverlayVisible(true);
      }
    } catch (error) {
      console.warn('[plaid] Manual refresh failed', error);
      setPlaidSyncFeedback('Could not refresh bank data. Try again in a moment.');
    } finally {
      setPlaidSyncRefreshing(false);
    }
  }, [
    plaidEnabled,
    plaidSyncRefreshing,
    plaidSyncOverlayVisible,
    fetchPlaidSyncStatus,
    runPlaidSyncTrigger
  ]);

  const refreshPlaidConsent = React.useCallback(() => {
    if (!plaidEnabled || !appState.auth.userId) {
      setPlaidConsentAccepted(false);
      setPlaidConsentRequiresReconsent(false);
      return;
    }
    authFetch(`${plaidBaseUrl}/api/privacy/consent-status`, { method: 'GET' })
      .then((res) => {
        setPlaidConsentAccepted(!!res?.accepted);
        setPlaidConsentRequiresReconsent(!!res?.requires_reconsent);
        if (res?.policy_version) setPlaidConsentVersion(res.policy_version);
      })
      .catch((err) => {
        console.warn('[privacy] Failed to load consent status', err);
        setPlaidConsentAccepted(false);
        setPlaidConsentRequiresReconsent(false);
      });
  }, [plaidEnabled, plaidBaseUrl, appState.auth.userId]);

  React.useEffect(() => {
    if (!plaidEnabled) {
      hasPlaidAccountsFetchedRef.current = false;
      setLinkToken(null);
      setPlaidSyncOverlayVisible(false);
      setPlaidSyncStatus(null);
      setPlaidSyncFeedback(null);
      setAccounts(loadMockAccountsOnly());
      return;
    }
    if (!appState.auth.userId) {
      hasPlaidAccountsFetchedRef.current = false;
      setPlaidSyncOverlayVisible(false);
      setPlaidSyncStatus(null);
      setPlaidSyncFeedback(null);
      setAccounts(loadMockAccountsOnly());
      return;
    }
    let cancelled = false;
    const run = async () => {
      refetchPlaidAccounts();
      const status = await fetchPlaidSyncStatus();
      if (cancelled) return;
      if (status?.running) {
        setPlaidSyncOverlayVisible(true);
        return;
      }
      // Page visits are NOT user-initiated syncs: passing false keeps the server's
      // 15-minute outer gate and per-item freshness checks in force, so repeat visits
      // don't enqueue redundant Plaid sync jobs. Only the explicit "Refresh bank data"
      // button bypasses the gates (user_initiated: true).
      await runPlaidSyncTrigger(false, { quietSkips: true });
      if (cancelled) return;
      const statusAfterTrigger = await fetchPlaidSyncStatus();
      if (!cancelled && statusAfterTrigger?.running) {
        setPlaidSyncOverlayVisible(true);
      }
    };
    const delay = document.visibilityState === 'visible' ? 400 : 0;
    const t = delay
      ? setTimeout(() => {
        void run();
      }, delay)
      : (void run(), null);
    return () => {
      cancelled = true;
      if (t) clearTimeout(t);
    };
  }, [plaidEnabled, appState.auth.userId, refetchPlaidAccounts, fetchPlaidSyncStatus, runPlaidSyncTrigger]);

  // Refetch when tab becomes visible or window gains focus.
  React.useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      refetchPlaidAccounts();
      void fetchPlaidSyncStatus().then((status) => {
        if (status?.running) setPlaidSyncOverlayVisible(true);
      });
    };
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      refetchPlaidAccounts();
      void fetchPlaidSyncStatus().then((status) => {
        if (status?.running) setPlaidSyncOverlayVisible(true);
      });
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [refetchPlaidAccounts, fetchPlaidSyncStatus]);

  React.useEffect(() => {
    if (!plaidSyncOverlayVisible || !plaidEnabled || !appState.auth.userId) return;
    let cancelled = false;
    const poll = async () => {
      const status = await fetchPlaidSyncStatus();
      if (cancelled || !status) return;
      if (!status.running) {
        setPlaidSyncOverlayVisible(false);
        setPlaidSyncFeedback('Bank data updated.');
        refetchPlaidAccounts();
      }
    };
    const id = window.setInterval(() => {
      void poll();
    }, 2000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [plaidSyncOverlayVisible, plaidEnabled, appState.auth.userId, fetchPlaidSyncStatus, refetchPlaidAccounts]);

  const [plaidReady, setPlaidReady] = useState(false);
  const openRef = useRef<(source?: string) => void>(() => undefined);
  const pendingReconnectItemIdRef = useRef<string | null>(null);
  const linkIntentIdRef = useRef<string | null>(null);
  const pendingPlaidOpenSourceRef = useRef<string>('connect_button');
  const [openPendingForFreshToken, setOpenPendingForFreshToken] = useState(false);

  const createLinkIntentId = React.useCallback(() => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }, []);

  const trackPlaidTelemetry = React.useCallback(
    (payload: Record<string, unknown>) => {
      if (!plaidEnabled || !plaidBaseUrl) return;
      void authFetch(`${plaidBaseUrl}/api/plaid/link-telemetry`, {
        method: 'POST',
        body: JSON.stringify(payload)
      }).catch((err) => {
        console.warn('[plaid] Telemetry logging failed', err);
      });
    },
    [plaidBaseUrl, plaidEnabled]
  );

  const handlePlaidEvent = React.useCallback(
    (eventName: string, metadata: PlaidLinkEventMetadata) => {
      trackPlaidTelemetry({
        event_type: 'event',
        event_name: eventName,
        view_name: metadata?.view_name || null,
        institution_id: metadata?.institution_id || null,
        institution_name: metadata?.institution_name || null,
        link_session_id: metadata?.link_session_id || null,
        request_id: metadata?.request_id || null,
        link_intent_id: linkIntentIdRef.current,
        is_update_mode: !!pendingReconnectItemIdRef.current
      });
    },
    [trackPlaidTelemetry]
  );

  const handlePlaidExit = React.useCallback(
    (error: PlaidLinkExitError | null, metadata: PlaidLinkExitMetadata) => {
      const reason = error?.error_code || metadata?.status || 'user_exit';
      trackPlaidTelemetry({
        event_type: 'exit',
        reason,
        status: metadata?.status || null,
        exit_status: metadata?.status || null,
        institution_id: metadata?.institution_id || null,
        institution_name: metadata?.institution_name || null,
        link_session_id: metadata?.link_session_id || null,
        request_id: metadata?.request_id || null,
        error_code: error?.error_code || null,
        error_type: error?.error_type || null,
        error_message: error?.error_message || null,
        link_intent_id: linkIntentIdRef.current,
        is_update_mode: !!pendingReconnectItemIdRef.current
      });
      if (error?.error_code) {
        trackPlaidTelemetry({
          event_type: 'failure',
          reason: error.error_code,
          error_code: error.error_code,
          error_type: error.error_type || null,
          error_message: error.error_message || null,
          status: metadata?.status || null,
          institution_id: metadata?.institution_id || null,
          link_session_id: metadata?.link_session_id || null,
          link_intent_id: linkIntentIdRef.current,
          is_update_mode: !!pendingReconnectItemIdRef.current
        });
      }
    },
    [trackPlaidTelemetry]
  );

  const handlePlaidOpen = React.useCallback(
    (source: string) => {
      trackPlaidTelemetry({
        event_type: 'open_click',
        reason: source,
        link_intent_id: linkIntentIdRef.current,
        is_update_mode: !!pendingReconnectItemIdRef.current
      });
    },
    [trackPlaidTelemetry]
  );

  useEffect(() => {
    if (!openPendingForFreshToken) return;
    if (!plaidReady || !linkToken) return;
    linkIntentIdRef.current = createLinkIntentId();
    openRef.current(pendingPlaidOpenSourceRef.current || 'auto_open_fresh_token');
    setOpenPendingForFreshToken(false);
  }, [openPendingForFreshToken, plaidReady, linkToken, createLinkIntentId]);

  const launchUpdateModeForItem = React.useCallback(
    async (itemId: string, accountSelectionEnabled?: boolean) => {
      if (!plaidBaseUrl || !plaidEnabled) return;
      setPlaidActionLoading(true);
      try {
        const body: { update_item_id: string; account_selection_enabled?: boolean } = { update_item_id: itemId };
        if (accountSelectionEnabled === true) body.account_selection_enabled = true;
        const data = await authFetch(`${plaidBaseUrl}/api/plaid/create-link-token`, {
          method: 'POST',
          body: JSON.stringify(body)
        });
        setLinkToken(data.link_token);
        pendingPlaidOpenSourceRef.current = 'update_mode';
        pendingReconnectItemIdRef.current = itemId;
        setOpenPendingForFreshToken(true);
      } catch (err) {
        console.warn('[plaid] Failed to launch update mode', err);
      } finally {
        setPlaidActionLoading(false);
      }
    },
    [plaidBaseUrl, plaidEnabled]
  );

  const launchStandardLink = React.useCallback(
    async (source: string, reconnectItemId: string | null = null) => {
      if (!plaidBaseUrl || !plaidEnabled) return;
      setPlaidActionLoading(true);
      try {
        const data = await authFetch(`${plaidBaseUrl}/api/plaid/create-link-token`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        setLinkToken(data?.link_token || null);
        pendingReconnectItemIdRef.current = reconnectItemId;
        pendingPlaidOpenSourceRef.current = source || 'connect_button';
        setOpenPendingForFreshToken(true);
      } catch (err) {
        console.warn('[plaid] Failed to create link token', err);
        const apiError = parseApiError(err);
        if (apiError?.code === 'PLAID_ITEM_CAP_REACHED' || apiError?.code === 'PLAID_ITEM_SAFETY_CEILING') {
          setPlaidLinkMessage(apiError.error || 'You have reached your connection limit.');
        }
      } finally {
        setPlaidActionLoading(false);
      }
    },
    [plaidBaseUrl, plaidEnabled]
  );

  const refreshMfaStatus = React.useCallback(async () => {
    if (!plaidEnabled || !appState.auth.userId) return;
    setMfaStatusLoading(true);
    try {
      const status = await getMfaStatus();
      setMfaStatus(status);
    } catch (err) {
      console.warn('[mfa] Failed to load MFA status', err);
      setMfaStatus(null);
    } finally {
      setMfaStatusLoading(false);
    }
  }, [plaidEnabled, appState.auth.userId]);

  useEffect(() => {
    refreshMfaStatus();
  }, [refreshMfaStatus]);

  useEffect(() => {
    refreshPlaidConsent();
  }, [refreshPlaidConsent]);

  useEffect(() => {
    const nextPlan = applyConnectedBalancesToPlan(planState, accounts);
    if (nextPlan) {
      dispatch({ type: 'hydrate', plan: nextPlan });
    }
  }, [accounts, dispatch, planState]);

  // When connected accounts are removed (e.g. Plaid item removed), revert plan entities that
  // still reference those accounts. Only run after Plaid accounts have been fetched at least
  // once; otherwise we'd clear all links on mount when accounts is still mock-only.
  useEffect(() => {
    if (!hasPlaidAccountsFetchedRef.current) return;
    const reverted = revertStalePlanLinks(planState, accounts);
    if (reverted) {
      dispatch({ type: 'hydrate', plan: reverted });
    }
  }, [accounts, dispatch, planState]);

  const handlePlaidSuccess = React.useCallback(
    async (publicToken: string, metadata: PlaidSuccessMetadata) => {
      setPlaidActionLoading(true);
      setPlaidLinkMessage(null);
      try {
        const applyAccountMapping = (mapping: Record<string, string>) => {
          const nextPlan = JSON.parse(JSON.stringify(planState));
          for (const altName of Object.keys(nextPlan.alternatives || {})) {
            const alt = nextPlan.alternatives[altName];
            for (const entityType of ['income', 'expense', 'asset', 'debt'] as const) {
              const entities = alt[entityType] || [];
              for (const entity of entities) {
                if (entity.connectedAccountId && mapping[entity.connectedAccountId]) {
                  entity.connectedAccountId = mapping[entity.connectedAccountId];
                }
              }
            }
          }
          dispatch({ type: 'hydrate', plan: nextPlan });
        };

        const intentId = linkIntentIdRef.current || createLinkIntentId();
        linkIntentIdRef.current = intentId;
        const reconnectItemId = pendingReconnectItemIdRef.current;
        const linkSuccessMetadata = {
          institution_id: metadata?.institution?.institution_id || undefined,
          institution_name: metadata?.institution?.name || undefined,
          link_session_id: metadata?.link_session_id || undefined,
          accounts: Array.isArray(metadata?.accounts)
            ? metadata.accounts
                .map((account) => ({
                  name: account?.name || undefined,
                  mask: account?.mask || undefined,
                  type: account?.type || undefined,
                  subtype: account?.subtype || undefined
                }))
                .filter((account) => account.name || account.mask || account.type || account.subtype)
            : undefined
        };

        let res = await authFetch(`${plaidBaseUrl}/api/plaid/exchange-token`, {
          method: 'POST',
          body: JSON.stringify({
            public_token: publicToken,
            link_intent_id: intentId,
            reconnect_item_id: reconnectItemId || undefined,
            link_success_metadata: linkSuccessMetadata
          })
        });
        if (res?.status === 'in_progress') {
          for (let i = 0; i < 10; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            const poll = await authFetch(`${plaidBaseUrl}/api/plaid/link-intents/${encodeURIComponent(intentId)}`, {
              method: 'GET'
            });
            if (poll?.status === 'completed' && poll?.result) {
              res = poll.result;
              break;
            }
            if (poll?.status === 'failed') {
              throw new Error(poll?.error_message || 'Plaid link intent failed');
            }
          }
        }
        const exchangeMapping = res?.account_id_mapping as Record<string, string> | undefined;
        if (res?.duplicate_item) {
          const institutionName = metadata?.institution?.name || 'This institution';
          setPlaidLinkMessage(`${institutionName} is already linked. No duplicate connection was added.`);
          trackPlaidTelemetry({
            event_type: 'success',
            reason: 'duplicate_blocked',
            institution_id: metadata?.institution?.institution_id || null,
            institution_name: metadata?.institution?.name || null,
            link_session_id: metadata?.link_session_id || null,
            link_intent_id: intentId,
            duplicate_item: true,
            item_id: res?.duplicate_item_id || null,
            is_update_mode: !!reconnectItemId
          });
          await refetchPlaidAccounts();
          linkIntentIdRef.current = null;
          pendingReconnectItemIdRef.current = null;
          return;
        }
        if (exchangeMapping && typeof exchangeMapping === 'object' && Object.keys(exchangeMapping).length > 0) {
          applyAccountMapping(exchangeMapping);
        }
        const newItemId = res?.item_id as string | undefined;
        const oldItemId = reconnectItemId;
        await refetchPlaidAccounts();
        pendingReconnectItemIdRef.current = null;
        trackPlaidTelemetry({
          event_type: 'success',
          reason: oldItemId ? 'reconnect_in_place' : 'exchange_success',
          institution_id: metadata?.institution?.institution_id || null,
          institution_name: metadata?.institution?.name || null,
          link_session_id: metadata?.link_session_id || null,
          link_intent_id: intentId,
          item_id: newItemId || null,
          duplicate_item: false,
          is_update_mode: !!oldItemId
        });
        linkIntentIdRef.current = null;
      } catch (error) {
        console.warn('[plaid] Link failed', error);
        const apiError = parseApiError(error);
        if (apiError?.code === 'PLAID_CONNECTION_STABILITY_LIMIT') {
          const retryDate = apiError.retry_after_date ? ` on ${apiError.retry_after_date}` : '';
          setPlaidLinkMessage(`Connection Stability Policy: you can add another connection${retryDate}.`);
        } else if (apiError?.error) {
          setPlaidLinkMessage(apiError.error);
        }
        trackPlaidTelemetry({
          event_type: 'failure',
          reason: 'exchange_token_failed',
          institution_id: metadata?.institution?.institution_id || null,
          institution_name: metadata?.institution?.name || null,
          link_session_id: metadata?.link_session_id || null,
          link_intent_id: linkIntentIdRef.current,
          error_message: error instanceof Error ? error.message : String(error || 'unknown_error'),
          is_update_mode: !!pendingReconnectItemIdRef.current
        });
      } finally {
        setPlaidActionLoading(false);
      }
    },
    [plaidBaseUrl, planState, dispatch, createLinkIntentId, trackPlaidTelemetry, refetchPlaidAccounts]
  );

  const addAccount = () => {
    setPlaidLinkMessage(null);
    if (plaidEnabled && (!plaidConsentAccepted || plaidConsentRequiresReconsent)) {
      setShowConsentModal(true);
      return;
    }
    if (plaidEnabled && !mfaStatusLoading) {
      const hasVerified = !!mfaStatus?.hasVerifiedFactor;
      const hasStepUp = hasFreshPlaidStepUp(appState.auth.userId);
      const shouldRecommend = !hasVerified || !hasStepUp;
      if (shouldRecommend && shouldShowMfaRecommendation(appState.auth.userId)) {
        setMfaError(null);
        setMfaCode('');
        setMfaChallengeId(null);
        setShowMfaGateModal(true);
        return;
      }
    }
    setShowConnectModal(true);
  };

  const acceptPlaidConsent = async () => {
    setConsentSaving(true);
    try {
      await authFetch(`${plaidBaseUrl}/api/privacy/consent`, {
        method: 'POST',
        body: JSON.stringify({
          consent_type: 'plaid_data_processing',
          policy_version: plaidConsentVersion,
          accepted: true
        })
      });
      setPlaidConsentAccepted(true);
      setPlaidConsentRequiresReconsent(false);
      setShowConsentModal(false);
      setShowConnectModal(true);
    } catch (err) {
      console.warn('[privacy] Failed to save consent', err);
    } finally {
      setConsentSaving(false);
    }
  };

  const handleConnectPlaid = async () => {
    setShowConnectModal(false);
    if (plaidEnabled) {
      pendingReconnectItemIdRef.current = null;
      await launchStandardLink('connect_button', null);
    }
  };

  const startMfaChallenge = async () => {
    if (!mfaStatus?.verifiedFactors?.length) return;
    setMfaError(null);
    try {
      const factor = mfaStatus.verifiedFactors[0];
      const challenge = await challengeFactor(factor.id);
      setMfaChallengeId(challenge.id);
    } catch (err) {
      console.warn('[mfa] Failed to start challenge', err);
      setMfaError('Unable to start MFA challenge. Try again.');
    }
  };

  const verifyMfaAndContinue = async () => {
    if (!mfaStatus?.verifiedFactors?.length) return;
    if (!mfaChallengeId) {
      await startMfaChallenge();
      return;
    }
    setMfaError(null);
    try {
      const factor = mfaStatus.verifiedFactors[0];
      await verifyChallenge(factor.id, mfaChallengeId, mfaCode.trim());
      markPlaidStepUpVerified(appState.auth.userId);
      setMfaChallengeId(null);
      setMfaCode('');
      setShowMfaGateModal(false);
      setShowConnectModal(true);
    } catch (err) {
      console.warn('[mfa] MFA verification failed', err);
      setMfaError('Invalid MFA code. Please try again.');
    }
  };

  const continueWithoutMfa = () => {
    dismissMfaRecommendation(appState.auth.userId);
    setMfaError(null);
    setMfaCode('');
    setMfaChallengeId(null);
    setShowMfaGateModal(false);
    setShowConnectModal(true);
  };

  const handleConnectMock = () => {
    setShowConnectModal(false);
    setShowMockModal(true);
  };

  const [mockAccountName, setMockAccountName] = useState('Mock Checking Account');
  const [mockAccountType, setMockAccountType] = useState('checking');
  const [mockInitialBalance, setMockInitialBalance] = useState(1000);

  const handleCreateMockAccount = () => {
    const name = mockAccountName.trim();
    if (!name) return;
    const result = connectMockAccount({
      accountName: name,
      accountType: mockAccountType,
      initialBalance: mockInitialBalance
    });
    const newAccount: ConnectedAccount = {
      ...result.account,
      accountId: result.accountId,
      balance: mockInitialBalance,
      currencyCode: 'USD'
    };
    setAccounts((prev) => {
      const next = [...prev, newAccount];
      saveConnectedAccounts(next.filter((a) => a.provider === 'mock'));
      return next;
    });
    setShowMockModal(false);
  };

  const removePlaidItem = async (itemId: string) => {
    setPendingRemoveItemId(null);
    setPlaidActionLoading(true);
    try {
      await authFetch(`${plaidBaseUrl}/api/plaid/remove-item`, {
        method: 'POST',
        body: JSON.stringify({ item_id: itemId })
      });
      await refetchPlaidAccounts();
    } catch (err) {
      console.warn('[plaid] Remove item failed', err);
    } finally {
      setPlaidActionLoading(false);
    }
  };

  const removePlaidAccount = async (plaidAccountId: string) => {
    setPlaidActionLoading(true);
    try {
      await authFetch(`${plaidBaseUrl}/api/plaid/remove-account`, {
        method: 'POST',
        body: JSON.stringify({ plaid_account_id: plaidAccountId })
      });
      await refetchPlaidAccounts();
    } catch (err) {
      console.warn('[plaid] Remove account failed', err);
    } finally {
      setPlaidActionLoading(false);
    }
  };

  const removeAccount = async (account: ConnectedAccount) => {
    const accountId = account.accountId || account.id;
    if (account.provider === 'plaid' && account.itemId) {
      if (account.connectionStatus === 'disconnected') {
        await removePlaidItem(account.itemId);
        return;
      }
      setPlaidActionLoading(true);
      try {
        await authFetch(`${plaidBaseUrl}/api/plaid/disconnect`, {
          method: 'POST',
          body: JSON.stringify({ item_id: account.itemId })
        });
        await refetchPlaidAccounts();
      } catch (err) {
        console.warn('[plaid] Disconnect failed', err);
      } finally {
        setPlaidActionLoading(false);
      }
      return;
    }
    if (account.provider === 'mock') {
      disconnectMockAccount(accountId);
    }
    // Unlink all plan entities that reference this account before removing (mock only)
    if (activeAlt) {
      const nextPlan = JSON.parse(JSON.stringify(planState));
      for (const altName of Object.keys(nextPlan.alternatives)) {
        const alt = nextPlan.alternatives[altName];
        for (const entityType of ['income', 'expense', 'asset', 'debt'] as const) {
          const entities = alt[entityType] || [];
          for (const entity of entities) {
            if (entity.connectedAccountId === accountId) {
              if (entity.manualValue !== null && entity.manualValue !== undefined) {
                if (entityType === 'debt') entity.bal = entity.manualValue;
                if (entityType === 'asset') entity.value = entity.manualValue;
                if (entityType === 'income' || entityType === 'expense') entity.amount = entity.manualValue;
              }
              entity.dataSource = 'manual';
              entity.overrideActive = false;
              entity.autoValue = null;
              entity.connectedAccountId = null;
              entity.lastSyncedAt = null;
              entity.lastOverriddenAt = null;
            }
          }
        }
      }
      dispatch({ type: 'hydrate', plan: nextPlan });
    }
    setAccounts((prev) => {
      const next = prev.filter((a) => (a.accountId || a.id) !== accountId);
      saveConnectedAccounts(next.filter((a) => a.provider === 'mock'));
      return next;
    });
  };

  const activeAlt = planState.alternatives[planState.activeAlt];

  const linkedEntities = useMemo(() => {
    if (!activeAlt) return [];
    const links: Array<{ entityType: 'income' | 'expense' | 'asset' | 'debt'; entityId: string; accountId: string }> = [];
    (['income', 'expense', 'asset', 'debt'] as const).forEach((type) => {
      activeAlt[type].forEach((entity) => {
        if (entity.connectedAccountId) {
          links.push({ entityType: type, entityId: entity.uuid, accountId: entity.connectedAccountId });
        }
      });
    });
    return links;
  }, [activeAlt]);

  const filteredAccounts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return accounts.filter((account) => {
      const matchesSearch =
        !term ||
        account.name.toLowerCase().includes(term) ||
        account.institution.toLowerCase().includes(term);
      if (!matchesSearch) return false;
      if (filterType !== 'all' && filterType !== 'account') return false;

      const link = linkedEntities.find((l) => l.accountId === (account.accountId || account.id));
      const status = link
        ? (() => {
            const entity = activeAlt?.[link.entityType].find((e) => e.uuid === link.entityId);
            return entity?.overrideActive ? 'overridden' : 'connected';
          })()
        : 'unconnected';

      if (filterStatus !== 'all' && status !== filterStatus) return false;
      return true;
    });
  }, [accounts, activeAlt, filterStatus, filterType, linkedEntities, search]);

  const accountsByInstitution = useMemo(() => {
    const plaidByItem = new Map<
      string,
      {
        institution: string;
        connected: boolean;
        itemStatus?: string;
        needsUpdateMode?: boolean;
        lastWebhookCode?: string | null;
        accounts: ConnectedAccount[];
      }
    >();
    const mockAccounts: ConnectedAccount[] = [];
    for (const account of filteredAccounts) {
      if (account.provider === 'mock') {
        mockAccounts.push(account);
        continue;
      }
      const itemId = account.itemId || account.institution || 'unknown';
      if (!plaidByItem.has(itemId)) {
        plaidByItem.set(itemId, {
          institution: account.institution || itemId,
          connected: false,
          itemStatus: account.itemStatus,
          needsUpdateMode: account.needsUpdateMode,
          lastWebhookCode: account.lastWebhookCode,
          accounts: []
        });
      }
      const g = plaidByItem.get(itemId)!;
      g.accounts.push(account);
      if (!g.itemStatus && account.itemStatus) g.itemStatus = account.itemStatus;
      if (!g.needsUpdateMode && account.needsUpdateMode) g.needsUpdateMode = true;
      if (account.lastWebhookCode != null) g.lastWebhookCode = account.lastWebhookCode;
      if (account.connectionStatus === 'connected' || account.connectionStatus === 'stale') g.connected = true;
    }
    return {
      plaidGroups: Array.from(plaidByItem.entries()).map(([itemId, g]) => ({ itemId, ...g })),
      mockAccounts
    };
  }, [filteredAccounts]);

  const plaidSyncSummary = useMemo(() => {
    if (!plaidEnabled) return null;
    const plaidAccounts = accounts.filter((account) => account.provider === 'plaid');
    const syncItems = Array.isArray(plaidSyncStatus?.items) ? plaidSyncStatus.items : [];
    const running = plaidSyncOverlayVisible || !!plaidSyncStatus?.running;
    const anyNeedsUpdate = plaidAccounts.some((account) => account.needsUpdateMode);
    const anyDisconnected = plaidAccounts.some((account) => account.connectionStatus === 'disconnected');
    const anyStale = plaidAccounts.some((account) => account.connectionStatus === 'stale');
    const latestAccountSyncMs = plaidAccounts
      .map((account) => (account.lastSyncIso ? new Date(account.lastSyncIso).getTime() : NaN))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];
    const latestItemSyncMs = syncItems
      .map((item) => (item.last_sync_finished_at ? new Date(item.last_sync_finished_at).getTime() : NaN))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0];
    const latestSyncMs = Number.isFinite(latestItemSyncMs)
      ? latestItemSyncMs
      : Number.isFinite(latestAccountSyncMs)
        ? latestAccountSyncMs
        : NaN;
    const nextEligibleMs = syncItems
      .map((item) => (item.next_eligible_at ? new Date(item.next_eligible_at).getTime() : NaN))
      .filter((value) => Number.isFinite(value) && value > Date.now())
      .sort((a, b) => a - b)[0];
    const latestSyncLabel = formatDateTimeLabel(Number.isFinite(latestSyncMs) ? new Date(latestSyncMs).toISOString() : null);
    const nextCheckLabel = formatRelativeFutureLabel(Number.isFinite(nextEligibleMs) ? new Date(nextEligibleMs).toISOString() : null);

    let stateLabel = 'No linked institutions';
    if (running) {
      stateLabel = 'Syncing now';
    } else if (anyNeedsUpdate) {
      stateLabel = 'Action required';
    } else if (anyDisconnected) {
      stateLabel = 'Disconnected';
    } else if (plaidAccounts.length > 0 && anyStale) {
      stateLabel = 'Out of date';
    } else if (plaidAccounts.length > 0) {
      stateLabel = 'Up to date';
    }

    return {
      stateLabel,
      latestSyncLabel,
      nextCheckLabel
    };
  }, [plaidEnabled, accounts, plaidSyncStatus, plaidSyncOverlayVisible]);

  const plaidSyncStateClassName = useMemo(() => {
    const state = plaidSyncSummary?.stateLabel;
    if (!state) return 'border-slate-700 bg-slate-900/70 text-slate-200';
    if (state === 'Syncing now') return 'border-cyan-600/50 bg-cyan-500/15 text-cyan-200';
    if (state === 'Up to date') return 'border-emerald-600/40 bg-emerald-500/10 text-emerald-200';
    if (state === 'Out of date') return 'border-amber-600/40 bg-amber-500/10 text-amber-200';
    if (state === 'Action required') return 'border-amber-600/50 bg-amber-500/15 text-amber-200';
    if (state === 'Disconnected') return 'border-slate-600/60 bg-slate-700/30 text-slate-200';
    return 'border-slate-700 bg-slate-900/70 text-slate-200';
  }, [plaidSyncSummary?.stateLabel]);

  const plaidItemIds = useMemo(
    () => accountsByInstitution.plaidGroups.map((g) => g.itemId),
    [accountsByInstitution.plaidGroups]
  );
  useEffect(() => {
    if (typeof window === 'undefined' || plaidItemIds.length === 0) return;
    const init: Record<string, boolean> = {};
    plaidItemIds.forEach((itemId) => {
      const stored = getScopedLocalStorageItem(`${COLLAPSE_ITEM_PREFIX}${itemId}`);
      if (stored !== null) init[itemId] = stored === 'true';
    });
    if (Object.keys(init).length > 0) setCollapsedPlaidItems((prev) => ({ ...prev, ...init }));
  }, [plaidItemIds.join(',')]);

  const filteredNodes = useMemo(() => {
    if (!activeAlt) return { income: [], expense: [], asset: [], debt: [] };
    const term = search.trim().toLowerCase();
    const applyFilter = (items: any[]) =>
      items.filter((row) => !term || (row.name || '').toLowerCase().includes(term));
    return {
      income: filterType === 'all' || filterType === 'income' ? applyFilter(activeAlt.income) : [],
      expense: filterType === 'all' || filterType === 'expense' ? applyFilter(activeAlt.expense) : [],
      asset: filterType === 'all' || filterType === 'asset' ? applyFilter(activeAlt.asset) : [],
      debt: filterType === 'all' || filterType === 'debt' ? applyFilter(activeAlt.debt) : []
    };
  }, [activeAlt, filterType, search]);

  const linkAccountToEntity = (accountId: string, entityType: 'income' | 'expense' | 'asset' | 'debt', entityId: string) => {
    if (!activeAlt) return;
    const nextPlan = JSON.parse(JSON.stringify(planState));
    const entity = nextPlan.alternatives[nextPlan.activeAlt][entityType].find((row: any) => row.uuid === entityId);
    if (!entity) return;
    const linkedAccount = accounts.find((a) => (a.accountId || a.id) === accountId);
    const manualValue =
      entityType === 'debt'
        ? entity.bal || 0
        : entityType === 'asset'
        ? entity.value || 0
        : entity.amount || 0;
    const connectedValue = linkedAccount && typeof linkedAccount.balance === 'number'
      ? linkedAccount.balance
      : manualValue;
    entity.dataSource = 'connected';
    entity.connectedAccountId = accountId;
    entity.manualValue = manualValue;
    entity.overrideActive = false;
    entity.autoValue = connectedValue;
    entity.lastSyncedAt = new Date().toISOString();
    if (entityType === 'debt') entity.bal = getEffectiveValue(entity);
    if (entityType === 'asset') entity.value = getEffectiveValue(entity);
    if (entityType === 'income' || entityType === 'expense') entity.amount = getEffectiveValue(entity);
    dispatch({ type: 'hydrate', plan: nextPlan });
  };

  const removeAccountFromSheet = (plaidAccountId: string) => {
    if (!activeAlt) return;
    const nextPlan = JSON.parse(JSON.stringify(planState));
    const alt = nextPlan.alternatives[nextPlan.activeAlt];
    for (const entityType of ['income', 'expense', 'asset', 'debt'] as const) {
      const entities = alt[entityType] || [];
      for (const entity of entities) {
        if (entity.connectedAccountId === plaidAccountId) {
          if (entity.manualValue != null && entity.manualValue !== undefined) {
            if (entityType === 'debt') entity.bal = entity.manualValue;
            if (entityType === 'asset') entity.value = entity.manualValue;
            if (entityType === 'income' || entityType === 'expense') entity.amount = entity.manualValue;
          }
          entity.dataSource = 'manual';
          entity.overrideActive = false;
          entity.autoValue = null;
          entity.connectedAccountId = null;
          entity.lastSyncedAt = null;
          entity.lastOverriddenAt = null;
        }
      }
    }
    dispatch({ type: 'hydrate', plan: nextPlan });
  };

  const unlinkAccount = (entityType: 'income' | 'expense' | 'asset' | 'debt', entityId: string) => {
    if (!activeAlt) return;
    const nextPlan = JSON.parse(JSON.stringify(planState));
    const entity = nextPlan.alternatives[nextPlan.activeAlt][entityType].find((row: any) => row.uuid === entityId);
    if (!entity) return;
    if (entity.manualValue !== null && entity.manualValue !== undefined) {
      if (entityType === 'debt') entity.bal = entity.manualValue;
      if (entityType === 'asset') entity.value = entity.manualValue;
      if (entityType === 'income' || entityType === 'expense') entity.amount = entity.manualValue;
    }
    entity.dataSource = 'manual';
    entity.overrideActive = false;
    entity.autoValue = null;
    entity.connectedAccountId = null;
    entity.lastSyncedAt = null;
    entity.lastOverriddenAt = null;
    dispatch({ type: 'hydrate', plan: nextPlan });
  };

  useEffect(() => {
    const updateLines = () => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const nextLines: Array<{ from: string; to: string; x1: number; y1: number; x2: number; y2: number }> = [];
      linkedEntities.forEach((link) => {
        const accountId = link.accountId;
        const account = accounts.find((a) => (a.accountId || a.id) === accountId);
        const itemId = account?.itemId;
        const isPlaidItemCollapsed = itemId ? collapsedPlaidItems[itemId] : false;
        const accountEl = accountRefs.current.get(accountId);
        const itemHeaderEl = itemId ? plaidItemHeaderRefs.current.get(itemId) : null;
        let x1: number;
        let y1: number;
        if (isPlaidItemCollapsed && itemHeaderEl) {
          const headerRect = itemHeaderEl.getBoundingClientRect();
          x1 = headerRect.right - containerRect.left;
          y1 = headerRect.top + headerRect.height / 2 - containerRect.top;
        } else if (accountEl) {
          const a = accountEl.getBoundingClientRect();
          x1 = a.right - containerRect.left;
          y1 = a.top + a.height / 2 - containerRect.top;
        } else return;
        const isCollapsed = collapsedSections[link.entityType];
        let x2: number;
        let y2: number;
        if (isCollapsed) {
          const headerEl = sectionHeaderRefs.current.get(link.entityType);
          if (!headerEl) return;
          const headerRect = headerEl.getBoundingClientRect();
          x2 = headerRect.left - containerRect.left;
          y2 = headerRect.top + headerRect.height / 2 - containerRect.top;
        } else {
          const nodeEl = nodeRefs.current.get(`${link.entityType}:${link.entityId}`);
          if (!nodeEl) return;
          const nodeRect = nodeEl.getBoundingClientRect();
          x2 = nodeRect.left - containerRect.left;
          y2 = nodeRect.top + nodeRect.height / 2 - containerRect.top;
        }
        nextLines.push({
          from: accountId,
          to: `${link.entityType}:${link.entityId}`,
          x1,
          y1,
          x2,
          y2
        });
      });
      setLines(nextLines);
    };
    updateLines();
    window.addEventListener('resize', updateLines);
    return () => window.removeEventListener('resize', updateLines);
  }, [linkedEntities, accounts, search, collapsedSections, collapsedPlaidItems]);

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-200">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        {plaidEnabled && linkToken ? (
          <PlaidBridge
            token={linkToken}
            onSuccess={handlePlaidSuccess}
            onEvent={handlePlaidEvent}
            onExit={handlePlaidExit}
            onOpen={handlePlaidOpen}
            openRef={openRef}
            onReadyChange={setPlaidReady}
          />
        ) : null}
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h1 className="text-2xl font-semibold text-slate-100">Account Integration</h1>
          {plaidLinkMessage ? (
            <p className="mt-3 rounded border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
              {plaidLinkMessage}
            </p>
          ) : null}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
              placeholder="Search accounts or nodes..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
              value={filterType}
              onChange={(event) => setFilterType(event.target.value as any)}
            >
              <option value="all">All Types</option>
              <option value="account">Accounts</option>
              <option value="income">Income</option>
              <option value="expense">Expense</option>
              <option value="debt">Debt</option>
              <option value="asset">Asset</option>
            </select>
            <select
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
              value={filterStatus}
              onChange={(event) => setFilterStatus(event.target.value as any)}
            >
              <option value="all">All Status</option>
              <option value="connected">Connected</option>
              <option value="unconnected">Unconnected</option>
              <option value="overridden">Overridden</option>
            </select>
            <button
              className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200"
              type="button"
              onClick={() => setShowDrawer(true)}
            >
              Manage Overrides
            </button>
          </div>
        </div>

        <div ref={containerRef} className="relative rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            {lines.map((line) => (
              <path
                key={`${line.from}-${line.to}`}
                d={`M ${line.x1} ${line.y1} C ${line.x1 + 80} ${line.y1}, ${line.x2 - 80} ${line.y2}, ${line.x2} ${line.y2}`}
                stroke="var(--accent)"
                strokeOpacity={0.7}
                strokeWidth={2}
                fill="none"
              />
            ))}
          </svg>
          {plaidEnabled ? (
            <div className="mb-4 rounded-lg border border-slate-700/70 bg-slate-950/70 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-medium text-slate-300">Plaid sync</span>
                <span className={`rounded border px-2 py-0.5 font-medium ${plaidSyncStateClassName}`}>
                  {plaidSyncSummary?.stateLabel || 'Checking...'}
                </span>
                {plaidSyncSummary?.latestSyncLabel ? (
                  <span className="text-slate-400">Last Sync Attempt: {plaidSyncSummary.latestSyncLabel}</span>
                ) : null}
                {plaidSyncSummary?.nextCheckLabel ? (
                  <span className="text-slate-500">Next check {plaidSyncSummary.nextCheckLabel}</span>
                ) : null}
                <button
                  type="button"
                  className="ml-auto rounded border border-cyan-600/50 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={plaidSyncRefreshing || plaidSyncOverlayVisible || plaidActionLoading}
                  onClick={() => void handleRefreshPlaidData()}
                >
                  {plaidSyncRefreshing || plaidSyncOverlayVisible ? 'Refreshing…' : 'Refresh bank data'}
                </button>
              </div>
              {plaidSyncFeedback ? (
                <p className="mt-1.5 text-[11px] text-slate-400">{plaidSyncFeedback}</p>
              ) : null}
              <p className="mt-1 text-[11px] text-slate-500">Auto-updates in background when Plaid webhooks are configured.</p>
              <div className="mt-2.5">
                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 mb-1">
                  <span>{plaidItemCount} of {plaidItemCap} Plaid connections (TMM+ Base)</span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${plaidItemCount >= plaidItemCap && plaidItemCap > 0 ? 'bg-amber-500' : plaidItemCount >= plaidItemCap - 1 && plaidItemCap > 1 ? 'bg-amber-500/80' : 'bg-slate-500'}`}
                    style={{ width: `${plaidItemCap > 0 ? Math.min(100, (100 * plaidItemCount) / plaidItemCap) : 0}%` }}
                    role="progressbar"
                    aria-valuenow={plaidItemCount}
                    aria-valuemin={0}
                    aria-valuemax={plaidItemCap}
                    aria-label={`${plaidItemCount} of ${plaidItemCap} Plaid connections used`}
                  />
                </div>
                {(plaidItemCount >= plaidItemCap && plaidItemCap > 0) ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
                    <span className="text-amber-400 font-medium">Connection limit reached.</span>
                    <button
                      type="button"
                      className="text-cyan-400 hover:text-cyan-300 underline underline-offset-1"
                      onClick={() => navigateToRoute('settings')}
                    >
                      Upgrade to add more slots
                    </button>
                  </div>
                ) : (plaidItemCount >= plaidItemCap - 1 && plaidItemCap > 1) ? (
                  <div className="mt-1.5 text-[11px] text-amber-300/90">
                    Connection limit almost reached. Disconnect an institution to add another, or upgrade for more slots.
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="grid gap-6 md:grid-cols-[1fr_2fr_1fr]">
            <div aria-busy={plaidActionLoading}>
              <div>
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">Connected Financial Accounts</h2>
                </div>
              </div>
              {plaidActionLoading && (
                <p className="mt-2 text-[11px] text-slate-500">Updating…</p>
              )}
              <div className="mt-4 space-y-4">
                {filteredAccounts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/40 p-6 text-center text-xs text-slate-400">
                    No connected accounts yet.
                  </div>
                ) : (
                  <>
                    {accountsByInstitution.plaidGroups.map((group) => {
                      const isItemCollapsed = collapsedPlaidItems[group.itemId];
                      const itemNeedsUpdate = !!group.needsUpdateMode;
                      const groupHasStaleAccounts = group.accounts.some((account) => account.connectionStatus === 'stale');
                      const showReconnectButton = !group.connected || itemNeedsUpdate;
                      const showConnectionLostBadge = !group.connected;
                      const showActionRequiredBadge = itemNeedsUpdate;
                      const showOutOfDateBadge = group.connected && !itemNeedsUpdate && groupHasStaleAccounts;
                      return (
                      <div key={group.itemId} className="space-y-2">
                        <div
                          ref={(el) => {
                            if (el) plaidItemHeaderRefs.current.set(group.itemId, el);
                          }}
                          role="button"
                          tabIndex={0}
                          className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 cursor-pointer rounded px-1 py-0.5 -mx-1 hover:bg-slate-800/40"
                          onClick={() => togglePlaidItem(group.itemId)}
                          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), togglePlaidItem(group.itemId))}
                        >
                          <span className={`transition-transform ${isItemCollapsed ? '-rotate-90' : ''}`}>▼</span>
                          <span className="font-medium text-slate-300">{group.institution}</span>
                          {isItemCollapsed && (
                            <span className="text-slate-500">{group.accounts.length} account{group.accounts.length !== 1 ? 's' : ''}</span>
                          )}
                          {group.connected && (
                            <button
                              className="rounded border border-slate-600 px-1.5 py-0.5 text-slate-300 hover:bg-slate-700/50 disabled:opacity-50"
                              type="button"
                              disabled={plaidActionLoading}
                              onClick={(e) => { e.stopPropagation(); (async () => {
                                const first = group.accounts[0];
                                if (first?.itemId) {
                                  setPlaidActionLoading(true);
                                  try {
                                    await authFetch(`${plaidBaseUrl}/api/plaid/disconnect`, {
                                      method: 'POST',
                                      body: JSON.stringify({ item_id: first.itemId })
                                    });
                                    await refetchPlaidAccounts();
                                  } catch (err) {
                                    console.warn('[plaid] Disconnect failed', err);
                                  } finally {
                                    setPlaidActionLoading(false);
                                  }
                                }
                              })(); }}
                            >
                              Disconnect from Plaid
                            </button>
                          )}
                          {showConnectionLostBadge && (
                            <>
                              <span className="rounded bg-slate-700/80 px-1.5 py-0.5 text-slate-500">
                                Disconnected
                              </span>
                              <button
                                type="button"
                                className="rounded p-0.5 text-slate-400 hover:bg-slate-700/50 hover:text-slate-300 disabled:opacity-50"
                                disabled={plaidActionLoading}
                                onClick={(e) => { e.stopPropagation(); setPendingRemoveItemId(group.itemId); }}
                                title="Remove this institution and all its accounts"
                                aria-label="Remove this institution and all its accounts"
                              >
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </>
                          )}
                          {showOutOfDateBadge && (
                            <span className="rounded bg-slate-700/80 px-1.5 py-0.5 text-slate-400">
                              Out of date
                            </span>
                          )}
                          {showActionRequiredBadge && (
                            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-200">
                              Action Required
                            </span>
                          )}
                          {showReconnectButton && plaidEnabled && (
                            <button
                              className="rounded border border-cyan-600/60 bg-cyan-500/20 px-1.5 py-0.5 text-cyan-300 hover:bg-cyan-500/30 disabled:opacity-50"
                              type="button"
                              disabled={plaidActionLoading || plaidSyncOverlayVisible}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (itemNeedsUpdate && group.connected) {
                                  const forNewAccounts = group.lastWebhookCode === 'NEW_ACCOUNTS_AVAILABLE';
                                  void launchUpdateModeForItem(group.itemId, forNewAccounts);
                                  return;
                                }
                                setShowConnectModal(false);
                                void launchStandardLink('reconnect_button', group.itemId);
                              }}
                            >
                              Reconnect
                            </button>
                          )}
                        </div>
                        {!isItemCollapsed && (
                        <div className="space-y-2 pl-0">
                          {group.accounts.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-500">
                              No accounts
                            </div>
                          ) : group.accounts.map((account) => {
                            const accountId = account.accountId || account.id;
                            return (
                              <div
                                key={account.id}
                                ref={(el) => {
                                  if (el) accountRefs.current.set(accountId, el);
                                }}
                                className={`rounded-lg border bg-slate-950 p-3 text-xs text-slate-200 ${account.connectionStatus === 'connected' ? 'border-slate-800' : 'border-slate-800/60 opacity-80'}`}
                                data-testid={`account-list-row-${accountId}`}
                                draggable={account.connectionStatus === 'connected'}
                                onDragStart={(event) => {
                                  if (account.connectionStatus !== 'connected') return;
                                  event.dataTransfer.setData('text/plain', accountId);
                                  event.dataTransfer.effectAllowed = 'move';
                                }}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold text-slate-100">{account.name}</span>
                                  {(account.connectionStatus === 'disconnected' || account.connectionStatus === 'stale' || account.needsUpdateMode) && (
                                    <span className="rounded bg-slate-700/80 px-1.5 py-0.5 text-[10px] text-slate-500" data-testid={`account-row-status-${accountId}`}>
                                      {account.needsUpdateMode
                                        ? 'Action Required'
                                        : account.connectionStatus === 'disconnected'
                                          ? 'Disconnected'
                                          : account.staleReason === 'locked'
                                            ? 'Syncing'
                                            : account.staleReason === 'cooldown'
                                              ? 'Waiting to retry'
                                              : account.staleReason === 'never_synced'
                                                ? 'Sync pending'
                                                : 'Out of date'}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-2 text-[11px] text-slate-500">
                                  Last sync: {account.lastSyncIso ? new Date(account.lastSyncIso).toLocaleString() : 'Never'}
                                </div>
                                <div className="mt-1 text-[11px] text-slate-400" data-testid={`account-row-balance-${accountId}`}>
                                  Balance: {formatCurrency(account.balance, account.currencyCode)}
                                </div>
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  {linkedEntities.some((l) => l.accountId === (account.accountId || account.id)) && (
                                    <button
                                      className="rounded-full border border-rose-400/70 px-2 py-0.5 text-[10px] text-rose-300 hover:bg-rose-500/10"
                                      type="button"
                                      aria-label="Unlink this account from TMM nodes"
                                      onClick={() => removeAccountFromSheet(account.accountId || account.id)}
                                    >
                                      Unlink
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="rounded p-0.5 text-slate-400 hover:bg-slate-700/50 hover:text-slate-300 disabled:opacity-50"
                                    disabled={plaidActionLoading}
                                    onClick={(e) => { e.stopPropagation(); removePlaidAccount(accountId); }}
                                    title="Remove this account from your list"
                                    aria-label="Remove this account from your list"
                                  >
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        )}
                      </div>
                    );
                    })}
                    {accountsByInstitution.mockAccounts.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-[11px] font-medium text-slate-400">Mock accounts</div>
                        <div className="space-y-2">
                          {accountsByInstitution.mockAccounts.map((account) => {
                            const accountId = account.accountId || account.id;
                            return (
                              <div
                                key={account.id}
                                ref={(el) => {
                                  if (el) accountRefs.current.set(accountId, el);
                                }}
                                className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-200"
                                draggable
                                onDragStart={(event) => {
                                  event.dataTransfer.setData('text/plain', accountId);
                                  event.dataTransfer.effectAllowed = 'move';
                                }}
                              >
                                <div className="font-semibold text-slate-100">{account.name}</div>
                                <div className="text-[11px] text-slate-400">{account.institution}</div>
                                <div className="mt-1 text-[11px] text-slate-400">
                                  Balance: {formatCurrency(account.balance, account.currencyCode)}
                                </div>
                                <div className="mt-2">
                                  <button
                                    className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
                                    type="button"
                                    onClick={() => removeAccount(account)}
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
              <button
                className="mt-4 w-full rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 disabled:opacity-50"
                type="button"
                onClick={addAccount}
                disabled={plaidActionLoading || plaidSyncOverlayVisible}
              >
                + Connect Account
              </button>
            </div>
            <div className="hidden md:block" />
            <div>
              <h2 className="text-sm font-semibold text-slate-200">TMM Nodes</h2>
              <div className="mt-4 space-y-3">
                {(['income', 'expense', 'asset', 'debt'] as const).map((type) => {
                  const isCollapsed = collapsedSections[type];
                  return (
                    <div key={type} className="rounded-lg border border-slate-800 bg-slate-950 text-xs text-slate-200">
                      <div
                        ref={(el) => {
                          if (el) sectionHeaderRefs.current.set(type, el);
                        }}
                        className="collapsible-section-header flex cursor-pointer items-center justify-between px-3 py-2"
                        onClick={() => toggleSection(type)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggleSection(type)}
                      >
                        <span className="font-semibold text-slate-100">{type.toUpperCase()}</span>
                        <span
                          className={`collapsible-section-toggle text-slate-400 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                        >
                          ▼
                        </span>
                      </div>
                      <div
                        className={`collapsible-section-content overflow-hidden transition-all ${isCollapsed ? 'max-h-0 opacity-0' : 'max-h-[2000px] opacity-100'}`}
                      >
                        <div className="space-y-1 px-3 pb-3 pt-0 text-[11px] text-slate-400">
                          {filteredNodes[type].map((row, rowIndex) => {
                            const effectiveValue = getEffectiveValue(row);
                            return (
                              <div
                                key={row.uuid || `${type}-${rowIndex}`}
                                ref={(el) => {
                                  if (el) nodeRefs.current.set(`${type}:${row.uuid || `${type}-${rowIndex}`}`, el);
                                }}
                                className="rounded border border-slate-800 px-2 py-1"
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={(event) => {
                                  const accountId = event.dataTransfer.getData('text/plain');
                                  if (!accountId) return;
                                  linkAccountToEntity(accountId, type, row.uuid || `${type}-${rowIndex}`);
                                }}
                              >
                                <div className="flex items-center justify-between">
                                  <span>
                                    {row.name || '(unnamed)'} <span className="text-slate-500">· {formatCurrency(effectiveValue)}</span>
                                  </span>
                                  {row.connectedAccountId ? (
                                    <button
                                      className="rounded-full border border-rose-400/70 px-2 py-0.5 text-[10px] text-rose-300 hover:bg-rose-500/10"
                                      type="button"
                                      aria-label="Unlink this node from connected account"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        unlinkAccount(type, row.uuid);
                                      }}
                                    >
                                      Unlink
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                          {filteredNodes[type].length === 0 ? <div className="text-slate-500">No items</div> : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {pendingRemoveItemId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-labelledby="remove-item-title">
          <div className="mx-4 w-full max-w-sm rounded-lg border border-slate-700 bg-slate-900 p-4 shadow-xl">
            <h2 id="remove-item-title" className="text-sm font-semibold text-slate-100">Are you sure?</h2>
            <p className="mt-2 text-xs text-slate-400">
              Remove this institution and all its accounts from the list? This cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                onClick={() => setPendingRemoveItemId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-md border border-rose-500/60 bg-rose-500/20 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/30"
                onClick={() => pendingRemoveItemId && removePlaidItem(pendingRemoveItemId)}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showDrawer ? (
        <div className="fixed inset-0 z-50 bg-black/50">
          <div className="absolute inset-y-0 right-0 w-full max-w-md border-l border-slate-800 bg-slate-950 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-200">Override Management</h2>
              <button className="text-xs text-slate-400" type="button" onClick={() => setShowDrawer(false)}>
                ✕
              </button>
            </div>
            <div className="mt-4 space-y-3 text-xs text-slate-300">
              {linkedEntities.length === 0 ? (
                <div className="text-slate-500">No linked accounts.</div>
              ) : (
                linkedEntities.map((link) => {
                  const entity = activeAlt?.[link.entityType].find((row) => row.uuid === link.entityId);
                  if (!entity) return null;
                  const effective = getEffectiveValue(entity as any);
                  return (
                    <div key={`${link.entityType}-${link.entityId}`} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
                      <div className="font-semibold text-slate-100">{entity.name || '(unnamed)'}</div>
                      <div className="text-[11px] text-slate-400">{link.entityType.toUpperCase()}</div>
                      <div className="mt-2 text-[11px] text-slate-400">
                        Auto: {entity.autoValue ?? '—'} · Manual: {entity.manualValue ?? '—'} · Effective: {effective}
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <input
                          className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                          type="number"
                          placeholder="Manual override"
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            const nextPlan = JSON.parse(JSON.stringify(planState));
                            const target = nextPlan.alternatives[nextPlan.activeAlt][link.entityType].find(
                              (row: any) => row.uuid === link.entityId
                            );
                            if (!target) return;
                            applyManualOverride(target, value);
                            dispatch({ type: 'hydrate', plan: nextPlan });
                          }}
                        />
                        <button
                          className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-200"
                          type="button"
                          onClick={() => {
                            const nextPlan = JSON.parse(JSON.stringify(planState));
                            const target = nextPlan.alternatives[nextPlan.activeAlt][link.entityType].find(
                              (row: any) => row.uuid === link.entityId
                            );
                            if (!target) return;
                            if (target.overrideActive) {
                              revertToConnected(target);
                            } else {
                              applyManualOverride(target, target.manualValue ?? 0);
                            }
                            dispatch({ type: 'hydrate', plan: nextPlan });
                          }}
                        >
                          {entity.overrideActive ? 'Revert' : 'Override'}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}

      {showConsentModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-950 p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-100">Plaid data consent required</h3>
            <div className="mt-3 space-y-2 text-sm text-slate-400">
              {plaidConsentRequiresReconsent ? (
                <p className="rounded border border-amber-700/50 bg-amber-900/20 px-2 py-1 text-amber-200">
                  Our privacy and retention policy has been updated. Please review and consent again to continue using
                  Plaid.
                </p>
              ) : null}
              <p>
                By continuing, you consent to TMM collecting and processing account and transaction data from Plaid
                to power account sync, projections, and reconciliation workflows.
              </p>
              <p>
                You can disconnect accounts anytime. Data retention and deletion are documented in the TMM privacy
                and retention policy.
              </p>
              <p className="text-xs">
                <button
                  type="button"
                  className="text-cyan-300 underline hover:text-cyan-200"
                  onClick={() => {
                    setShowConsentModal(false);
                    navigateToRoute('privacy');
                  }}
                >
                  View Privacy Policy
                </button>
                {' · '}
                <button
                  type="button"
                  className="text-cyan-300 underline hover:text-cyan-200"
                  onClick={() => {
                    setShowConsentModal(false);
                    window.history.pushState({}, '', '/privacy#data-retention');
                    dispatchNavigationEvent();
                  }}
                >
                  View Data Retention and Deletion Policy
                </button>
              </p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
                type="button"
                onClick={() => setShowConsentModal(false)}
              >
                Cancel
              </button>
              <button
                className="rounded-md border border-cyan-600/60 bg-cyan-500/20 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50"
                type="button"
                disabled={consentSaving}
                onClick={acceptPlaidConsent}
              >
                {consentSaving ? 'Saving...' : 'I consent and continue'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {plaidSyncOverlayVisible && !appState.plaid.syncRunning ? (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 backdrop-blur-sm"
          role="status"
          aria-live="polite"
          aria-label="Updating bank data"
        >
          <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-700/80 bg-slate-900/80 px-6 py-5">
            <AppSpinner />
            <p className="text-xs text-slate-200">Updating bank data…</p>
          </div>
        </div>
      ) : null}

      {showMfaGateModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-100">MFA strongly recommended for Plaid</h3>
            <p className="mt-3 text-sm text-slate-400">
              For account security, we strongly recommend MFA before connecting real bank accounts.
            </p>

            {mfaStatusLoading ? (
              <div className="mt-4 text-xs text-slate-400">Loading MFA status...</div>
            ) : !mfaStatus?.hasVerifiedFactor ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-md border border-amber-800/40 bg-amber-950/20 p-3 text-xs text-slate-300">
                  No verified MFA factor found on your account.
                </div>
                <div className="flex gap-2">
                  <button
                    className="flex-1 rounded-md border border-cyan-600/60 bg-cyan-500/20 px-3 py-2 text-sm text-cyan-200 hover:bg-cyan-500/30"
                    type="button"
                    onClick={() => {
                      setShowMfaGateModal(false);
                      navigateToRoute('settings');
                    }}
                  >
                    Enable MFA in Settings
                  </button>
                  <button
                    className="flex-1 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                    type="button"
                    onClick={continueWithoutMfa}
                  >
                    Continue without MFA
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="text-xs text-slate-400">
                  Enter the 6-digit code from your authenticator app to verify now, or skip for now.
                </div>
                <input
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  type="text"
                  inputMode="numeric"
                  maxLength={8}
                  placeholder="123456"
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                />
                {mfaError ? <div className="text-xs text-rose-300">{mfaError}</div> : null}
                <div className="flex gap-2">
                  <button
                    className="flex-1 rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
                    type="button"
                    onClick={startMfaChallenge}
                  >
                    {mfaChallengeId ? 'Restart challenge' : 'Start challenge'}
                  </button>
                  <button
                    className="flex-1 rounded-md border border-cyan-600/60 bg-cyan-500/20 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/30"
                    type="button"
                    onClick={verifyMfaAndContinue}
                  >
                    Verify and continue
                  </button>
                </div>
                <button
                  className="w-full rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
                  type="button"
                  onClick={continueWithoutMfa}
                >
                  Skip for now
                </button>
              </div>
            )}

            <div className="mt-4 flex justify-end">
              <button
                className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
                type="button"
                onClick={() => setShowMfaGateModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showConnectModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-100">Connect Account</h3>
            <p className="mt-3 text-sm text-slate-400">
              Choose how you want to connect your account.
            </p>
            <div className="mt-4 flex flex-col gap-3">
              {plaidEnabled ? (
                <>
                  <button
                    className="w-full rounded-md border border-slate-600 bg-slate-800 px-4 py-3 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50"
                    type="button"
                    onClick={() => {
                      void handleConnectPlaid();
                    }}
                    disabled={plaidActionLoading || plaidSyncOverlayVisible}
                  >
                    🔒 Connect with Plaid
                  </button>
                  <p className="rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400">
                    Securely link your bank in minutes to auto-sync balances and transactions for more accurate plans.
                  </p>
                  <div className="text-center text-xs text-slate-500">or</div>
                </>
              ) : null}
              <button
                className={`w-full rounded-md border px-4 py-3 text-sm ${plaidEnabled ? 'border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800' : 'border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700'}`}
                type="button"
                onClick={handleConnectMock}
              >
                🧪 Create Mock Account
              </button>
            </div>
            {!plaidEnabled ? (
              <div className="mt-4 rounded-lg border border-amber-800/50 bg-amber-950/30 p-3 text-xs text-slate-400">
                {appState.auth.status === 'authenticated' && !isTmmPlus ? (
                  <>
                    <strong>Plaid Integration:</strong> Plaid is available on TMM+. Upgrade to connect real bank accounts.
                  </>
                ) : (
                  <>
                    <strong>Plaid Integration:</strong> Enable Plaid in Settings to connect real bank accounts.
                  </>
                )}
              </div>
            ) : null}
            <div className="mt-4 flex justify-end">
              <button
                className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
                type="button"
                onClick={() => setShowConnectModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showMockModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 p-5 shadow-xl">
            <h3 className="text-lg font-semibold text-slate-100">Create Mock Account</h3>
            <p className="mt-3 text-sm text-slate-400">
              Create a mock account for testing. This simulates a real bank connection.
            </p>
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-xs text-slate-300">Account Name</label>
                <input
                  type="text"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  placeholder="e.g., Checking Account"
                  value={mockAccountName}
                  onChange={(e) => setMockAccountName(e.target.value)}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-300">Account Type</label>
                <select
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  value={mockAccountType}
                  onChange={(e) => setMockAccountType(e.target.value)}
                >
                  <option value="checking">Checking</option>
                  <option value="savings">Savings</option>
                  <option value="credit">Credit Card</option>
                  <option value="investment">Investment</option>
                  <option value="loan">Loan</option>
                  <option value="line_of_credit">Line of Credit</option>
                  <option value="brokerage">Brokerage</option>
                  <option value="retirement">Retirement (401k, IRA, etc.)</option>
                  <option value="crypto">Cryptocurrency</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-300">Initial Balance</label>
                <input
                  type="number"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  placeholder="1000"
                  value={mockInitialBalance}
                  onChange={(e) => setMockInitialBalance(Number(e.target.value) || 1000)}
                  step={0.01}
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="rounded-md border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800"
                type="button"
                onClick={() => setShowMockModal(false)}
              >
                Cancel
              </button>
              <button
                className="rounded-md border border-slate-600 bg-slate-700 px-3 py-2 text-xs text-slate-100 hover:bg-slate-600 disabled:opacity-50"
                type="button"
                onClick={handleCreateMockAccount}
                disabled={!mockAccountName.trim()}
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
