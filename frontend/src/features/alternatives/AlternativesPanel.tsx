import { useState } from 'react';
import { usePlanStore } from '../../lib/plan/planStore';
import type { Alternative } from '../../lib/plan/types';

export function AlternativesPanel() {
  const { state, dispatch } = usePlanStore();
  const [newAltName, setNewAltName] = useState('');

  const addAlternative = () => {
    const name = newAltName.trim() || `Alternative ${Object.keys(state.alternatives).length + 1}`;
    if (state.alternatives[name]) return;
    const baseline = state.alternatives[state.activeAlt] || { income: [], expense: [], asset: [], debt: [] };
    const clone: Alternative = JSON.parse(JSON.stringify(baseline));
    dispatch({ type: 'setAlternative', altName: name, alt: clone });
    dispatch({ type: 'setAltChartEnabled', altName: name, enabled: true });
    setNewAltName('');
  };

  const altNames = Object.keys(state.alternatives || {});

  return (
    <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Alternatives</h2>
        <div className="flex gap-2">
          <input
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            value={newAltName}
            placeholder="New alternative"
            onChange={(event) => setNewAltName(event.target.value)}
          />
          <button
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
            type="button"
            onClick={addAlternative}
          >
            Add
          </button>
        </div>
      </div>
      <div className="space-y-2">
        {altNames.map((name) => (
          <div key={name} className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950 p-2 text-xs text-slate-200">
            <button
              className="rounded border border-slate-700 px-2 py-1 text-xs"
              type="button"
              onClick={() => dispatch({ type: 'setActiveAlt', altName: name })}
            >
              {state.activeAlt === name ? 'Active' : 'Set active'}
            </button>
            <div className="flex-1 text-slate-100">{name}</div>
            <label className="flex items-center gap-1 text-slate-400">
              <input
                type="checkbox"
                checked={Boolean(state.altChartEnabled[name])}
                onChange={(event) =>
                  dispatch({ type: 'setAltChartEnabled', altName: name, enabled: event.target.checked })
                }
              />
              Chart
            </label>
            <input
              className="h-6 w-12 rounded border border-slate-700 bg-slate-900"
              type="color"
              value={state.altColors[name] || '#22c55e'}
              onChange={(event) => dispatch({ type: 'setAltColor', altName: name, color: event.target.value })}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
