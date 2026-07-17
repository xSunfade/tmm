import React, { createContext, useContext, useReducer } from 'react';

export type AuthStatus = 'unknown' | 'unauthenticated' | 'authenticated';

export type AppState = {
  readiness: {
    authReady: boolean;
    profileReady: boolean;
    integrationsReady: boolean;
    appDataReady: boolean;
  };
  auth: {
    status: AuthStatus;
    userId?: string;
    email?: string;
    /** null = loading (not yet fetched); resolved tiers per D7 */
    planTier?: 'free' | 'tmm_plus' | 'tmm_pro' | null;
  };
  onboarding: {
    needsOnboarding: boolean;
    tourActive: boolean;
    resumeAvailable: boolean;
  };
  restore: {
    available: boolean;
    reason?: string;
    meta?: RestoreMetadata;
  };
  sheets: {
    connected: boolean;
    dismissed: boolean;
    /** True after getGoogleTokenStatus() has completed this session; gates Export backup / Import from sheet */
    connectionVerified: boolean;
    /** Last spreadsheet id from backend (persisted across devices); UI uses this ?? getStoredSheetId() */
    spreadsheetId?: string | null;
  };
  plaid: {
    syncRunning: boolean;
    syncLastCompletedAt: string | null;
  };
  dev: {
    forceOnboarding: boolean;
  };
};

export type AppAction =
  | { type: 'readiness'; key: keyof AppState['readiness']; value: boolean }
  | { type: 'auth'; status: AuthStatus; userId?: string; email?: string; planTier?: 'free' | 'tmm_plus' | 'tmm_pro' | null }
  | { type: 'onboarding'; needsOnboarding: boolean; resumeAvailable?: boolean }
  | { type: 'tour'; tourActive: boolean }
  | { type: 'restore'; available: boolean; reason?: string; meta?: RestoreMetadata }
  | { type: 'sheets'; connected: boolean; dismissed?: boolean; connectionVerified?: boolean; spreadsheetId?: string | null }
  | { type: 'plaid'; syncRunning?: boolean; syncLastCompletedAt?: string | null }
  | { type: 'dev'; forceOnboarding: boolean };

const initialState: AppState = {
  readiness: {
    authReady: false,
    profileReady: false,
    integrationsReady: false,
    appDataReady: false
  },
  auth: {
    status: 'unknown'
  },
  onboarding: {
    needsOnboarding: false,
    tourActive: false,
    resumeAvailable: false
  },
  restore: {
    available: false
  },
  sheets: {
    connected: false,
    dismissed: false,
    connectionVerified: false
  },
  plaid: {
    syncRunning: false,
    syncLastCompletedAt: null
  },
  dev: {
    forceOnboarding: false
  }
};

export type RestoreMetadata = {
  lastSavedIso?: string | null;
  summary?: string;
  warning?: string;
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'readiness':
      return {
        ...state,
        readiness: { ...state.readiness, [action.key]: action.value }
      };
    case 'auth':
      return {
        ...state,
        auth: {
          status: action.status,
          userId: action.userId,
          email: action.email,
          planTier: action.planTier !== undefined ? action.planTier : state.auth.planTier
        }
      };
    case 'onboarding':
      return {
        ...state,
        onboarding: {
          ...state.onboarding,
          needsOnboarding: action.needsOnboarding,
          resumeAvailable: action.resumeAvailable ?? state.onboarding.resumeAvailable
        }
      };
    case 'tour':
      return { ...state, onboarding: { ...state.onboarding, tourActive: action.tourActive } };
    case 'restore':
      return {
        ...state,
        restore: { available: action.available, reason: action.reason, meta: action.meta }
      };
    case 'sheets':
      return {
        ...state,
        sheets: {
          connected: action.connected,
          dismissed: action.dismissed ?? state.sheets.dismissed,
          connectionVerified: action.connectionVerified ?? state.sheets.connectionVerified,
          spreadsheetId: action.spreadsheetId !== undefined ? action.spreadsheetId : state.sheets.spreadsheetId
        }
      };
    case 'plaid':
      return {
        ...state,
        plaid: {
          syncRunning: action.syncRunning ?? state.plaid.syncRunning,
          syncLastCompletedAt:
            action.syncLastCompletedAt !== undefined ? action.syncLastCompletedAt : state.plaid.syncLastCompletedAt
        }
      };
    case 'dev':
      return { ...state, dev: { forceOnboarding: action.forceOnboarding } };
    default:
      return state;
  }
}

const AppStateContext = createContext<AppState | null>(null);
const AppDispatchContext = createContext<React.Dispatch<AppAction> | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>{children}</AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}

export function useAppState() {
  const value = useContext(AppStateContext);
  if (!value) {
    throw new Error('useAppState must be used inside AppStateProvider');
  }
  return value;
}

export function useAppDispatch() {
  const value = useContext(AppDispatchContext);
  if (!value) {
    throw new Error('useAppDispatch must be used inside AppStateProvider');
  }
  return value;
}
