import { usePlanStore } from '../../lib/plan/planStore';
import type { Goal } from '../../lib/plan/types';
import { getEffectiveValue } from '../../lib/plan/overrideManager';

const GOAL_TYPES = {
  NET_WORTH: 'net-worth',
  SAVINGS: 'savings',
  DEBT_PAYOFF: 'debt-payoff',
  CUSTOM: 'custom'
};

const formatCurrency = (value: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);

const findEntityByReference = (alt: any, ref: any) => {
  if (!ref) return null;
  const entityType = ref.entityType || ref.type;
  const entityId = ref.entityId || ref.uuid || ref.id;
  if (!entityType || !entityId) return null;
  return (alt?.[entityType] || []).find((e: any) => e.uuid === entityId) || null;
};

const calculateGoalProgress = (alt: any, goal: Goal) => {
  if (!goal || !alt) return 0;
  switch (goal.type) {
    case GOAL_TYPES.NET_WORTH: {
      const assets = (alt.asset || []).reduce((sum: number, a: any) => sum + (getEffectiveValue(a) || 0), 0);
      const debts = (alt.debt || []).reduce((sum: number, d: any) => sum + (getEffectiveValue(d) || 0), 0);
      return assets - debts;
    }
    case GOAL_TYPES.SAVINGS: {
      if (goal.relatedAccounts && goal.relatedAccounts.length > 0) {
        return goal.relatedAccounts.reduce((sum: number, ref: any) => {
          const entity = findEntityByReference(alt, ref);
          return entity ? sum + (getEffectiveValue(entity) || 0) : sum;
        }, 0);
      }
      return (alt.asset || []).reduce((sum: number, a: any) => sum + (getEffectiveValue(a) || 0), 0);
    }
    case GOAL_TYPES.DEBT_PAYOFF: {
      if (goal.relatedAccounts && goal.relatedAccounts.length > 0) {
        return goal.relatedAccounts.reduce((sum: number, ref: any) => {
          const entity = findEntityByReference(alt, ref);
          return entity ? sum + (getEffectiveValue(entity) || 0) : sum;
        }, 0);
      }
      return (alt.debt || []).reduce((sum: number, d: any) => sum + (getEffectiveValue(d) || 0), 0);
    }
    case GOAL_TYPES.CUSTOM: {
      if (goal.relatedAccounts && goal.relatedAccounts.length > 0) {
        return goal.relatedAccounts.reduce((sum: number, ref: any) => {
          const entity = findEntityByReference(alt, ref);
          return entity ? sum + (getEffectiveValue(entity) || 0) : sum;
        }, 0);
      }
      return 0;
    }
    default:
      return 0;
  }
};

const getGoalProgressPercentage = (goal: Goal, currentValue: number) => {
  if (!goal.targetValue) return 0;
  if (goal.type === GOAL_TYPES.DEBT_PAYOFF) {
    const initialDebt = (goal.metadata as any)?.initialDebt || goal.targetValue;
    if (initialDebt <= 0) return 100;
    const paidOff = initialDebt - currentValue;
    return Math.min(100, Math.max(0, (paidOff / initialDebt) * 100));
  }
  if (goal.targetValue <= 0) return 0;
  return Math.min(100, Math.max(0, (currentValue / goal.targetValue) * 100));
};

