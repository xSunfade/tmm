import { isRoute, navigateToRoute, usePathname } from '../../app/routing';

export function isDashboardPath(pathname: string): boolean {
  return isRoute(pathname, 'dashboard') || isRoute(pathname, 'home');
}

export function useDashboardRoute(): boolean {
  return isDashboardPath(usePathname());
}

export function navigateToDashboard() {
  navigateToRoute('dashboard');
}
