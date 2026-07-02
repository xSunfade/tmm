import React from 'react';
import type { Frequency, PipelineEdge } from '../../lib/plan/types';

type FlowDetailsModalProps = {
  open: boolean;
  defaults: { amount: string; freq: Frequency; recurFreq: Frequency };
  isAssetFlow: boolean;
  onCancel: () => void;
  onSave: (result: { mode: PipelineEdge['mode']; amount: number; freq: Frequency; recurFreq?: Frequency }) => void;
  onDelete?: () => void;
};

export function FlowDetailsModal({ open, defaults, isAssetFlow, onCancel, onSave, onDelete }: FlowDetailsModalProps) {
  const [amount, setAmount] = React.useState(defaults.amount);
  const [freq, setFreq] = React.useState<Frequency>(defaults.freq);
  const [recurFreq, setRecurFreq] = React.useState<Frequency>(defaults.recurFreq);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setAmount(defaults.amount);
    setFreq(defaults.freq);
    setRecurFreq(defaults.recurFreq);
    setError('');
  }, [defaults.amount, defaults.freq, defaults.recurFreq, open]);

  if (!open) return null;

  const isPercent = amount.trim().endsWith('%');

  const handleSave = () => {
    const raw = amount.trim();
    if (!raw) {
      setError('Enter an amount or percent.');
      return;
    }
    const numeric = Number(raw.replace('%', '').trim());
    if (!Number.isFinite(numeric) || numeric <= 0) {
      setError('Enter a valid positive amount.');
      return;
    }
    const mode = isPercent ? 'percent' : 'fixed';
    onSave({
      mode,
      amount: numeric,
      freq,
      recurFreq: isAssetFlow ? recurFreq : undefined
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-5 text-slate-200 shadow-xl">
        <h3 className="text-sm font-semibold text-slate-100">Flow Details</h3>
        <div className="mt-4 space-y-3 text-xs text-slate-300">
          <label className="flex flex-col gap-1">
            Amount or %
            <input
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
              value={amount}
              placeholder="200 or 10%"
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            Frequency
            <select
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
              value={freq}
              onChange={(event) => setFreq(event.target.value as Frequency)}
              disabled={isPercent}
            >
              <option value="monthly">Monthly</option>
              <option value="biweekly">Biweekly</option>
              <option value="weekly">Weekly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>
          {isAssetFlow ? (
            <label className="flex flex-col gap-1">
              Recurring Frequency
              <select
                className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
                value={recurFreq}
                onChange={(event) => setRecurFreq(event.target.value as Frequency)}
              >
                <option value="monthly">Monthly</option>
                <option value="biweekly">Biweekly</option>
                <option value="weekly">Weekly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
          ) : null}
          <div className="text-[11px] text-slate-500">
            Tip: enter a percentage (e.g., 10%) to allocate from source income. Frequency is ignored for % flows.
          </div>
          {error ? <div className="text-[11px] text-rose-300">{error}</div> : null}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 text-xs">
          <button className="rounded-md border border-slate-700 px-3 py-2 text-slate-200" type="button" onClick={onCancel}>
            Cancel
          </button>
          {onDelete ? (
            <button className="rounded-md border border-rose-500/60 px-3 py-2 text-rose-200" type="button" onClick={onDelete}>
              Delete
            </button>
          ) : null}
          <button
            className="rounded-md bg-[color:var(--accent)] px-3 py-2 text-xs font-semibold text-slate-950"
            type="button"
            onClick={handleSave}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
