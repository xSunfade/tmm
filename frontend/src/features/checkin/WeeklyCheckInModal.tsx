import { useMemo, useState } from 'react';
import type { Alternative } from '../../lib/plan/types';
import { getEffectiveValue, applyManualOverride } from '../../lib/plan/overrideManager';

type WeeklyCheckInModalProps = {
  altName: string;
  alt: Alternative;
  onApply: (nextAlt: Alternative) => void;
  onClose: () => void;
};

type UpdateMap = Record<string, number>;

export function WeeklyCheckInModal({ altName: _altName, alt, onApply, onClose }: WeeklyCheckInModalProps) {
  const [updates, setUpdates] = useState<UpdateMap>({});

  const rows = useMemo(() => {
    const items: Array<{ key: string; label: string; value: number; type: string }> = [];
    alt.income.forEach((row, idx) => {
      items.push({ key: `income_${idx}`, label: row.name || `Income ${idx + 1}`, value: getEffectiveValue(row), type: 'income' });
    });
    alt.expense.forEach((row, idx) => {
      items.push({ key: `expense_${idx}`, label: row.name || `Expense ${idx + 1}`, value: getEffectiveValue(row), type: 'expense' });
    });
    alt.asset.forEach((row, idx) => {
      items.push({ key: `asset_${idx}`, label: row.name || `Asset ${idx + 1}`, value: getEffectiveValue(row), type: 'asset' });
    });
    alt.debt.forEach((row, idx) => {
      items.push({ key: `debt_${idx}`, label: row.name || `Debt ${idx + 1}`, value: getEffectiveValue(row), type: 'debt' });
    });
    return items;
  }, [alt]);

  const applyUpdates = () => {
    const nextAlt = JSON.parse(JSON.stringify(alt)) as Alternative;
    Object.entries(updates).forEach(([key, value]) => {
      const [type, idxStr] = key.split('_');
      const idx = Number(idxStr);
      if (type === 'income' && nextAlt.income[idx]) {
        applyManualOverride(nextAlt.income[idx], value);
        nextAlt.income[idx].amount = value;
      }
      if (type === 'expense' && nextAlt.expense[idx]) {
        applyManualOverride(nextAlt.expense[idx], value);
        nextAlt.expense[idx].amount = value;
      }
      if (type === 'asset' && nextAlt.asset[idx]) {
        applyManualOverride(nextAlt.asset[idx], value);
        nextAlt.asset[idx].value = value;
      }
      if (type === 'debt' && nextAlt.debt[idx]) {
        applyManualOverride(nextAlt.debt[idx], value);
        nextAlt.debt[idx].bal = value;
      }
    });
    onApply(nextAlt);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
      <div className="w-full max-w-3xl rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-200">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Weekly Check-In</h2>
          <button
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <p className="mt-2 text-sm text-slate-400">
          Update recent values to keep your plan aligned with reality.
        </p>
        <div className="mt-4 max-h-[420px] space-y-3 overflow-y-auto">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center justify-between gap-4 rounded-md border border-slate-800 bg-slate-950 p-3">
              <div>
                <div className="text-sm font-semibold text-slate-100">{row.label}</div>
                <div className="text-xs text-slate-500">{row.type}</div>
              </div>
              <input
                className="w-36 rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
                type="number"
                defaultValue={row.value}
                onChange={(event) =>
                  setUpdates((prev) => ({ ...prev, [row.key]: Number(event.target.value) || 0 }))
                }
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-3">
          <button
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-white"
            type="button"
            onClick={applyUpdates}
          >
            Save check-in
          </button>
        </div>
      </div>
    </div>
  );
}
