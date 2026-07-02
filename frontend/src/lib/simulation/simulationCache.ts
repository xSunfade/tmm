import type { SimulationResult } from './ledger';

/**
 * Module-level cache for completed simulations. It lives outside the React tree, so it
 * survives `DashboardScreen` unmounting/remounting on navigation. As long as none of the
 * inputs that feed a run have changed, returning to the dashboard is an instant cache hit
 * instead of a recalculation.
 *
 * The cache key must encode every input that affects the result (plan fingerprint, seed,
 * active alternative, enabled alternatives, horizon, granularity, forecast view, and the
 * Monte Carlo run count). When any of those change the key changes and we recompute.
 */
const MAX_ENTRIES = 16;
const cache = new Map<string, SimulationResult>();

export function buildSimulationCacheKey(
  parts: Array<string | number | boolean | null | undefined>
): string {
  return parts.map((part) => String(part)).join('::');
}

export function getCachedSimulation(key: string): SimulationResult | undefined {
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency so the most recently used entries survive eviction.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

export function setCachedSimulation(key: string, result: SimulationResult): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, result);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearSimulationCache(): void {
  cache.clear();
}
