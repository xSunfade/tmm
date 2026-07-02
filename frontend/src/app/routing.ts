import React from 'react';

export const NAVIGATION_EVENT = 'tmm:navigate';

export type AppRoute =
  | 'home'
  | 'settings'
  | 'dashboard'
  | 'accounts'
  | 'pipeline'
  | 'simulation'
  | 'account-integration'
  | 'goals'
  | 'privacy';

const ROUTE_PATHS: Record<AppRoute, string[]> = {
  home: ['/', ''],
  settings: ['/settings', '/settings/'],
  dashboard: ['/dashboard', '/dashboard/'],
  accounts: ['/accounts', '/accounts/'],
  pipeline: ['/pipeline', '/pipeline/'],
  simulation: ['/simulation', '/simulation/'],
  'account-integration': ['/account-integration', '/account-integration/'],
  goals: ['/goals', '/goals/'],
  privacy: ['/privacy', '/privacy/']
};

function normalizePathname(pathname: string): string {
  if (!pathname) return '/';
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

export function isRoute(pathname: string, route: AppRoute): boolean {
  const normalized = normalizePathname(pathname);
  return ROUTE_PATHS[route].includes(normalized);
}

export function usePathname(): string {
  const [pathname, setPathname] = React.useState(() => window.location.pathname || '/');

  React.useEffect(() => {
    const handleNavigation = () => setPathname(window.location.pathname || '/');
    window.addEventListener('popstate', handleNavigation);
    window.addEventListener(NAVIGATION_EVENT, handleNavigation);
    return () => {
      window.removeEventListener('popstate', handleNavigation);
      window.removeEventListener(NAVIGATION_EVENT, handleNavigation);
    };
  }, []);

  return pathname;
}

export function dispatchNavigationEvent() {
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function navigateToRoute(route: AppRoute) {
  const target = ROUTE_PATHS[route][0] ?? '/';
  window.history.pushState({}, '', target);
  dispatchNavigationEvent();
}
