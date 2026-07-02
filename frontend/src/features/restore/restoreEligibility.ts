import type { PlanState } from '../../lib/plan/types';
import { getRestoreDecline, getRestoreSnapshotId } from '../../lib/plan/planPersistence';

type RestoreEligibility = {
  eligible: boolean;
  reason?: string;
  meta?: {
    lastSavedIso?: string | null;
    summary?: string;
    warning?: string;
  };
};

export function hasMeaningfulData(plan: PlanState): boolean {
  const alternatives = plan.alternatives || {};
  return Object.keys(alternatives).some((altName) => {
    const alt = alternatives[altName];
    if (!alt) return false;
    return (
      alt.income.length > 0 ||
      alt.expense.length > 0 ||
      alt.asset.length > 0 ||
      alt.debt.length > 0
    );
  });
}

export function getRestoreEligibility(plan: PlanState): RestoreEligibility {
  if (!plan) {
    return { eligible: false, reason: 'No saved session found.' };
  }

  const meaningful = hasMeaningfulData(plan);
  if (!meaningful) {
    return { eligible: false, reason: 'Saved session is empty.' };
  }

  const snapshotId = getRestoreSnapshotId(plan);
  const decline = getRestoreDecline();
  if (decline && decline.snapshotId === snapshotId) {
    return { eligible: false, reason: 'Restore already declined for this snapshot.' };
  }

  const altCount = Object.keys(plan.alternatives || {}).length;
  const lastSavedIso = plan.lastSaved ?? null;

  return {
    eligible: true,
    meta: {
      lastSavedIso,
      summary: `Saved alternatives: ${altCount}`,
      warning: 'Restoring will overwrite your current state.'
    }
  };
}
