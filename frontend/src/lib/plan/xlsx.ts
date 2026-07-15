import * as XLSX from 'xlsx';
import type { PlanState, Alternative, PipelineEdge } from './types';
import { DEFAULT_PLAN_STATE } from './defaults';
import { migratePlan } from './migrations';
import { ensureEntityUuids } from './normalize';
import { getScopedLocalStorageItem } from '../storage/userScopedStorage';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_SHEETS = 30;
const MAX_ROWS_PER_SHEET = 10000;
const MAX_TOTAL_CELLS = 1000000;

export function sanitizeSheetName(name: string) {
  let s = String(name || '').replace(/[:\\/?*\[\]]/g, ' ').trim().slice(0, 31);
  if (!s) s = 'Alt';
  return s;
}

function safeSheetToJson(sheet: XLSX.WorkSheet, options: XLSX.Sheet2JSONOpts = {}) {
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', ...options }) as Record<string, unknown>[];
  return rows.map((row) => {
    const safeRow: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(row)) {
      const keyLower = String(key).toLowerCase().trim();
      if (keyLower === '__proto__' || keyLower === 'constructor' || keyLower === 'prototype') {
        continue;
      }
      safeRow[key] = value;
    }
    return safeRow;
  });
}

export function exportPlanXlsx(plan: PlanState) {
  ensureEntityUuids(plan);
  const wb = XLSX.utils.book_new();
  const altNames = Object.keys(plan.alternatives || {});

  const altRows = altNames.map((name) => ({
    Alternative: name,
    EnabledOnChart: !!plan.altChartEnabled[name],
    Color: plan.altColors[name] || ''
  }));
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(altRows.length ? altRows : [{ Alternative: 'Baseline', EnabledOnChart: true, Color: '' }]),
    'Alternatives'
  );

  // SEC-10: the Finnhub key is a device-local secret and never leaves the device —
  // it is deliberately absent from exports (schema v3).
  const settingsRows = [{ Inflation: plan.assumptions.inflation, Start: plan.assumptions.start }];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(settingsRows), 'Settings');

  const augmentsRows = (plan.augments || []).map((a) => ({
    ID: a.id,
    Name: a.name,
    Category: a.category,
    Description: a.description,
    Enabled: a.enabled !== false,
    ActivationType: a.activation.type,
    StartDate: a.activation.startDate,
    EndDate: a.activation.endDate || '',
    Probability: a.activation.probability,
    Effects: JSON.stringify(a.effects || []),
    DurationType: a.duration.type,
    DurationMonths: a.duration.months || 0
  }));
  if (augmentsRows.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(augmentsRows), 'Augments');
  }

  const checkpointRows: Record<string, unknown>[] = [];
  Object.keys(plan.checkpoints || {}).forEach((altName) => {
    plan.checkpoints[altName].forEach((cp) => {
      checkpointRows.push({
        CheckpointId: cp.checkpointId,
        Alt: altName,
        Date: cp.date,
        Type: cp.type,
        NetWorth: cp.netWorth,
        AssetsJSON: JSON.stringify(cp.assets || []),
        DebtsJSON: JSON.stringify(cp.debts || []),
        IncomeJSON: JSON.stringify(cp.income || []),
        ExpensesJSON: JSON.stringify(cp.expenses || []),
        Provenance: cp.provenance,
        Source: cp.source,
        Confidence: cp.confidence,
        CreatedAt: cp.createdAt,
        MetadataJSON: JSON.stringify(cp.metadata || {})
      });
    });
  });
  if (checkpointRows.length) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(checkpointRows), 'Checkpoints');
  }

  altNames.forEach((name) => {
    const alt = plan.alternatives[name];
    const suffix = ` - ${sanitizeSheetName(name)}`;
    const income = alt.income.map((r) => ({
      UUID: r.uuid || '',
      Name: r.name,
      Amount: r.amount,
      Frequency: r.freq,
      Start: r.start,
      Raise: r.raise || '',
      DataSource: r.dataSource || 'manual',
      ConnectedAccountId: r.connectedAccountId || '',
      AutoValue: r.autoValue ?? '',
      ManualValue: r.manualValue ?? '',
      OverrideActive: r.overrideActive ? 'TRUE' : 'FALSE',
      LastSyncedAt: r.lastSyncedAt || '',
      LastOverriddenAt: r.lastOverriddenAt || ''
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(income.length ? income : [{ UUID: '', Name: '', Amount: '', Frequency: 'monthly', Start: plan.assumptions.start, Raise: '' }]), 'Income' + suffix);

    const expense = alt.expense.map((r) => ({
      UUID: r.uuid || '',
      Name: r.name,
      Amount: r.amount,
      Frequency: r.freq,
      Start: r.start,
      Inflation: r.infl || '',
      Source: r.source || '',
      DataSource: r.dataSource || 'manual',
      ConnectedAccountId: r.connectedAccountId || '',
      AutoValue: r.autoValue ?? '',
      ManualValue: r.manualValue ?? '',
      OverrideActive: r.overrideActive ? 'TRUE' : 'FALSE',
      LastSyncedAt: r.lastSyncedAt || '',
      LastOverriddenAt: r.lastOverriddenAt || ''
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expense.length ? expense : [{ UUID: '', Name: '', Amount: '', Frequency: 'monthly', Start: plan.assumptions.start, Inflation: '' }]), 'Expenses' + suffix);

    const assets = alt.asset.map((a) => ({
      UUID: a.uuid || '',
      Mode: a.mode,
      Name: a.name || '',
      Group: a.group || '',
      Ticker: a.ticker || '',
      Qty: a.quantity || 0,
      LivePrice: a.liveprice || 0,
      CurrentValue: a.value || 0,
      TotalContribution: a.totalContrib || 0,
      RecurringContribution: a.recurAmt || 0,
      Frequency: a.recurFreq || 'monthly',
      Source: a.source || '',
      APY: a.apy || 0,
      DataSource: a.dataSource || 'manual',
      ConnectedAccountId: a.connectedAccountId || '',
      AutoValue: a.autoValue ?? '',
      ManualValue: a.manualValue ?? '',
      OverrideActive: a.overrideActive ? 'TRUE' : 'FALSE',
      LastSyncedAt: a.lastSyncedAt || '',
      LastOverriddenAt: a.lastOverriddenAt || '',
      // Schema v3 (D4): position acquisition history + review flag.
      AcquisitionsJSON: JSON.stringify(a.acquisitions || []),
      PositionNeedsReview: a.positionNeedsReview ? 'TRUE' : 'FALSE'
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(assets.length ? assets : [{ UUID: '', Mode: 'Manual', Name: '', Group: '', CurrentValue: 0 }]), 'Assets' + suffix);

    const debts = alt.debt.map((d) => ({
      UUID: d.uuid || '',
      Name: d.name,
      Balance: d.bal,
      APR: d.apr,
      Payment: d.pmt,
      Frequency: d.freq || 'monthly',
      Start: d.start || plan.assumptions.start,
      Source: d.source || '',
      DataSource: d.dataSource || 'manual',
      ConnectedAccountId: d.connectedAccountId || '',
      AutoValue: d.autoValue ?? '',
      ManualValue: d.manualValue ?? '',
      OverrideActive: d.overrideActive ? 'TRUE' : 'FALSE',
      LastSyncedAt: d.lastSyncedAt || '',
      LastOverriddenAt: d.lastOverriddenAt || ''
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(debts.length ? debts : [{ UUID: '', Name: '', Balance: 0, APR: 0, Payment: 0, Frequency: 'monthly', Start: plan.assumptions.start }]), 'Debts' + suffix);

    const pb = plan.pipeline.byAlt[name] || { edges: [], layout: {} };
    const layoutRows = Object.entries(pb.layout || {}).map(([id, pos]) => {
      const parts = String(id).split(':');
      const NodeKind = parts[0];
      const NodeIndex = Number(parts[1]) || 0;
      return { NodeKind, NodeIndex, X: Math.round(pos.x || 0), Y: Math.round(pos.y || 0), NameSnapshot: '' };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(layoutRows.length ? layoutRows : [{ NodeKind: '', NodeIndex: '', X: '', Y: '', NameSnapshot: '' }]), 'PB Layout' + suffix);

    const flowRows = (pb.edges || []).map((e: PipelineEdge) => {
      const [FromKind, FromIndexStr] = String(e.from || '').split(':');
      const [ToKind, ToIndexStr] = String(e.to || '').split(':');
      return {
        FromKind: (FromKind || '').toLowerCase(),
        FromIndex: Number(FromIndexStr) || 0,
        ToKind: (ToKind || '').toLowerCase(),
        ToIndex: Number(ToIndexStr) || 0,
        Mode: e.mode || 'fixed',
        Amount: +e.amount || 0,
        Frequency: e.freq || 'monthly',
        Note: e.note || ''
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flowRows.length ? flowRows : [{ FromKind: '', FromIndex: '', ToKind: '', ToIndex: '', Mode: 'fixed', Amount: 0, Frequency: 'monthly', Note: '' }]), 'PB Flows' + suffix);
  });

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ export_version: '3.0', exported_at: new Date().toISOString() }]), 'TMM_META');

  const connectedRaw = getScopedLocalStorageItem('tmm_connected_accounts');
  if (connectedRaw) {
    try {
      const accounts = JSON.parse(connectedRaw);
      if (Array.isArray(accounts) && accounts.length) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(accounts), 'Connected Accounts');
      }
    } catch {
      // ignore
    }
  }

  XLSX.writeFile(wb, 'money-machine-plan.xlsx');
}

export function downloadTemplateXlsx() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Alternative', 'EnabledOnChart'], ['Baseline', true]]), 'Alternatives');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Inflation', 'Start'], [2.5, new Date().toISOString().slice(0, 10)]]), 'Settings');
  XLSX.writeFile(wb, 'money-machine-template.xlsx');
}

