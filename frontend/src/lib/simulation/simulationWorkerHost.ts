import type { PlanState } from '../plan/types';
import {
  runSimulationFromLedger,
  type ForecastOptions,
  type SimulationGranularity,
  type SimulationResult
} from './ledger';
import {
  deserializeSimulationResult,
  type SerializedSimulationResult
} from './simulationWorkerTransport';

type WorkerResponse =
  | { type: 'result'; requestId: string; payload: SerializedSimulationResult }
  | { type: 'error'; requestId: string; message: string };

type PendingRequest = {
  resolve: (result: SimulationResult) => void;
  reject: (error: Error) => void;
};

// A single long-lived worker serves all simulation requests; it is only
// terminated and recreated after a worker-level failure. Responses are matched
// to callers by request id so concurrent in-flight requests cannot mix.
let sharedWorker: Worker | null = null;
let requestCounter = 0;
const pendingRequests = new Map<string, PendingRequest>();

const FALLBACK_MAX_MONTE_CARLO_RUNS = 1;

function canUseWorker(): boolean {
  return typeof Worker !== 'undefined';
}

function isBrowserMainThread(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function destroySharedWorker() {
  if (!sharedWorker) return;
  sharedWorker.onmessage = null;
  sharedWorker.onerror = null;
  sharedWorker.terminate();
  sharedWorker = null;
}

function rejectAllPending(error: Error) {
  const pending = Array.from(pendingRequests.values());
  pendingRequests.clear();
  pending.forEach((request) => request.reject(error));
}

function getOrCreateWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  const worker = new Worker(new URL('./simulationWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const data = event.data;
    if (!data || typeof data.requestId !== 'string') return;
    const pending = pendingRequests.get(data.requestId);
    if (!pending) return;
    pendingRequests.delete(data.requestId);
    if (data.type === 'error') {
      // The engine threw for this request; the worker itself is still healthy.
      pending.reject(new Error(data.message || 'Simulation worker failed'));
      return;
    }
    pending.resolve(deserializeSimulationResult(data.payload));
  };
  worker.onerror = (event) => {
    // Worker-level failure: everything in flight is lost. Recreate lazily on
    // the next request.
    destroySharedWorker();
    rejectAllPending(new Error(event.message || 'Simulation worker failed'));
  };
  sharedWorker = worker;
  return worker;
}

/**
 * Runs the simulation on the calling thread. On the browser main thread the
 * load is capped (single Monte Carlo run, monthly granularity) so a missing
 * Worker never freezes the tab; off the main thread (e.g. Node test runners)
 * the requested options are honored in full.
 */
function runFallbackSimulation(
  plan: PlanState,
  runYears: number,
  granularity: SimulationGranularity,
  options: ForecastOptions
): SimulationResult {
  if (!isBrowserMainThread()) {
    return runSimulationFromLedger(plan, runYears, granularity, options);
  }
  const cappedOptions: ForecastOptions = {
    ...options,
    monteCarloRuns: Math.min(options.monteCarloRuns ?? 1, FALLBACK_MAX_MONTE_CARLO_RUNS)
  };
  return runSimulationFromLedger(plan, runYears, 'monthly', cappedOptions);
}

export async function runSimulationInWorker(
  plan: PlanState,
  runYears: number,
  granularity: SimulationGranularity,
  options: ForecastOptions = {}
): Promise<SimulationResult> {
  if (!canUseWorker()) {
    return runFallbackSimulation(plan, runYears, granularity, options);
  }

  let worker: Worker;
  try {
    worker = getOrCreateWorker();
  } catch (error) {
    // Worker construction is broken in this environment (e.g. CSP); run on
    // the calling thread instead.
    console.warn('[simulation] Worker unavailable; falling back to main thread', error);
    return runFallbackSimulation(plan, runYears, granularity, options);
  }

  requestCounter += 1;
  const requestId = `sim-${requestCounter}`;
  return new Promise<SimulationResult>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    try {
      worker.postMessage({
        requestId,
        plan,
        runYears,
        granularity,
        options
      });
    } catch (error) {
      pendingRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error('Simulation worker failed'));
    }
  });
}
