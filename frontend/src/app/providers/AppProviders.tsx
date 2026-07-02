import React from 'react';
import { AppStateProvider } from '../../state/appState';
import { AuthProvider } from './AuthProvider';
import { PlanProvider } from './PlanProvider';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <AppStateProvider>
      <AuthProvider>
        <PlanProvider>{children}</PlanProvider>
      </AuthProvider>
    </AppStateProvider>
  );
}
