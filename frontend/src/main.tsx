import './style.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './app/AppShell';
import { AppProviders } from './app/providers/AppProviders';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Missing #app root element');
}

createRoot(root).render(
  <React.StrictMode>
    <AppProviders>
      <AppShell />
    </AppProviders>
  </React.StrictMode>
);
