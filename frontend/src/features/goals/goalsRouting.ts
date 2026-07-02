import { isRoute, navigateToRoute, usePathname } from '../../app/routing';

export function isGoalsPath(pathname: string): boolean {
  return isRoute(pathname, 'goals');
}

export function useGoalsRoute(): boolean {
  return isGoalsPath(usePathname());
}

export function navigateToGoals() {
  navigateToRoute('goals');
}
