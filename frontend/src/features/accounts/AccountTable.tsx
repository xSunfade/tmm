import type { AccountRow } from './legacyAdapters';

type AccountTableProps = {
  title: string;
  rows: AccountRow[];
  onAdd: () => void;
  onUpdate: (id: string, next: Partial<AccountRow>) => void;
  onRemove: (id: string) => void;
};

export function AccountTable({ title, rows, onAdd, onUpdate, onRemove }: AccountTableProps) {
  return (
    <section className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
        <button
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
          type="button"
          onClick={onAdd}
        >
          Add row
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-400">No rows yet.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.id}
              className="grid gap-2 rounded-md border border-slate-800 bg-slate-950 p-3 md:grid-cols-[2fr_1fr_2fr_auto]"
            >
              <input
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                value={row.name}
                placeholder="Name"
                onChange={(event) => onUpdate(row.id, { name: event.target.value })}
              />
              <input
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                type="number"
                inputMode="decimal"
                value={row.amount}
                placeholder="Amount"
                onChange={(event) =>
                  onUpdate(row.id, { amount: Number(event.target.value) || 0 })
                }
              />
              <input
                className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                value={row.notes ?? ''}
                placeholder="Notes"
                onChange={(event) => onUpdate(row.id, { notes: event.target.value })}
              />
              <button
                className="rounded-md border border-rose-500/60 bg-rose-500/10 px-2 py-1 text-xs text-rose-200"
                type="button"
                onClick={() => onRemove(row.id)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
