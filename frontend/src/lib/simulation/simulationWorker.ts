/// <reference lib="webworker" />

import { runSimulationFromLedger, type ForecastOptions, type SimulationGranularity } from './ledger';
import type { PlanState } from '../plan/types';
import { serializeSimulationResult } from './simulationWorkerTransport';

type WorkerRequest = {
  requestId: string;
  plan: PlanState;
  runYears: number;
  granularity: SimulationGranularity;
  options: ForecastOptions;
};

type WorkerResponse =
  | { type: 'result'; requestId: string; payload: ReturnType<typeof serializeSimulationResult> }
  | { type: 'error'; requestId: string; message: string };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { requestId, plan, runYears, granularity, options } = event.data || {};
  try {
    const result = runSimulationFromLedger(plan, runYears, granularity, options || {});
    const payload = serializeSimulationResult(result);
    const response: WorkerResponse = { type: 'result', requestId, payload };
    self.postMessage(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Simulation worker failed';
    const response: WorkerResponse = { type: 'error', requestId, message };
    self.postMessage(response);
  }
};

export {};
