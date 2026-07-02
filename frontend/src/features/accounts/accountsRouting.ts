import { isRoute, navigateToRoute, usePathname } from '../../app/routing';

export function isAccountsPath(pathname: string): boolean {
  return isRoute(pathname, 'accounts');
}

export function useAccountsRoute(): boolean {
  return isAccountsPath(usePathname());
}

export function navigateToAccounts() {
  navigateToRoute('accounts');
}
