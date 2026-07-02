import { isRoute, navigateToRoute, usePathname } from '../../app/routing';

export function isSettingsPath(pathname: string): boolean {
  return isRoute(pathname, 'settings');
}

export function useSettingsRoute(): boolean {
  return isSettingsPath(usePathname());
}

export function navigateToSettings() {
  navigateToRoute('settings');
}

export function navigateToAppHome() {
  navigateToRoute('home');
}
