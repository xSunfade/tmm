import './style.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './app/AppShell';
import { AppProviders } from './app/providers/AppProviders';
import { ErrorBoundary } from './components/ErrorBoundary';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Missing #app root element');
}

createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AppProviders>
        <AppShell />
      </AppProviders>
    </ErrorBoundary>
  </React.StrictMode>
);
