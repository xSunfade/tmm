export function mergePointsWithCheckpoints({
  points,
  checkpoints = [],
  threshold = 250,
  coverage = null,
  overrides = []
}: {
  points: any[];
  checkpoints?: any[];
  threshold?: number;
  coverage?: { earliest: string; latest: string } | null;
  overrides?: any[];
}) {
  const byDate = new Map();
  const overridesByDate = new Map((overrides || []).map((o) => [o.point_date, o]));

  for (const point of points || []) {
    byDate.set(point.point_date, {
      date: point.point_date,
      value: Number(point.net_worth || 0),
      source: point.source,
      confidence: point.confidence || 'high',
      reconciled: !!point.reconciled,
      needsReview: false
    });
  }

  for (const cp of checkpoints || []) {
    if (!cp?.date) continue;
    const date = cp.date.slice(0, 10);
    const checkpointValue = Number(cp.netWorth || 0);
    const existing = byDate.get(date);
    const override = overridesByDate.get(date);

    if (!existing) {
      byDate.set(date, {
        date,
        value: checkpointValue,
        source: cp.source === 'auto-monthly' ? 'checkpoint_auto' : 'checkpoint_user',
        confidence: cp.confidence || 'high',
        reconciled: false,
        needsReview: false
      });
      continue;
    }

    const delta = Math.abs(Number(existing.value || 0) - checkpointValue);
    const inCoverage = coverage?.earliest && coverage?.latest
      ? date >= coverage.earliest && date <= coverage.latest
      : false;
    const existingIsPlaid = existing.source === 'plaid_live' || existing.source === 'plaid_archived';

    if (override?.chosen_source === 'checkpoint') {
      byDate.set(date, {
        date,
        value: checkpointValue,
        source: cp.source === 'auto-monthly' ? 'checkpoint_auto' : 'checkpoint_user',
        confidence: cp.confidence || 'high',
        reconciled: true,
        needsReview: false
      });
      continue;
    }
    if (override?.chosen_source === 'plaid') {
      byDate.set(date, { ...existing, reconciled: true, needsReview: false });
      continue;
    }

    if (existingIsPlaid && inCoverage) {
      byDate.set(date, {
        ...existing,
        needsReview: delta > threshold,
        checkpointValue,
        plaidValue: Number(existing.value || 0)
      });
      continue;
    }
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
