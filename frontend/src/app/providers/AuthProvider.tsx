import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import { getSupabaseClient } from '../../lib/supabaseClient';
import { resolveDevOverrides } from '../../dev/devOverrides';
import { useAppDispatch, useAppState } from '../../state/appState';
import { setActiveStorageUserId } from '../../lib/storage/userScopedStorage';

async function fetchPlanTierFromDb(userId: string): Promise<'free' | 'tmm_plus' | 'tmm_pro'> {
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase.from('profiles').select('plan_tier').eq('id', userId).maybeSingle();
    const tier = data?.plan_tier;
    return tier === 'tmm_plus' || tier === 'tmm_pro' ? tier : 'free';
  } catch {
    return 'free';
  }
}

export type AuthActions = {
  refreshPlanTier: () => Promise<void>;
};

const AuthActionsContext = createContext<AuthActions | null>(null);

export function useAuthActions(): AuthActions {
  const value = useContext(AuthActionsContext);
  if (!value) {
    return {
      refreshPlanTier: async () => {}
    };
  }
  return value;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const dispatch = useAppDispatch();
  const appState = useAppState();
  const authRef = useRef(appState.auth);
  authRef.current = appState.auth;

  const refreshPlanTier = useCallback(async () => {
    const { data } = await getSupabaseClient().auth.getSession();
    const user = data.session?.user;
    if (!user) return;
    const tier = await fetchPlanTierFromDb(user.id);
    const auth = authRef.current;
    dispatch({
      type: 'auth',
      status: auth.status,
      userId: auth.userId,
      email: auth.email,
      planTier: tier
    });
  }, [dispatch]);

  const actions: AuthActions = useRef({ refreshPlanTier }).current;
  actions.refreshPlanTier = refreshPlanTier;

  useEffect(() => {
    let isMounted = true;
    let unsubscribe: (() => void) | null = null;

    const initAuth = async () => {
      try {
        const supabase = getSupabaseClient();
        const { data } = await supabase.auth.getSession();
        const user = data.session?.user ?? null;

        if (!isMounted) return;

        // Set planTier to null (loading) until fetch completes
        setActiveStorageUserId(user?.id ?? null);
        dispatch({
          type: 'auth',
          status: user ? 'authenticated' : 'unauthenticated',
          userId: user?.id,
          email: user?.email ?? undefined,
          planTier: user ? null : undefined
        });

        const overrides = resolveDevOverrides(user?.email ?? undefined);
        dispatch({ type: 'dev', forceOnboarding: overrides.forceOnboarding });

        if (user) {
          const planTier = await fetchPlanTierFromDb(user.id);
          if (!isMounted) return;
          dispatch({
            type: 'auth',
            status: 'authenticated',
            userId: user.id,
            email: user.email ?? undefined,
            planTier
          });
        }

        const { data: subscriptionData } = supabase.auth.onAuthStateChange(async (_event, session) => {
          const nextUser = session?.user ?? null;
          if (!isMounted) return;
          const currentAuth = authRef.current;
          const isSameUser = nextUser?.id != null && nextUser.id === currentAuth.userId;
          setActiveStorageUserId(nextUser?.id ?? null);
          // Only set planTier to null when user actually changed (avoids "…" flash on tab focus when Supabase re-fires)
          const planTierWhileLoading = nextUser ? (isSameUser ? currentAuth.planTier : null) : undefined;
          dispatch({
            type: 'auth',
            status: nextUser ? 'authenticated' : 'unauthenticated',
            userId: nextUser?.id,
            email: nextUser?.email ?? undefined,
            planTier: planTierWhileLoading
          });
          const nextOverrides = resolveDevOverrides(nextUser?.email ?? undefined);
          dispatch({ type: 'dev', forceOnboarding: nextOverrides.forceOnboarding });
          if (nextUser) {
            const nextPlanTier = await fetchPlanTierFromDb(nextUser.id);
            if (!isMounted) return;
            dispatch({
              type: 'auth',
              status: 'authenticated',
              userId: nextUser.id,
              email: nextUser.email ?? undefined,
              planTier: nextPlanTier
            });
          }
        });

        unsubscribe = subscriptionData.subscription.unsubscribe;
      } catch (error) {
        console.error('[auth] Failed to initialize Supabase auth', error);
        setActiveStorageUserId(null);
        if (isMounted) {
          dispatch({ type: 'auth', status: 'unauthenticated' });
        }
      } finally {
        if (isMounted) {
          dispatch({ type: 'readiness', key: 'authReady', value: true });
        }
      }
    };

    initAuth();

    return () => {
      isMounted = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [dispatch]);

  // Wake Supabase session when tab becomes visible so subsequent getSession() in authFetch don't hang (e.g. Account Integration refetch)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        getSupabaseClient().auth.getSession()
          .catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return (
    <AuthActionsContext.Provider value={actions}>
      {children}
    </AuthActionsContext.Provider>
  );
}