export async function importPlanXlsx(file: File): Promise<PlanState> {
  if (file.size > MAX_FILE_SIZE) throw new Error('File too large (10MB max).');
  if (!file.name.match(/\.(xlsx|xls)$/i)) throw new Error('Invalid file type.');
  const data = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(data), { type: 'array', cellDates: false, cellNF: false, cellStyles: false, sheetStubs: false });

  if (wb.SheetNames.length > MAX_SHEETS) throw new Error('Too many sheets.');

  let totalCells = 0;
  wb.SheetNames.forEach((sheetName) => {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) return;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const rowCount = range.e.r - range.s.r + 1;
    const colCount = range.e.c - range.s.c + 1;
    totalCells += rowCount * colCount;
    if (rowCount > MAX_ROWS_PER_SHEET) throw new Error(`Sheet ${sheetName} too large.`);
  });
  if (totalCells > MAX_TOTAL_CELLS) throw new Error('File too large.');

  const plan = JSON.parse(JSON.stringify(DEFAULT_PLAN_STATE)) as PlanState;

  const settings = wb.Sheets['Settings'];
  if (settings) {
    const rows = safeSheetToJson(settings);
    if (rows[0]) {
      const row = rows[0];
      plan.assumptions.inflation = Number(row.Inflation) || plan.assumptions.inflation;
      plan.assumptions.start = String(row.Start || plan.assumptions.start);
      // Legacy (pre-v3) workbooks exported the key; keep reading it so old files
      // import losslessly. v3 exports no longer contain it (SEC-10).
      plan.assumptions.finnhubKey = String(row.FinnhubKey || '');
    }
  }

  const altSheet = wb.Sheets['Alternatives'];
  if (altSheet) {
    const rows = safeSheetToJson(altSheet);
    rows.forEach((r) => {
      const name = String(r.Alternative || 'Baseline').trim() || 'Baseline';
      if (!plan.alternatives[name]) plan.alternatives[name] = { income: [], expense: [], asset: [], debt: [] };
      plan.altChartEnabled[name] = String(r.EnabledOnChart) === 'TRUE' || name === 'Baseline';
      if (r.Color) plan.altColors[name] = String(r.Color);
    });
  }

  const altNames = Object.keys(plan.alternatives);
  altNames.forEach((name) => {
    const suffix = ` - ${sanitizeSheetName(name)}`;
    const alt: Alternative = plan.alternatives[name];
    const incomeSheet = wb.Sheets['Income' + suffix];
    const expenseSheet = wb.Sheets['Expenses' + suffix];
    const assetsSheet = wb.Sheets['Assets' + suffix];
    const debtsSheet = wb.Sheets['Debts' + suffix];
    if (incomeSheet) {
      const rows = safeSheetToJson(incomeSheet);
      alt.income = rows.map((r) => ({
        uuid: String(r.UUID || ''),
        name: String(r.Name || ''),
        amount: Number(r.Amount) || 0,
        freq: (r.Frequency as any) || 'monthly',
        start: String(r.Start || plan.assumptions.start),
        raise: Number(r.Raise) || 0,
        dataSource: (r.DataSource as any) || 'manual',
        connectedAccountId: String(r.ConnectedAccountId || ''),
        autoValue: r.AutoValue !== '' ? Number(r.AutoValue) : null,
        manualValue: r.ManualValue !== '' ? Number(r.ManualValue) : null,
        overrideActive: r.OverrideActive === 'TRUE'
      }));
    }
    if (expenseSheet) {
      const rows = safeSheetToJson(expenseSheet);
      alt.expense = rows.map((r) => ({
        uuid: String(r.UUID || ''),
        name: String(r.Name || ''),
        amount: Number(r.Amount) || 0,
        freq: (r.Frequency as any) || 'monthly',
        start: String(r.Start || plan.assumptions.start),
        infl: Number(r.Inflation) || 0,
        source: String(r.Source || ''),
        dataSource: (r.DataSource as any) || 'manual',
        connectedAccountId: String(r.ConnectedAccountId || ''),
        autoValue: r.AutoValue !== '' ? Number(r.AutoValue) : null,
        manualValue: r.ManualValue !== '' ? Number(r.ManualValue) : null,
        overrideActive: r.OverrideActive === 'TRUE'
      }));
    }
    if (assetsSheet) {
      const rows = safeSheetToJson(assetsSheet);
      alt.asset = rows.map((r) => {
        // v3 columns; absent in v2 workbooks — migratePlan backfills.
        let acquisitions: unknown = undefined;
        if (typeof r.AcquisitionsJSON === 'string' && r.AcquisitionsJSON.trim()) {
          try {
            const parsed = JSON.parse(r.AcquisitionsJSON);
            if (Array.isArray(parsed)) acquisitions = parsed;
          } catch {
            // tolerate malformed cells; treated as absent
          }
        }
        return {
          uuid: String(r.UUID || ''),
          mode: (r.Mode as any) || 'Manual',
          name: String(r.Name || ''),
          group: String(r.Group || ''),
          ticker: String(r.Ticker || ''),
          quantity: Number(r.Qty) || 0,
          liveprice: Number(r.LivePrice) || 0,
          value: Number(r.CurrentValue) || 0,
          totalContrib: Number(r.TotalContribution) || 0,
          recurAmt: Number(r.RecurringContribution) || 0,
          recurFreq: (r.Frequency as any) || 'monthly',
          source: String(r.Source || ''),
          apy: Number(r.APY) || 0,
          dataSource: (r.DataSource as any) || 'manual',
          connectedAccountId: String(r.ConnectedAccountId || ''),
          autoValue: r.AutoValue !== '' ? Number(r.AutoValue) : null,
          manualValue: r.ManualValue !== '' ? Number(r.ManualValue) : null,
          overrideActive: r.OverrideActive === 'TRUE',
          ...(acquisitions !== undefined ? { acquisitions: acquisitions as any } : {}),
          ...(r.PositionNeedsReview === 'TRUE' ? { positionNeedsReview: true } : {})
        };
      });
    }
    if (debtsSheet) {
      const rows = safeSheetToJson(debtsSheet);
      alt.debt = rows.map((r) => ({
        uuid: String(r.UUID || ''),
        name: String(r.Name || ''),
        bal: Number(r.Balance) || 0,
        apr: Number(r.APR) || 0,
        pmt: Number(r.Payment) || 0,
        freq: (r.Frequency as any) || 'monthly',
        start: String(r.Start || plan.assumptions.start),
        source: String(r.Source || ''),
        dataSource: (r.DataSource as any) || 'manual',
        connectedAccountId: String(r.ConnectedAccountId || ''),
        autoValue: r.AutoValue !== '' ? Number(r.AutoValue) : null,
        manualValue: r.ManualValue !== '' ? Number(r.ManualValue) : null,
        overrideActive: r.OverrideActive === 'TRUE'
      }));
    }

    const layoutSheet = wb.Sheets['PB Layout' + suffix];
    const flowsSheet = wb.Sheets['PB Flows' + suffix];
    if (!plan.pipeline.byAlt[name]) plan.pipeline.byAlt[name] = { edges: [], layout: {} };
    if (layoutSheet) {
      const rows = safeSheetToJson(layoutSheet);
      rows.forEach((r) => {
        const kind = String(r.NodeKind || '').toLowerCase().trim();
        const idx = Number(r.NodeIndex || 0);
        const id = `${kind}:${idx}`;
        plan.pipeline.byAlt[name].layout[id] = { x: Number(r.X) || 0, y: Number(r.Y) || 0 };
      });
    }
    if (flowsSheet) {
      const rows = safeSheetToJson(flowsSheet);
      rows.forEach((r) => {
        const from = `${String(r.FromKind || '').toLowerCase()}:${Number(r.FromIndex || 0)}`;
        const to = `${String(r.ToKind || '').toLowerCase()}:${Number(r.ToIndex || 0)}`;
        plan.pipeline.byAlt[name].edges.push({
          from,
          to,
          mode: (String(r.Mode || 'fixed').toLowerCase() === 'percent' ? 'percent' : 'fixed'),
          amount: Number(r.Amount) || 0,
          freq: (r.Frequency as any) || 'monthly',
          note: String(r.Note || '')
        });
      });
    }
  });

  return migratePlan(plan);
}

