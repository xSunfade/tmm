import type { Checkpoint } from '../plan/types';
import { authFetch } from '../api/authFetch';
import type { SimulationSeries } from './simulation';

type HistoryResponsePoint = {
  alt?: string;
  date: string;
  value: number;
  source?: string;
  confidence?: string;
  reconciled?: boolean;
  needsReview?: boolean;
};

type HistoryResponse = {
  points: HistoryResponsePoint[];
  coverage?: { earliest?: string | null; latest?: string | null };
  as_of_rule?: string;
};

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function normalizeCheckpointSource(source: string | undefined) {
  return source === 'auto-monthly' ? 'checkpoint_auto' : 'checkpoint_user';
}

export async function fetchMergedHistoricalSeries(params: {
  plaidBaseUrl: string;
  altNames: string[];
  checkpointsByAlt: Record<string, Checkpoint[]>;
  startDate: Date;
  endDate: Date;
}): Promise<{ series: SimulationSeries[]; coverage?: { earliest?: string | null; latest?: string | null } }> {
  const base = (params.plaidBaseUrl || '').replace(/\/$/, '');
  if (!base) {
    return { series: [] };
  }

  const query = new URLSearchParams({
    start_date: toIsoDate(params.startDate),
    end_date: toIsoDate(params.endDate),
    alt_names: params.altNames.join(',')
  });

  const response = (await authFetch(`${base}/api/history/net-worth/tmm?${query.toString()}`, {
    method: 'GET'
  })) as HistoryResponse;

  const sharedRemoteByDate = new Map<string, SimulationSeries['points'][number]>();
  const remoteByAltByDate = new Map<string, Map<string, SimulationSeries['points'][number]>>();
  (response.points || []).forEach((point) => {
    const key = String(point.date).slice(0, 10);
    const normalized = {
      date: new Date(point.date),
      value: Number(point.value || 0),
      source: point.source,
      confidence: point.confidence,
      reconciled: !!point.reconciled,
      needsReview: !!point.needsReview
    };
    if (!point.alt) {
      sharedRemoteByDate.set(key, normalized);
      return;
    }
    if (!remoteByAltByDate.has(point.alt)) {
      remoteByAltByDate.set(point.alt, new Map());
    }
    remoteByAltByDate.get(point.alt)?.set(key, normalized);
  });

  const series: SimulationSeries[] = params.altNames.map((alt) => {
    const checkpoints = params.checkpointsByAlt[alt] || [];
    const merged = new Map<string, SimulationSeries['points'][number]>();
    checkpoints.forEach((cp) => {
      const key = String(cp.date).slice(0, 10);
      merged.set(key, {
        date: new Date(cp.date),
        value: Number(cp.netWorth || 0),
        source: normalizeCheckpointSource(cp.source),
        confidence: cp.confidence || 'high',
        reconciled: false
      });
    });
    const remoteByDate = remoteByAltByDate.get(alt) || sharedRemoteByDate;
    remoteByDate.forEach((value, key) => {
      merged.set(key, value);
    });
    const points = Array.from(merged.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
    return { alt, points, isHistorical: true };
  });

  return {
    series,
    coverage: response.coverage
  };
}
