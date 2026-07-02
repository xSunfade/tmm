import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { Alternative, AssetRow, DebtRow, ExpenseRow, IncomeRow } from '../../lib/plan/types';
import { usePlanStore } from '../../lib/plan/planStore';
import { searchTickers, type TickerSearchResult } from '../../lib/finnhub/tickerSearch';

type NodePropertiesModalProps = {
  open: boolean;
  nodeId: string | null;
  alt: Alternative;
  onClose: () => void;
  onSave: (nextAlt: Alternative) => void;
  onDelete: (nodeId: string) => void;
};

type NodeKind = 'income' | 'expense' | 'asset' | 'debt';

const DEBOUNCE_MS = 250;

type TickerSearchInputProps = {
  ticker: string;
  name: string;
  finnhubKey: string;
  onSelect: (ticker: string, name: string) => void;
};

function TickerSearchInput({ ticker, name, finnhubKey, onSelect }: TickerSearchInputProps) {
  const [query, setQuery] = useState(ticker || name || '');
  const [results, setResults] = useState<TickerSearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [showNoKeyWarning, setShowNoKeyWarning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(ticker || name || '');
  }, [ticker, name]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const doSearch = useCallback(
    async (q: string) => {
      if (!q.trim() || !finnhubKey.trim()) return;
      const items = await searchTickers(q, finnhubKey);
      setResults(items);
      setShowDropdown(items.length > 0);
    },
    [finnhubKey]
  );

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!query.trim()) {
      setResults([]);
      setShowDropdown(false);
      return;
    }
    timerRef.current = setTimeout(() => doSearch(query), DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, doSearch]);

  return (
    <div ref={containerRef} className="relative">
      <input
        className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100"
        placeholder="Search ticker (AAPL, SPY, BINANCE:BTCUSDT)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => {
          if (!finnhubKey.trim()) setShowNoKeyWarning(true);
        }}
        onBlur={() => setShowNoKeyWarning(false)}
      />
      {showNoKeyWarning ? (
        <div className="absolute left-0 top-full z-10 mt-1 rounded border border-amber-600/50 bg-amber-950/90 px-2 py-1 text-[11px] text-amber-200">
          Finnhub API key required for ticker search and live prices. Add it in Settings.
        </div>
      ) : null}
      {showDropdown && results.length > 0 ? (
        <div className="absolute left-0 top-full z-10 mt-1 max-h-40 w-full overflow-auto rounded border border-slate-700 bg-slate-950">
          {results.map((it) => (
            <div
              key={it.symbol}
              className="cursor-pointer px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
              onClick={() => {
                onSelect(it.symbol, it.description || it.symbol);
                setQuery(it.symbol);
                setShowDropdown(false);
              }}
            >
              {it.symbol} — {it.description || ''}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function NodePropertiesModal({ open, nodeId, alt, onClose, onSave, onDelete }: NodePropertiesModalProps) {
  const { state: planState } = usePlanStore();
  const [form, setForm] = React.useState<Record<string, any>>({});
  const [kind, setKind] = React.useState<NodeKind>('income');
  const [index, setIndex] = React.useState(0);

  React.useEffect(() => {
    if (!open || !nodeId) return;
    const [nextKind, idxStr] = nodeId.split(':') as [NodeKind, string];
    const idx = Number(idxStr);
    setKind(nextKind);
    setIndex(Number.isFinite(idx) ? idx : 0);
    if (nextKind === 'income') {
      const row = alt.income[idx] || ({} as IncomeRow);
      setForm({
        name: row.name || '',
        amount: row.amount ?? 0,
        freq: row.freq || 'monthly',
        start: row.start || new Date().toISOString().slice(0, 10),
        raise: row.raise ?? 0
      });
    }
    if (nextKind === 'expense') {
      const row = alt.expense[idx] || ({} as ExpenseRow);
      setForm({
        name: row.name || '',
        amount: row.amount ?? 0,
        freq: row.freq || 'monthly',
        start: row.start || new Date().toISOString().slice(0, 10),
        infl: row.infl ?? 0,
        source: row.source || ''
      });
    }
    if (nextKind === 'asset') {
      const row = alt.asset[idx] || ({} as AssetRow);
      setForm({
        mode: row.mode || 'Manual',
        name: row.name || '',
        group: row.group || '',
        value: row.value ?? 0,
        apy: row.apy ?? 0,
        ticker: row.ticker || '',
        quantity: row.quantity ?? 0,
        liveprice: row.liveprice ?? 0,
        totalContrib: row.totalContrib ?? 0,
        recurAmt: row.recurAmt ?? 0,
        recurFreq: row.recurFreq || 'monthly',
        source: row.source || ''
      });
    }
    if (nextKind === 'debt') {
      const row = alt.debt[idx] || ({} as DebtRow);
      setForm({
        name: row.name || '',
        bal: row.bal ?? 0,
        apr: row.apr ?? 0,
        pmt: row.pmt ?? 0,
        freq: row.freq || 'monthly',
        start: row.start || new Date().toISOString().slice(0, 10),
        source: row.source || ''
      });
    }
  }, [alt, nodeId, open]);

  if (!open || !nodeId) return null;

  const update = (key: string, value: any) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => {
    const nextAlt = JSON.parse(JSON.stringify(alt)) as Alternative;
    if (kind === 'income' && nextAlt.income[index]) {
      nextAlt.income[index] = {
        ...nextAlt.income[index],
        name: String(form.name || ''),
        amount: Number(form.amount) || 0,
        freq: form.freq as IncomeRow['freq'],
        start: String(form.start || ''),
        raise: Number(form.raise) || 0
      };
    }
    if (kind === 'expense' && nextAlt.expense[index]) {
      nextAlt.expense[index] = {
        ...nextAlt.expense[index],
        name: String(form.name || ''),
        amount: Number(form.amount) || 0,
        freq: form.freq as ExpenseRow['freq'],
        start: String(form.start || ''),
        infl: Number(form.infl) || 0,
        source: String(form.source || '')
      };
    }
    if (kind === 'asset' && nextAlt.asset[index]) {
      nextAlt.asset[index] = {
        ...nextAlt.asset[index],
        mode: form.mode as AssetRow['mode'],
        name: String(form.name || ''),
        group: String(form.group || ''),
        value: Number(form.value) || 0,
        apy: Number(form.apy) || 0,
        ticker: String(form.ticker || ''),
        quantity: Number(form.quantity) || 0,
        liveprice: Number(form.liveprice) || 0,
        totalContrib: Number(form.totalContrib) || 0,
        recurAmt: Number(form.recurAmt) || 0,
        recurFreq: form.recurFreq as AssetRow['recurFreq'],
        source: String(form.source || '')
      };
    }
    if (kind === 'debt' && nextAlt.debt[index]) {
      nextAlt.debt[index] = {
        ...nextAlt.debt[index],
        name: String(form.name || ''),
        bal: Number(form.bal) || 0,
        apr: Number(form.apr) || 0,
        pmt: Number(form.pmt) || 0,
        freq: form.freq as DebtRow['freq'],
        start: String(form.start || ''),
        source: String(form.source || '')
      };
    }
    onSave(nextAlt);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-slate-900 p-5 text-slate-200 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">Node Properties</h3>
          <button className="text-xs text-slate-400" type="button" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="mt-4 space-y-3 text-xs text-slate-300">
          {kind === 'income' ? (
            <>
              <label className="flex flex-col gap-1">
                Name
                <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.name} onChange={(e) => update('name', e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Amount
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.amount} onChange={(e) => update('amount', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  Frequency
                  <select className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.freq} onChange={(e) => update('freq', e.target.value)}>
                    <option value="monthly">Monthly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="weekly">Weekly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Start Date
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="date" value={form.start} onChange={(e) => update('start', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  Annual Raise %
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.raise} onChange={(e) => update('raise', e.target.value)} />
                </label>
              </div>
            </>
          ) : null}
          {kind === 'expense' ? (
            <>
              <label className="flex flex-col gap-1">
                Name
                <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.name} onChange={(e) => update('name', e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Amount
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.amount} onChange={(e) => update('amount', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  Frequency
                  <select className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.freq} onChange={(e) => update('freq', e.target.value)}>
                    <option value="monthly">Monthly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="weekly">Weekly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Start Date
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="date" value={form.start} onChange={(e) => update('start', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  Inflation %/yr
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.infl} onChange={(e) => update('infl', e.target.value)} />
                </label>
              </div>
              <label className="flex flex-col gap-1">
                Source
                <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.source} onChange={(e) => update('source', e.target.value)} />
              </label>
            </>
          ) : null}
          {kind === 'asset' ? (
            <>
              <label className="flex flex-col gap-1">
                Mode
                <select className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.mode} onChange={(e) => update('mode', e.target.value)}>
                  <option value="Manual">Manual</option>
                  <option value="APY">APY</option>
                  <option value="Ticker">Ticker</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Name
                <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.name} onChange={(e) => update('name', e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Group
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.group} onChange={(e) => update('group', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  Current Value
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.value} onChange={(e) => update('value', e.target.value)} />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  APY %
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.apy} onChange={(e) => update('apy', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  Source
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.source} onChange={(e) => update('source', e.target.value)} />
                </label>
              </div>
              {form.mode === 'Ticker' ? (
                <div className="grid grid-cols-2 gap-3">
                  <label className="col-span-2 flex flex-col gap-1">
                    Ticker
                    <TickerSearchInput
                      ticker={form.ticker}
                      name={form.name}
                      finnhubKey={planState.assumptions?.finnhubKey ?? ''}
                      onSelect={(ticker, name) => {
                        update('ticker', ticker);
                        update('name', name);
                      }}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    Quantity
                    <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.quantity} onChange={(e) => update('quantity', e.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1">
                    Live Price
                    <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.liveprice} onChange={(e) => update('liveprice', e.target.value)} />
                  </label>
                  <label className="flex flex-col gap-1">
                    Total Contribution
                    <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.totalContrib} onChange={(e) => update('totalContrib', e.target.value)} />
                  </label>
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Recurring Contribution
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.recurAmt} onChange={(e) => update('recurAmt', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  Frequency
                  <select className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.recurFreq} onChange={(e) => update('recurFreq', e.target.value)}>
                    <option value="monthly">Monthly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="weekly">Weekly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </label>
              </div>
            </>
          ) : null}
          {kind === 'debt' ? (
            <>
              <label className="flex flex-col gap-1">
                Name
                <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.name} onChange={(e) => update('name', e.target.value)} />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Balance
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.bal} onChange={(e) => update('bal', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  APR %
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.apr} onChange={(e) => update('apr', e.target.value)} />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Payment
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="number" value={form.pmt} onChange={(e) => update('pmt', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  Frequency
                  <select className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.freq} onChange={(e) => update('freq', e.target.value)}>
                    <option value="monthly">Monthly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="weekly">Weekly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  Start Date
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" type="date" value={form.start} onChange={(e) => update('start', e.target.value)} />
                </label>
                <label className="flex flex-col gap-1">
                  Source
                  <input className="rounded-md border border-slate-700 bg-slate-950 px-2 py-2 text-xs text-slate-100" value={form.source} onChange={(e) => update('source', e.target.value)} />
                </label>
              </div>
            </>
          ) : null}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 text-xs">
          <button className="rounded-md border border-slate-700 px-3 py-2 text-slate-200" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rounded-md border border-rose-500/60 px-3 py-2 text-rose-200"
            type="button"
            onClick={() => {
              if (window.confirm('Delete this node?')) {
                onDelete(nodeId);
              }
            }}
          >
            Delete
          </button>
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
