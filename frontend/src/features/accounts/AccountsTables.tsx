import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { Alternative, IncomeRow, ExpenseRow, AssetRow, DebtRow } from '../../lib/plan/types';
import { usePlanStore } from '../../lib/plan/planStore';
import { searchTickers, fetchQuote, type TickerSearchResult } from '../../lib/finnhub/tickerSearch';
import { getEffectiveValue } from '../../lib/plan/overrideManager';
import { loadMockAccountsOnly } from '../accountIntegration/legacyAdapters';

type AccountsTablesProps = {
  alt: Alternative;
  onChange: (next: Alternative) => void;
};

type TickerSearchCellProps = {
  ticker: string;
  name: string;
  finnhubKey: string;
  onSelect: (ticker: string, name: string, livePrice: number | null) => void;
};

function TickerSearchCell({ ticker, name, finnhubKey, onSelect }: TickerSearchCellProps) {
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

  const handleFocus = () => {
    if (!finnhubKey.trim()) {
      setShowNoKeyWarning(true);
    }
  };

  const handleBlur = () => {
    setShowNoKeyWarning(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
        placeholder="Search ticker (AAPL, SPY, BINANCE:BTCUSDT)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
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
              onClick={async () => {
                const livePrice = await fetchQuote(it.symbol, finnhubKey);
                onSelect(it.symbol, it.description || it.symbol, livePrice);
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

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

const DEBOUNCE_MS = 250;

function PlaidRowIndicator() {
  return (
    <div className="flex w-9 flex-col items-center text-blue-400" title="Linked to Plaid">
      <span className="text-[9px] font-semibold leading-none tracking-wide">PLAID</span>
      <svg
        className="mt-0.5 h-3 w-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </div>
  );
}

export function AccountsTables({ alt, onChange }: AccountsTablesProps) {
  const { state: planState } = usePlanStore();
  const finnhubKey = planState.assumptions?.finnhubKey ?? '';
  const isConnectedRow = (row: { dataSource?: string; connectedAccountId?: string }) =>
    row.dataSource === 'connected' && Boolean(row.connectedAccountId);
  const mockAccountIds = useMemo(() => {
    const ids = new Set<string>();
    for (const account of loadMockAccountsOnly()) {
      if (account.id) ids.add(account.id);
      if (account.accountId) ids.add(account.accountId);
    }
    return ids;
  }, []);
  const isPlaidConnectedAsset = (row: AssetRow) =>
    isConnectedRow(row) &&
    Boolean(row.connectedAccountId) &&
    !mockAccountIds.has(row.connectedAccountId!);
  const handleConnectedRowMouseMove = (event: React.MouseEvent<HTMLTableRowElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeX = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
    const clamped = Math.max(0, Math.min(100, relativeX));
    event.currentTarget.style.setProperty('--connected-mx', `${clamped}%`);
  };

  const updateIncome = (updater: (rows: IncomeRow[]) => IncomeRow[]) => {
    onChange({ ...alt, income: updater(alt.income) });
  };
  const updateExpense = (updater: (rows: ExpenseRow[]) => ExpenseRow[]) => {
    onChange({ ...alt, expense: updater(alt.expense) });
  };
  const updateAsset = (updater: (rows: AssetRow[]) => AssetRow[]) => {
    onChange({ ...alt, asset: updater(alt.asset) });
  };
  const updateDebt = (updater: (rows: DebtRow[]) => DebtRow[]) => {
    onChange({ ...alt, debt: updater(alt.debt) });
  };

  const groups = alt.asset.reduce<Record<string, number>>((acc, asset) => {
    const key = asset.group?.trim() || '';
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + (Number(asset.value) || 0);
    return acc;
  }, {});

  return (
    <div className="space-y-6" data-tour="accounts-tables">
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">Income</h2>
          <button
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
            type="button"
            onClick={() =>
              updateIncome((rows) => [
                ...rows,
                {
                  uuid: makeId('income'),
                  name: '',
                  amount: 0,
                  freq: 'monthly',
                  start: new Date().toISOString().slice(0, 10),
                  raise: 0
                }
              ])
            }
          >
            + Add
          </button>
        </div>
        <table className="mt-4 w-full text-xs text-slate-200">
          <thead>
            <tr className="text-left text-slate-400">
              <th className="py-2">Name</th>
              <th>Amount</th>
              <th>Frequency</th>
              <th>Start</th>
              <th>Annual Raise %</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {alt.income.map((row, index) => {
              const connected = isConnectedRow(row);
              const effectiveAmount = getEffectiveValue(row);
              return (
              <tr
                key={row.uuid}
                className={`border-t border-slate-800 ${connected ? 'connected-live-outline' : ''}`}
                onMouseMove={connected ? handleConnectedRowMouseMove : undefined}
              >
                <td className="py-2">
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    value={row.name}
                    onChange={(event) =>
                      updateIncome((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r))
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="number"
                    value={connected ? effectiveAmount : row.amount}
                    disabled={connected}
                    onChange={(event) =>
                      updateIncome((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, amount: Number(event.target.value) || 0 } : r
                        )
                      )
                    }
                  />
                </td>
                <td>
                  <select
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    value={row.freq}
                    onChange={(event) =>
                      updateIncome((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, freq: event.target.value as IncomeRow['freq'] } : r))
                      )
                    }
                  >
                    <option value="monthly">Monthly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="weekly">Weekly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="date"
                    value={row.start}
                    onChange={(event) =>
                      updateIncome((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, start: event.target.value } : r))
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="number"
                    value={row.raise || 0}
                    onChange={(event) =>
                      updateIncome((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, raise: Number(event.target.value) || 0 } : r
                        )
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    className="rounded-md border border-rose-500/60 px-2 py-1 text-xs text-rose-200"
                    type="button"
                    onClick={() => updateIncome((rows) => rows.filter((_, i) => i !== index))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
              );
            })}
            {alt.income.length === 0 ? (
              <tr>
                <td className="py-3 text-slate-500" colSpan={6}>
                  No income rows yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">Expenses</h2>
          <button
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
            type="button"
            onClick={() =>
              updateExpense((rows) => [
                ...rows,
                {
                  uuid: makeId('expense'),
                  name: '',
                  amount: 0,
                  freq: 'monthly',
                  start: new Date().toISOString().slice(0, 10),
                  infl: 0,
                  source: ''
                }
              ])
            }
          >
            + Add
          </button>
        </div>
        <table className="mt-4 w-full text-xs text-slate-200">
          <thead>
            <tr className="text-left text-slate-400">
              <th className="py-2">Name</th>
              <th>Amount</th>
              <th>Frequency</th>
              <th>Start</th>
              <th>Inflation %/yr</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {alt.expense.map((row, index) => {
              const connected = isConnectedRow(row);
              const effectiveAmount = getEffectiveValue(row);
              return (
              <tr
                key={row.uuid}
                className={`border-t border-slate-800 ${connected ? 'connected-live-outline' : ''}`}
                onMouseMove={connected ? handleConnectedRowMouseMove : undefined}
              >
                <td className="py-2">
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    value={row.name}
                    onChange={(event) =>
                      updateExpense((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r))
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="number"
                    value={connected ? effectiveAmount : row.amount}
                    disabled={connected}
                    onChange={(event) =>
                      updateExpense((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, amount: Number(event.target.value) || 0 } : r
                        )
                      )
                    }
                  />
                </td>
                <td>
                  <select
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    value={row.freq}
                    onChange={(event) =>
                      updateExpense((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, freq: event.target.value as ExpenseRow['freq'] } : r))
                      )
                    }
                  >
                    <option value="monthly">Monthly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="weekly">Weekly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="date"
                    value={row.start}
                    onChange={(event) =>
                      updateExpense((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, start: event.target.value } : r))
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="number"
                    value={row.infl || 0}
                    onChange={(event) =>
                      updateExpense((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, infl: Number(event.target.value) || 0 } : r
                        )
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    value={row.source || ''}
                    onChange={(event) =>
                      updateExpense((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, source: event.target.value } : r))
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    className="rounded-md border border-rose-500/60 px-2 py-1 text-xs text-rose-200"
                    type="button"
                    onClick={() => updateExpense((rows) => rows.filter((_, i) => i !== index))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
              );
            })}
            {alt.expense.length === 0 ? (
              <tr>
                <td className="py-3 text-slate-500" colSpan={7}>
                  No expense rows yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">Assets (Manual | APY | Ticker)</h2>
          <button
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
            type="button"
            onClick={() =>
              updateAsset((rows) => [
                ...rows,
                {
                  uuid: makeId('asset'),
                  mode: 'Manual',
                  name: '',
                  group: '',
                  value: 0,
                  apy: 0,
                  ticker: '',
                  quantity: 0,
                  liveprice: 0,
                  totalContrib: 0,
                  recurAmt: 0,
                  recurFreq: 'monthly',
                  source: ''
                }
              ])
            }
          >
            + Add
          </button>
        </div>
        <table className="mt-4 w-full text-xs text-slate-200">
          <thead>
            <tr className="text-left text-slate-400">
              <th className="w-9 py-2" aria-label="Plaid link" />
              <th className="py-2">Mode</th>
              <th>Name / Ticker Search</th>
              <th>Group</th>
              <th>Current Value</th>
              <th>APY %</th>
              <th>Qty</th>
              <th>Avg PPS</th>
              <th>Live Price</th>
              <th>Total Contribution</th>
              <th>Recurring Contribution</th>
              <th>Frequency</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {alt.asset.map((row, index) => {
              const isTicker = row.mode === 'Ticker';
              const isApy = row.mode === 'APY';
              const apyEnabled = isApy || isTicker;
              const tickerOnlyEnabled = isTicker;
              const recurringEnabled = isApy || isTicker;
              const connected = isConnectedRow(row);
              const plaidLinked = isPlaidConnectedAsset(row);
              const effectiveValue = getEffectiveValue(row);
              const avgPps = row.quantity ? (row.totalContrib || 0) / row.quantity : 0;
              return (
                <tr
                  key={row.uuid}
                  className={`border-t border-slate-800 ${connected ? 'connected-live-outline' : ''}`}
                  onMouseMove={connected ? handleConnectedRowMouseMove : undefined}
                >
                  <td className="py-2 align-middle">
                    {plaidLinked ? <PlaidRowIndicator /> : null}
                  </td>
                  <td className="py-2">
                    <select
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                      value={row.mode}
                      onChange={(event) =>
                        updateAsset((rows) =>
                          rows.map((r, i) => (i === index ? { ...r, mode: event.target.value as AssetRow['mode'] } : r))
                        )
                      }
                    >
                      <option value="Manual">Manual</option>
                      <option value="APY">APY</option>
                      <option value="Ticker">Ticker</option>
                    </select>
                  </td>
                  <td>
                    {row.mode === 'Ticker' ? (
                      <TickerSearchCell
                        ticker={row.ticker || ''}
                        name={row.name || ''}
                        finnhubKey={finnhubKey}
                        onSelect={(ticker, name, livePrice) =>
                          updateAsset((rows) =>
                            rows.map((r, i) =>
                              i === index
                                ? {
                                    ...r,
                                    ticker,
                                    name,
                                    liveprice: livePrice ?? r.liveprice ?? 0,
                                    value:
                                      livePrice != null && livePrice > 0
                                        ? (r.quantity || 0) * livePrice
                                        : r.value
                                  }
                                : r
                            )
                          )
                        }
                      />
                    ) : (
                      <input
                        className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                        value={row.name}
                        onChange={(event) =>
                          updateAsset((rows) =>
                            rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r))
                          )
                        }
                      />
                    )}
                  </td>
                  <td>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                      value={row.group || ''}
                      onChange={(event) =>
                        updateAsset((rows) =>
                          rows.map((r, i) => (i === index ? { ...r, group: event.target.value } : r))
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                      type="number"
                      value={connected ? effectiveValue : row.value || 0}
                      disabled={connected}
                      onChange={(event) =>
                        updateAsset((rows) =>
                          rows.map((r, i) => {
                            if (i !== index) return r;
                            const value = Number(event.target.value) || 0;
                            const shouldSyncQty = r.mode === 'Ticker' && (r.liveprice || 0) > 0;
                            return {
                              ...r,
                              value,
                              quantity: shouldSyncQty ? value / (r.liveprice || 1) : r.quantity
                            };
                          })
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                      type="number"
                      value={row.apy || 0}
                      disabled={!apyEnabled}
                      onChange={(event) =>
                        updateAsset((rows) =>
                          rows.map((r, i) =>
                            i === index ? { ...r, apy: Number(event.target.value) || 0 } : r
                          )
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                      type="number"
                      value={row.quantity || 0}
                      disabled={!tickerOnlyEnabled}
                      onChange={(event) =>
                        updateAsset((rows) =>
                          rows.map((r, i) => {
                            if (i !== index) return r;
                            const quantity = Number(event.target.value) || 0;
                            const shouldSyncValue = r.mode === 'Ticker' && (r.liveprice || 0) > 0;
                            return {
                              ...r,
                              quantity,
                              value: shouldSyncValue ? quantity * (r.liveprice || 0) : r.value
                            };
                          })
                        )
                      }
                    />
                  </td>
                  <td className="text-slate-400">{avgPps ? avgPps.toFixed(2) : '—'}</td>
                  <td className="text-slate-400">{row.liveprice ? row.liveprice.toFixed(4) : '—'}</td>
                  <td>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                      type="number"
                      value={row.totalContrib || 0}
                      disabled={!tickerOnlyEnabled}
                      onChange={(event) =>
                        updateAsset((rows) =>
                          rows.map((r, i) =>
                            i === index ? { ...r, totalContrib: Number(event.target.value) || 0 } : r
                          )
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                      type="number"
                      value={row.recurAmt || 0}
                      disabled={!recurringEnabled}
                      onChange={(event) =>
                        updateAsset((rows) =>
                          rows.map((r, i) =>
                            i === index ? { ...r, recurAmt: Number(event.target.value) || 0 } : r
                          )
                        )
                      }
                    />
                  </td>
                  <td>
                    <select
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                      value={row.recurFreq || 'monthly'}
                      disabled={!recurringEnabled}
                      onChange={(event) =>
                        updateAsset((rows) =>
                          rows.map((r, i) =>
                            i === index ? { ...r, recurFreq: event.target.value as AssetRow['recurFreq'] } : r
                          )
                        )
                      }
                    >
                      <option value="monthly">Monthly</option>
                      <option value="biweekly">Biweekly</option>
                      <option value="weekly">Weekly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                      value={row.source || ''}
                      onChange={(event) =>
                        updateAsset((rows) =>
                          rows.map((r, i) => (i === index ? { ...r, source: event.target.value } : r))
                        )
                      }
                    />
                  </td>
                  <td>
                    <button
                      className="rounded-md border border-rose-500/60 px-2 py-1 text-xs text-rose-200"
                      type="button"
                      onClick={() => updateAsset((rows) => rows.filter((_, i) => i !== index))}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
            {alt.asset.length === 0 ? (
              <tr>
                <td className="py-3 text-slate-500" colSpan={14}>
                  No assets added yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <div className="mt-2 text-[11px] text-slate-500">
          Ticker mode links Qty → Current Value via Live Price. Avg PPS = Total Contribution / Qty.
        </div>
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Asset Groups</h2>
        <table className="mt-4 w-full text-xs text-slate-200">
          <thead>
            <tr className="text-left text-slate-400">
              <th className="py-2">Group</th>
              <th>Total Value</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(groups).map(([group, total]) => (
              <tr key={group} className="border-t border-slate-800">
                <td className="py-2">{group}</td>
                <td>${total.toLocaleString()}</td>
              </tr>
            ))}
            {Object.keys(groups).length === 0 ? (
              <tr>
                <td className="py-3 text-slate-500" colSpan={2}>
                  Type a group name on any asset (e.g., &quot;Roth IRA&quot;) to see totals here.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">Debts</h2>
          <button
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200"
            type="button"
            onClick={() =>
              updateDebt((rows) => [
                ...rows,
                {
                  uuid: makeId('debt'),
                  name: '',
                  bal: 0,
                  apr: 0,
                  pmt: 0,
                  freq: 'monthly',
                  start: new Date().toISOString().slice(0, 10),
                  source: ''
                }
              ])
            }
          >
            + Add
          </button>
        </div>
        <table className="mt-4 w-full text-xs text-slate-200">
          <thead>
            <tr className="text-left text-slate-400">
              <th className="py-2">Name</th>
              <th>Balance</th>
              <th>APR %</th>
              <th>Payment</th>
              <th>Frequency</th>
              <th>Start</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {alt.debt.map((row, index) => {
              const connected = isConnectedRow(row);
              const effectiveBalance = getEffectiveValue(row);
              return (
              <tr
                key={row.uuid}
                className={`border-t border-slate-800 ${connected ? 'connected-live-outline' : ''}`}
                onMouseMove={connected ? handleConnectedRowMouseMove : undefined}
              >
                <td className="py-2">
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    value={row.name}
                    onChange={(event) =>
                      updateDebt((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, name: event.target.value } : r))
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="number"
                    value={connected ? effectiveBalance : row.bal}
                    disabled={connected}
                    onChange={(event) =>
                      updateDebt((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, bal: Number(event.target.value) || 0 } : r
                        )
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="number"
                    value={row.apr}
                    onChange={(event) =>
                      updateDebt((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, apr: Number(event.target.value) || 0 } : r
                        )
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="number"
                    value={row.pmt}
                    onChange={(event) =>
                      updateDebt((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, pmt: Number(event.target.value) || 0 } : r
                        )
                      )
                    }
                  />
                </td>
                <td>
                  <select
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    value={row.freq || 'monthly'}
                    onChange={(event) =>
                      updateDebt((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, freq: event.target.value as DebtRow['freq'] } : r
                        )
                      )
                    }
                  >
                    <option value="monthly">Monthly</option>
                    <option value="biweekly">Biweekly</option>
                    <option value="weekly">Weekly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    type="date"
                    value={row.start}
                    onChange={(event) =>
                      updateDebt((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, start: event.target.value } : r))
                      )
                    }
                  />
                </td>
                <td>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
                    value={row.source || ''}
                    onChange={(event) =>
                      updateDebt((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, source: event.target.value } : r))
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    className="rounded-md border border-rose-500/60 px-2 py-1 text-xs text-rose-200"
                    type="button"
                    onClick={() => updateDebt((rows) => rows.filter((_, i) => i !== index))}
                  >
                    ✕
                  </button>
                </td>
              </tr>
              );
            })}
            {alt.debt.length === 0 ? (
              <tr>
                <td className="py-3 text-slate-500" colSpan={8}>
                  No debts added yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
