import { isRoute, navigateToRoute, usePathname } from '../../app/routing';

export function isPipelinePath(pathname: string): boolean {
  return isRoute(pathname, 'pipeline');
}

export function usePipelineRoute(): boolean {
  return isPipelinePath(usePathname());
}

export function navigateToPipeline() {
  navigateToRoute('pipeline');
}
