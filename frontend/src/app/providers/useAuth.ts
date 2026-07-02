import { useAppState } from '../../state/appState';
import { useAuthActions } from './AuthProvider';

export function useAuth() {
  const { auth, readiness } = useAppState();
  const { refreshPlanTier } = useAuthActions();
  return { ...auth, authReady: readiness.authReady, refreshPlanTier };
}
