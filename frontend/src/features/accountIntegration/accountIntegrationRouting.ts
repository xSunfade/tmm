import { isRoute, navigateToRoute, usePathname } from '../../app/routing';

export function isAccountIntegrationPath(pathname: string): boolean {
  return isRoute(pathname, 'account-integration');
}

export function useAccountIntegrationRoute(): boolean {
  return isAccountIntegrationPath(usePathname());
}

export function navigateToAccountIntegration() {
  navigateToRoute('account-integration');
}
