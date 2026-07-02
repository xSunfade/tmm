import { NetWorthChart } from '../../components/charts/NetWorthChart';
import type { SimulationSeries } from '../../lib/simulation/ledger';

type SimulationChartProps = {
  series: SimulationSeries[];
  historicalSeries?: SimulationSeries[];
};

export function SimulationChart({ series, historicalSeries = [] }: SimulationChartProps) {
  if (series.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-slate-700 text-sm text-slate-400">
        Run a simulation to see projections.
      </div>
    );
  }
  return <NetWorthChart series={series} historicalSeries={historicalSeries} height={320} />;
}
