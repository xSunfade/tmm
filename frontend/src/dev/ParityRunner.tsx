import { useMemo, useState } from 'react';
import baselineFixture from './parity/fixtures/baseline.json';
import type { PlanState } from '../lib/plan/types';
import { DEFAULT_PLAN_STATE } from '../lib/plan/defaults';
import { runSimulationFromLedger } from '../lib/simulation/ledger';

type Fixture = {
  name: string;
  runYears: number;
  granularity: 'monthly' | 'daily';
  plan: PlanState;
  expectedHash?: string;
};

const baselineWithPlan: Fixture = {
  ...(baselineFixture as Omit<Fixture, 'plan'>),
  plan: { ...DEFAULT_PLAN_STATE, ...(baselineFixture as { plan?: Partial<PlanState> }).plan } as PlanState
};

const fixtures: Fixture[] = [baselineWithPlan];

function hashSeries(series: { alt: string; points: { date: Date; value: number }[] }[]) {
  const text = series
    .map((s) =>
      [
        s.alt,
        ...s.points.map((p) => `${p.date.toISOString().slice(0, 10)}:${p.value.toFixed(2)}`)
      ].join('|')
    )
    .join('~');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return `${hash}`;
}

export function ParityRunner() {
  const [selected, setSelected] = useState(fixtures[0]?.name ?? '');
  const fixture = useMemo(() => fixtures.find((f) => f.name === selected) || fixtures[0], [selected]);
  const result = useMemo(() => {
    if (!fixture) return null;
    const sim = runSimulationFromLedger(fixture.plan, fixture.runYears, fixture.granularity);
    const hash = hashSeries(sim.series);
    const endValue =
      sim.series[0]?.points[sim.series[0]?.points.length - 1]?.value ?? 0;
    return { hash, endValue };
  }, [fixture]);

  if (!fixture) return null;

  return (
    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/80 p-3 text-xs text-slate-200">
      <div className="text-sm font-semibold text-white">Parity Runner</div>
      <div className="mt-2">
        <label className="text-slate-400">Fixture</label>
        <select
          className="ml-2 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {fixtures.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {result ? (
        <div className="mt-2 space-y-1 text-slate-300">
          <div>Run years: {fixture.runYears}</div>
          <div>Granularity: {fixture.granularity}</div>
          <div>Series hash: {result.hash}</div>
          <div>End value: {result.endValue.toFixed(2)}</div>
          {fixture.expectedHash ? (
            <div>
              Expected hash: {fixture.expectedHash}{' '}
              {fixture.expectedHash === result.hash ? '✓' : '✕'}
            </div>
          ) : (
            <div className="text-slate-400">No expected hash set yet.</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
