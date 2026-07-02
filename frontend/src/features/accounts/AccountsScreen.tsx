import { AccountsTables } from './AccountsTables';
import { usePlanStore } from '../../lib/plan/planStore';
import type { Alternative } from '../../lib/plan/types';

export function AccountsScreen() {
  const { state: planState, dispatch } = usePlanStore();
  const activeAlt = planState.activeAlt;
  const alt = planState.alternatives[activeAlt];
  const altNames = Object.keys(planState.alternatives || {});

  const handleChange = (next: Alternative) => {
    dispatch({ type: 'setAlternative', altName: activeAlt, alt: next });
  };

  const renameAlternative = (oldName: string, newName: string) => {
    if (!newName || oldName === newName || planState.alternatives[newName]) return;
    const nextPlan = JSON.parse(JSON.stringify(planState));
    nextPlan.alternatives[newName] = nextPlan.alternatives[oldName];
    delete nextPlan.alternatives[oldName];
    nextPlan.altChartEnabled[newName] = nextPlan.altChartEnabled[oldName];
    delete nextPlan.altChartEnabled[oldName];
    if (nextPlan.altColors[oldName]) {
      nextPlan.altColors[newName] = nextPlan.altColors[oldName];
      delete nextPlan.altColors[oldName];
    }
    if (nextPlan.goals[oldName]) {
      nextPlan.goals[newName] = nextPlan.goals[oldName];
      delete nextPlan.goals[oldName];
    }
    if (nextPlan.pipeline.byAlt[oldName]) {
      nextPlan.pipeline.byAlt[newName] = nextPlan.pipeline.byAlt[oldName];
      delete nextPlan.pipeline.byAlt[oldName];
    }
    if (nextPlan.checkpoints[oldName]) {
      nextPlan.checkpoints[newName] = nextPlan.checkpoints[oldName];
      delete nextPlan.checkpoints[oldName];
    }
    if (nextPlan.activeAlt === oldName) {
      nextPlan.activeAlt = newName;
    }
    dispatch({ type: 'hydrate', plan: nextPlan });
  };

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-8 text-slate-200">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
          <h1 className="text-2xl font-semibold text-slate-100">Accounts</h1>
        </div>

        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5" data-tour="account-alternatives">
          <h2 className="text-sm font-semibold text-slate-200">Account Alternatives</h2>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-300">
            <label className="flex items-center gap-2">
              Active:
              <select
                className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                value={activeAlt}
                onChange={(event) => dispatch({ type: 'setActiveAlt', altName: event.target.value })}
              >
                {altNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
              type="button"
              onClick={() => {
                const name = `Alternative ${altNames.length + 1}`;
                if (planState.alternatives[name]) return;
                const nextPlan = JSON.parse(JSON.stringify(planState));
                nextPlan.alternatives[name] = { income: [], expense: [], asset: [], debt: [] };
                nextPlan.altChartEnabled[name] = true;
                nextPlan.activeAlt = name;
                dispatch({ type: 'hydrate', plan: nextPlan });
              }}
            >
              New
            </button>
            <button
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
              type="button"
              onClick={() => {
                const name = window.prompt('Clone alternative name', `${activeAlt} Copy`);
                if (!name || planState.alternatives[name]) return;
                const nextPlan = JSON.parse(JSON.stringify(planState));
                nextPlan.alternatives[name] = JSON.parse(JSON.stringify(alt));
                nextPlan.altChartEnabled[name] = true;
                nextPlan.activeAlt = name;
                dispatch({ type: 'hydrate', plan: nextPlan });
              }}
            >
              Clone
            </button>
            <button
              className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200"
              type="button"
              onClick={() => {
                const name = window.prompt('Rename alternative', activeAlt);
                if (!name) return;
                renameAlternative(activeAlt, name.trim());
              }}
            >
              Rename
            </button>
            <label className="flex items-center gap-2 rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-200">
              Color
              <input
                type="color"
                value={planState.altColors[activeAlt] || '#22c55e'}
                onChange={(event) =>
                  dispatch({ type: 'setAltColor', altName: activeAlt, color: event.target.value })
                }
              />
            </label>
            <button
              className="rounded-md border border-rose-500/60 px-2 py-1 text-xs text-rose-200"
              type="button"
              onClick={() => {
                if (altNames.length <= 1) return;
                if (!window.confirm(`Delete alternative "${activeAlt}"?`)) return;
                const nextPlan = JSON.parse(JSON.stringify(planState));
                delete nextPlan.alternatives[activeAlt];
                delete nextPlan.altChartEnabled[activeAlt];
                delete nextPlan.altColors[activeAlt];
                nextPlan.activeAlt = Object.keys(nextPlan.alternatives)[0];
                dispatch({ type: 'hydrate', plan: nextPlan });
              }}
              disabled={altNames.length <= 1}
            >
              Delete
            </button>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            &quot;Baseline&quot; is your default plan. Switch to edit another alternative&apos;s accounts.
          </div>
        </section>
        {alt ? (
          <AccountsTables alt={alt} onChange={handleChange} />
        ) : (
          <div className="rounded-lg border border-dashed border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-400">
            No alternative selected.
          </div>
        )}
      </div>
    </div>
  );
}