const getGoalStatus = (goal: Goal, currentValue: number) => {
  const progress = getGoalProgressPercentage(goal, currentValue);
  const remaining = Math.max(0, goal.targetValue - currentValue);
  let text = '';
  if (goal.type === GOAL_TYPES.DEBT_PAYOFF) {
    const initialDebt = (goal.metadata as any)?.initialDebt || goal.targetValue;
    const paidOff = initialDebt - currentValue;
    text = `Paid off ${formatCurrency(paidOff)} of ${formatCurrency(initialDebt)} (${progress.toFixed(1)}%)`;
  } else {
    text = `${progress.toFixed(1)}% complete — ${formatCurrency(remaining)} remaining`;
  }
  const isComplete = progress >= 100;
  if (isComplete) text = 'Goal achieved!';
  let timeStatus = '';
  if (goal.targetDate) {
    const targetDate = new Date(goal.targetDate);
    const today = new Date();
    const daysRemaining = Math.ceil((targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    if (daysRemaining < 0) {
      timeStatus = `${Math.abs(daysRemaining)} days overdue`;
    } else if (daysRemaining === 0) {
      timeStatus = 'Due today';
    } else if (daysRemaining <= 7) {
      timeStatus = `${daysRemaining} days remaining`;
    } else {
      const weeks = Math.floor(daysRemaining / 7);
      timeStatus = `${weeks} weeks remaining`;
    }
  }
  return { text, progress, timeStatus, isComplete };
};

const todayIso = () => new Date().toISOString().slice(0, 10);

function createGoal(): Goal {
  return {
    id: `goal_${Date.now().toString(36)}`,
    name: '',
    type: 'custom',
    targetValue: 0,
    targetDate: todayIso(),
    createdAt: new Date().toISOString()
  };
}

export function GoalsScreen() {
  const { state, dispatch } = usePlanStore();
  const activeAlt = state.activeAlt;
  const goals = state.goals[activeAlt] || [];
  const alt = state.alternatives[activeAlt];

  const updateGoal = (id: string, next: Partial<Goal>) => {
    const updated = goals.map((goal) => (goal.id === id ? { ...goal, ...next } : goal));
    dispatch({ type: 'setGoals', altName: activeAlt, goals: updated });
  };

  const addGoal = () => {
    dispatch({ type: 'setGoals', altName: activeAlt, goals: [...goals, createGoal()] });
  };

  const removeGoal = (id: string) => {
    dispatch({ type: 'setGoals', altName: activeAlt, goals: goals.filter((goal) => goal.id !== id) });
  };

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-200">
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h1 className="text-2xl font-semibold text-slate-100" data-tour="goals-header">
            Goals
          </h1>
        </div>

        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">Financial Goals</h2>
            <button
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
              type="button"
              onClick={addGoal}
            >
              + Add Goal
            </button>
          </div>
          <div className="mt-4">
            {goals.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/40 p-8 text-center text-sm text-slate-400">
                No goals yet. Create a goal to track your financial progress!
              </div>
            ) : (
              <div className="space-y-4">
                {goals.map((goal) => {
                  const currentValue = calculateGoalProgress(alt, goal);
                  const status = getGoalStatus(goal, currentValue);
                  return (
                    <div key={goal.id} className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <input
                            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
                            value={goal.name}
                            placeholder="Goal name"
                            onChange={(event) => updateGoal(goal.id, { name: event.target.value })}
                          />
                          <textarea
                            className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                            placeholder="Description (optional)"
                            value={goal.description || ''}
                            onChange={(event) => updateGoal(goal.id, { description: event.target.value })}
                          />
                          <div className="mt-2 text-[11px] text-slate-400">
                            Type: {goal.type} • Target: {formatCurrency(goal.targetValue)}
                            {goal.targetDate ? ` • Due: ${new Date(goal.targetDate).toLocaleDateString()}` : ''}
                          </div>
                        </div>
                        <button
                          className="rounded-md border border-rose-500/60 px-2 py-1 text-xs text-rose-200"
                          type="button"
                          onClick={() => removeGoal(goal.id)}
                        >
                          ✕
                        </button>
                      </div>
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-xs text-slate-400">
                          <span>Progress</span>
                          <span className="text-sm font-semibold text-slate-200">{status.progress.toFixed(1)}%</span>
                        </div>
                        <div className="mt-1 h-2 rounded-full bg-slate-800">
                          <div
                            className="h-full rounded-full bg-cyan-500"
                            style={{ width: `${Math.min(100, status.progress)}%` }}
                          />
                        </div>
                        <div className="mt-2 text-[11px] text-slate-400">
                          {status.text} {status.timeStatus ? `• ${status.timeStatus}` : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
