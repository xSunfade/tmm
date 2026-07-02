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

function canUseWorker(): boolean {
  return typeof Worker !== 'undefined';
}

export async function runSimulationInWorker(
  plan: PlanState,
  runYears: number,
  granularity: SimulationGranularity,
  options: ForecastOptions = {}
): Promise<SimulationResult> {
  if (!canUseWorker()) {
    return runSimulationFromLedger(plan, runYears, granularity, options);
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('./simulationWorker.ts', import.meta.url), { type: 'module' });
    const result = await new Promise<SimulationResult>((resolve, reject) => {
      const cleanup = () => {
        if (!worker) return;
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        worker = null;
      };

      worker!.onerror = (event) => {
        cleanup();
        reject(new Error(event.message || 'Simulation worker failed'));
      };

      worker!.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        if (!data || data.requestId !== requestId) return;
        cleanup();
        if (data.type === 'error') {
          reject(new Error(data.message || 'Simulation worker failed'));
          return;
        }
        resolve(deserializeSimulationResult(data.payload));
      };

      worker!.postMessage({
        requestId,
        plan,
        runYears,
        granularity,
        options
      });
    });
    return result;
  } catch {
    if (worker) {
      worker.terminate();
    }
    return runSimulationFromLedger(plan, runYears, granularity, options);
  }
}
