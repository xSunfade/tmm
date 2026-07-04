import { DEFAULT_PLAN_STATE } from '../../frontend/src/lib/plan/defaults';
import type { PlanState } from '../../frontend/src/lib/plan/types';
import {
  runSimulationFromLedger,
  type ForecastOptions,
  type SimulationGranularity
} from '../../frontend/src/lib/simulation/ledger';
import { runSimulationInWorker } from '../../frontend/src/lib/simulation/simulationWorkerHost';
import { serializeSimulationResult } from '../../frontend/src/lib/simulation/simulationWorkerTransport';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function approxEqual(actual: number, expected: number, tolerance = 1e-6) {
  return Math.abs(actual - expected) <= tolerance;
}

function buildPlan(incomeMonthly: number, expenseMonthly: number): PlanState {
  const plan = JSON.parse(JSON.stringify(DEFAULT_PLAN_STATE)) as PlanState;
  plan.assumptions.start = '2026-01-01';
  plan.alternatives.Baseline.income = [
    {
      uuid: 'income-1',
      name: 'Salary',
      amount: incomeMonthly,
      freq: 'monthly',
      start: '2026-01-01',
      raise: 0,
      dataSource: 'manual'
    }
  ];
  plan.alternatives.Baseline.expense = [
    {
      uuid: 'expense-1',
      name: 'Bills',
      amount: expenseMonthly,
      freq: 'monthly',
      start: '2026-01-01',
      infl: 0,
      dataSource: 'manual'
    }
  ];
  return plan;
}

type FakeWorkerMessage = {
  requestId: string;
  plan: PlanState;
  runYears: number;
  granularity: SimulationGranularity;
  options: ForecastOptions;
};

/**
 * Emulates simulationWorker.ts in-process so the host's reuse, correlation,
 * and error-recovery logic can be exercised without a real Web Worker.
 */
class FakeWorker {
  static instanceCount = 0;
  static current: FakeWorker | null = null;

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  terminated = false;
  private held: FakeWorkerMessage[] = [];

  constructor() {
    FakeWorker.instanceCount += 1;
    FakeWorker.current = this;
  }

  postMessage(data: FakeWorkerMessage) {
    if (this.terminated) throw new Error('postMessage on terminated worker');
    this.held.push(data);
  }

  terminate() {
    this.terminated = true;
  }

  flush(order: 'fifo' | 'reversed' = 'fifo') {
    const queue = order === 'reversed' ? [...this.held].reverse() : [...this.held];
    this.held = [];
    for (const message of queue) {
      let response: unknown;
      try {
        const result = runSimulationFromLedger(
          message.plan,
          message.runYears,
          message.granularity,
          message.options || {}
        );
        response = {
          type: 'result',
          requestId: message.requestId,
          payload: serializeSimulationResult(result)
        };
      } catch (error) {
        response = {
          type: 'error',
          requestId: message.requestId,
          message: error instanceof Error ? error.message : 'Simulation worker failed'
        };
      }
      this.onmessage?.({ data: response });
    }
  }

  crash(message: string) {
    this.held = [];
    this.onerror?.({ message });
  }
}

const globalAny = globalThis as Record<string, unknown>;

async function testFallbackCappedOnBrowserMainThread() {
  assert(typeof globalAny.Worker === 'undefined', 'precondition: no Worker global');
  globalAny.window = {};
  globalAny.document = {};
  try {
    const plan = buildPlan(5000, 3000);
    const result = await runSimulationInWorker(plan, 1, 'daily', {
      seed: 'fallback-cap-seed',
      monteCarloRuns: 200,
      returnPercentiles: true
    });
    assert(result.monteCarloRuns === 1, `fallback must cap Monte Carlo runs to 1, got ${result.monteCarloRuns}`);
    const pointCount = result.series[0]?.points.length ?? 0;
    assert(
      pointCount > 0 && pointCount <= 20,
      `fallback must run at monthly granularity (expected ~13 points for 1y, got ${pointCount})`
    );
  } finally {
    delete globalAny.window;
    delete globalAny.document;
  }
}

