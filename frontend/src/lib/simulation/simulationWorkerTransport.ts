import type { SimulationPoint, SimulationResult, SimulationSeries } from './ledger';

type SerializedSimulationPoint = Omit<SimulationPoint, 'date'> & { date: string };
type SerializedSimulationSeries = Omit<SimulationSeries, 'points'> & {
  points: SerializedSimulationPoint[];
};

type SerializedPercentilePoint = { date: string; p10: number; p50: number; p90: number };
type SerializedPercentileSeries = {
  alt: string;
  points: SerializedPercentilePoint[];
};

export type SerializedSimulationResult = Omit<
  SimulationResult,
  'series' | 'historicalSeries' | 'percentileSeries'
> & {
  series: SerializedSimulationSeries[];
  historicalSeries: SerializedSimulationSeries[];
  percentileSeries?: SerializedPercentileSeries[];
};

function serializePoint(point: SimulationPoint): SerializedSimulationPoint {
  return {
    ...point,
    date: point.date.toISOString()
  };
}

function deserializePoint(point: SerializedSimulationPoint): SimulationPoint {
  return {
    ...point,
    date: new Date(point.date)
  };
}

export function serializeSimulationResult(result: SimulationResult): SerializedSimulationResult {
  return {
    ...result,
    series: (result.series || []).map((series) => ({
      ...series,
      points: series.points.map(serializePoint)
    })),
    historicalSeries: (result.historicalSeries || []).map((series) => ({
      ...series,
      points: series.points.map(serializePoint)
    })),
    percentileSeries: result.percentileSeries?.map((series) => ({
      ...series,
      points: series.points.map((point) => ({
        ...point,
        date: point.date.toISOString()
      }))
    }))
  };
}

export function deserializeSimulationResult(payload: SerializedSimulationResult): SimulationResult {
  return {
    ...payload,
    series: (payload.series || []).map((series) => ({
      ...series,
      points: series.points.map(deserializePoint)
    })),
    historicalSeries: (payload.historicalSeries || []).map((series) => ({
      ...series,
      points: series.points.map(deserializePoint)
    })),
    percentileSeries: payload.percentileSeries?.map((series) => ({
      ...series,
      points: series.points.map((point) => ({
        ...point,
        date: new Date(point.date)
      }))
    }))
  };
}
