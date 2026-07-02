import { isRoute, navigateToRoute, usePathname } from '../../app/routing';

export function isSimulationPath(pathname: string): boolean {
  return isRoute(pathname, 'simulation');
}

export function useSimulationRoute(): boolean {
  return isSimulationPath(usePathname());
}

export function navigateToSimulation() {
  navigateToRoute('simulation');
}