async function testFallbackUncappedOffMainThread() {
  assert(typeof globalAny.Worker === 'undefined', 'precondition: no Worker global');
  const plan = buildPlan(5000, 3000);
  const options = { seed: 'fallback-parity-seed', monteCarloRuns: 20, returnPercentiles: true };
  const direct = runSimulationFromLedger(plan, 1, 'monthly', options);
  const viaHost = await runSimulationInWorker(plan, 1, 'monthly', options);
  assert(viaHost.monteCarloRuns === 20, 'off-main-thread fallback honors requested runs');
  const directP50 = direct.percentileSeries?.[0]?.points.map((p) => p.p50) || [];
  const hostP50 = viaHost.percentileSeries?.[0]?.points.map((p) => p.p50) || [];
  assert(directP50.length === hostP50.length && directP50.length > 0, 'fallback parity length mismatch');
  for (let i = 0; i < directP50.length; i += 1) {
    assert(approxEqual(directP50[i], hostP50[i]), `fallback parity mismatch at ${i}`);
  }
}

async function testWorkerReuseAndCorrelation() {
  globalAny.Worker = FakeWorker;
  try {
    const planA = buildPlan(5000, 3000);
    const planB = buildPlan(9000, 1000);
    const options = { seed: 'reuse-seed', monteCarloRuns: 5, returnPercentiles: true };

    const promiseA = runSimulationInWorker(planA, 1, 'monthly', options);
    const promiseB = runSimulationInWorker(planB, 1, 'monthly', options);
    assert(FakeWorker.instanceCount === 1, `expected a single worker for concurrent requests, got ${FakeWorker.instanceCount}`);

    // Deliver responses out of order to prove request/response correlation.
    FakeWorker.current!.flush('reversed');
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    const expectedA = runSimulationFromLedger(planA, 1, 'monthly', options);
    const expectedB = runSimulationFromLedger(planB, 1, 'monthly', options);
    const firstA = resultA.series[0]?.points?.[0]?.value ?? NaN;
    const firstB = resultB.series[0]?.points?.[0]?.value ?? NaN;
    assert(approxEqual(firstA, expectedA.series[0].points[0].value), 'request A received the wrong result');
    assert(approxEqual(firstB, expectedB.series[0].points[0].value), 'request B received the wrong result');
    assert(!approxEqual(firstA, firstB), 'plans A and B should produce different results');

    // A later request reuses the same worker instance.
    const promiseC = runSimulationInWorker(planA, 1, 'monthly', options);
    assert(FakeWorker.instanceCount === 1, `expected worker reuse across sequential requests, got ${FakeWorker.instanceCount}`);
    FakeWorker.current!.flush();
    await promiseC;
  } finally {
    delete globalAny.Worker;
  }
}

async function testWorkerRecreatedAfterError() {
  globalAny.Worker = FakeWorker;
  try {
    const baseline = FakeWorker.instanceCount;
    const plan = buildPlan(5000, 3000);
    const options = { seed: 'error-seed', monteCarloRuns: 2 };

    const failing = runSimulationInWorker(plan, 1, 'monthly', options);
    const failingWorker = FakeWorker.current!;
    failingWorker.crash('boom');

    let rejected = false;
    try {
      await failing;
    } catch (error) {
      rejected = true;
      assert((error as Error).message === 'boom', 'in-flight request should reject with the worker error');
    }
    assert(rejected, 'in-flight request must reject when the worker crashes');
    assert(failingWorker.terminated, 'crashed worker must be terminated');

    const retry = runSimulationInWorker(plan, 1, 'monthly', options);
    assert(FakeWorker.instanceCount === baseline + 1, 'a fresh worker must be created after a crash');
    assert(FakeWorker.current !== failingWorker, 'retry must not reuse the crashed worker');
    FakeWorker.current!.flush();
    const result = await retry;
    assert((result.series[0]?.points.length ?? 0) > 0, 'retry after crash should succeed');
  } finally {
    delete globalAny.Worker;
  }
}

async function run() {
  console.log('🧪 Running simulation worker host tests...\n');

  await testFallbackCappedOnBrowserMainThread();
  console.log('✅ fallback capped on browser main thread (1 run, monthly)');

  await testFallbackUncappedOffMainThread();
  console.log('✅ fallback parity off main thread (uncapped)');

  await testWorkerReuseAndCorrelation();
  console.log('✅ single worker reused + request/response correlation (out-of-order safe)');

  await testWorkerRecreatedAfterError();
  console.log('✅ worker terminated and recreated after crash; in-flight rejected');

  console.log('\n✅ simulation worker host tests passed');
}

run().catch((err) => {
  console.error(`\n❌ simulation worker host tests failed: ${err.message}`);
  process.exit(1);
});
