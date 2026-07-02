import type { PlanState, Checkpoint } from '../plan/types';
import { getEffectiveValue } from '../plan/overrideManager';

function calculateNetWorth(alt: PlanState['alternatives'][string]): number {
  const assets = (alt.asset || []).reduce((sum, a) => sum + (getEffectiveValue(a) || 0), 0);
  const debts = (alt.debt || []).reduce((sum, d) => sum + (getEffectiveValue(d) || 0), 0);
  return assets - debts;
}

export function getCheckpoints(plan: PlanState, altName: string): Checkpoint[] {
  return plan.checkpoints[altName] || [];
}

export function getLastCheckpoint(plan: PlanState, altName: string): Checkpoint | null {
  const checkpoints = getCheckpoints(plan, altName);
  return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
}

export function createCheckpoint(plan: PlanState, altName: string, type: Checkpoint['type'], metadata = {}): Checkpoint {
  const alt = plan.alternatives[altName];
  if (!alt) throw new Error(`Alternative ${altName} not found`);
  const checkpointDate = (metadata as { date?: string }).date || new Date().toISOString().slice(0, 10);
  const timestamp = Date.now();
  const checkpointId = `${altName}_${checkpointDate}_${type}_${timestamp}`;

  const checkpoint: Checkpoint = {
    checkpointId,
    alt: altName,
    date: checkpointDate,
    type,
    assets: JSON.parse(JSON.stringify(alt.asset || [])),
    debts: JSON.parse(JSON.stringify(alt.debt || [])),
    income: JSON.parse(JSON.stringify(alt.income || [])),
    expenses: JSON.parse(JSON.stringify(alt.expense || [])),
    netWorth: calculateNetWorth(alt),
    provenance: (metadata as { provenance?: string }).provenance || 'user-entered',
    source: (metadata as { source?: string }).source || 'manual-input',
    confidence: (metadata as { confidence?: string }).confidence || 'high',
    createdAt: new Date().toISOString(),
    immutable: true,
    metadata: (metadata as { metadata?: Record<string, unknown> }).metadata || {}
  };

  if (!plan.checkpoints[altName]) {
    plan.checkpoints[altName] = [];
  }
  const checkpoints = plan.checkpoints[altName];
  const insertIndex = checkpoints.findIndex((cp) => cp.date > checkpoint.date);
  if (insertIndex === -1) {
    checkpoints.push(checkpoint);
  } else {
    checkpoints.splice(insertIndex, 0, checkpoint);
  }
  return checkpoint;
}

export function detectDrift(
  plan: PlanState,
  altName: string,
  currentNetWorth: number,
  projectedNetWorth: number
): { detected: boolean; variance?: number; daysSince?: number; checkpointDate?: string } | null {
  const lastCheckpoint = getLastCheckpoint(plan, altName);
  if (!lastCheckpoint) return null;
  if (!projectedNetWorth || projectedNetWorth === 0) return null;

  const daysSince = Math.floor(
    (new Date().getTime() - new Date(lastCheckpoint.date).getTime()) / (1000 * 60 * 60 * 24)
  );
  const variance = Math.abs(currentNetWorth - projectedNetWorth) / Math.abs(projectedNetWorth);
  const highVarianceThreshold = 0.25;

  if (daysSince < 30 && variance < highVarianceThreshold) {
    return null;
  }

  if (variance > plan.checkpointSettings.driftThreshold) {
    return {
      detected: true,
      variance,
      daysSince,
      checkpointDate: lastCheckpoint.date
    };
  }
  return { detected: false };
}

export function shouldCreateMonthlyCheckpoint(plan: PlanState, altName: string): boolean {
  if (!plan.checkpointSettings.autoCreateMonthly) return false;
  const lastCheckpoint = getLastCheckpoint(plan, altName);
  if (!lastCheckpoint) return true;
  const lastDate = new Date(lastCheckpoint.date);
  const today = new Date();
  const daysSince = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
  return daysSince >= 30;
}

export function createMonthlyCheckpointIfNeeded(plan: PlanState, altName: string) {
  if (shouldCreateMonthlyCheckpoint(plan, altName)) {
    return createCheckpoint(plan, altName, 'monthly', {
      provenance: 'user-entered',
      source: 'auto-monthly'
    });
  }
  return null;
}

