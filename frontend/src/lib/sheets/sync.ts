import type { PlanState, Alternative, IncomeRow, ExpenseRow, Frequency } from '../plan/types';
import { writeSheet, readSheet, clearSheetRange, batchUpdateSheets, batchWriteSheets, appendSheet, getSheetsSessionToken, ensureSpreadsheetTabs } from './api';
import { DEFAULT_PLAN_STATE } from '../plan/defaults';
import { migratePlan } from '../plan/migrations';
import { ensureEntityUuids } from '../plan/normalize';
import { loadSheetQueue, saveSheetQueue, type SheetQueueItem } from './storage';
/** Max data row for clear ranges and UUID read; deletes only within row 2..MAX_DATA_ROW. */
export const MAX_DATA_ROW = 1000;
/** Max column for clear ranges (e.g. A2:Z1000). */
export const MAX_COLUMN = 'Z';

const INCOME_ENTITY_HEADERS = [
  'UUID',
  'Name',
  'Amount',
  'Frequency',
  'Start',
  'Raise',
  'DataSource',
  'ConnectedAccountId',
  'AutoValue',
  'ManualValue',
  'OverrideActive',
  'LastSyncedAt',
  'LastOverriddenAt'
] as const;

const EXPENSE_ENTITY_HEADERS = [
  'UUID',
  'Name',
  'Amount',
  'Frequency',
  'Start',
  'Inflation',
  'Source',
  'DataSource',
  'ConnectedAccountId',
  'AutoValue',
  'ManualValue',
  'OverrideActive',
  'LastSyncedAt',
  'LastOverriddenAt'
] as const;

export const BASE_SHEETS = [
  'Settings',
  'Alternatives',
  'Augments',
  'Checkpoints',
  'TMM_META'
];

export function sanitizeSheetName(name: string) {
  let s = String(name || '').replace(/[:\\/?*\[\]]/g, ' ').trim().slice(0, 31);
  if (!s) s = 'Alt';
  return s;
}

/** Sheet sync type: centralized, deterministic, reused by write and diff logic. */
export type SheetSyncType = 'fixed' | 'entity-uuid' | 'full-replace';

export function getSheetSyncType(sheetName: string): SheetSyncType {
  if (sheetName === 'Settings' || sheetName === 'Alternatives' || sheetName === 'TMM_META') {
    return 'fixed';
  }
  if (/^Income - .+/.test(sheetName) || /^Expenses - .+/.test(sheetName) ||
      /^Assets - .+/.test(sheetName) || /^Debts - .+/.test(sheetName)) {
    return 'entity-uuid';
  }
  if (sheetName === 'Augments' || sheetName === 'Checkpoints' ||
      /^PB Layout - .+/.test(sheetName) || /^PB Flows - .+/.test(sheetName)) {
    return 'full-replace';
  }
  return 'full-replace';
}

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isValidUuid(value: unknown): boolean {
  if (value == null || typeof value !== 'string') return false;
  const s = String(value).trim();
  return s.length > 0 && UUID_REGEX.test(s);
}

/** Column A = 0 -> 'A', 25 -> 'Z'. */
function columnLetter(index: number): string {
  if (index < 0 || index > 25) return MAX_COLUMN;
  return String.fromCharCode(65 + index);
}

export interface SheetEntityRow {
  rowIndex: number;
  uuid: string;
  /** Full existing row values (columns A..lastCol) as returned by Sheets. */
  values: unknown[];
}

export interface EntitySheetDiff {
  toDelete: number[];
  toUpdate: { rowIndex: number; values: unknown[] }[];
  toAdd: unknown[][];
}

/**
 * Read an entity sheet (A1:{lastCol}{MAX_DATA_ROW}) in a single request and parse rows.
 * Returns the header row and, for each data row, its row index, UUID, and full values.
 * Row 1 must be header with "UUID" in column A (Guardrail 10: abort if not).
 * Data rows start at row 2. Blank/malformed UUID -> orphan (included in toDelete by diff).
 */
async function readEntitySheet(
  spreadsheetId: string,
  sheetName: string,
  lastCol: string,
  sessionToken?: string | null
): Promise<{
  sheetRows: SheetEntityRow[];
  hasUuidHeader: boolean;
  rowCount: number;
  headerCell: string | null;
  existingHeaders: string[];
}> {
  const range = `${sheetName}!A1:${lastCol}${MAX_DATA_ROW}`;
  const result = await readSheet(spreadsheetId, range, sessionToken);
  const rows = (result.values ?? []) as unknown[][];
  const headerCell = rows[0]?.[0];
  const hasUuidHeader = headerCell != null && String(headerCell).trim() === 'UUID';
  const existingHeaders = (rows[0] ?? []).map((header) => String(header).trim());
  if (!hasUuidHeader) {
    return {
      sheetRows: [],
      hasUuidHeader: false,
      rowCount: rows.length,
      headerCell: headerCell == null ? null : String(headerCell),
      existingHeaders
    };
  }
  const out: SheetEntityRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const rowIndex = i + 1;
    if (rowIndex > MAX_DATA_ROW) break;
    const row = (rows[i] ?? []) as unknown[];
    const cell = row[0];
    const uuid = cell != null ? String(cell).trim() : '';
    out.push({ rowIndex, uuid, values: row });
  }
  return {
    sheetRows: out,
    hasUuidHeader: true,
    rowCount: rows.length,
    headerCell: headerCell == null ? null : String(headerCell),
    existingHeaders
  };
}

/**
 * Parse a cell to a number, tolerating thousands separators, surrounding spaces, and a
 * leading "$". Returns null when the cell is not an unambiguous plain number so the caller
 * falls back to a strict string comparison (never a false "equal").
 */
function toNumberOrNull(raw: string): number | null {
  if (raw === '') return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Conservative cell equality used to decide whether a row is unchanged.
 * Returns true ONLY when we are confident the two values are identical (exact string match,
 * or both parse to the same plain number). Any ambiguity returns false, so a genuine edit is
 * never mistaken for "unchanged" — worst case is a harmless redundant write.
 */
export function cellsEqual(a: unknown, b: unknown): boolean {
  const sa = a == null ? '' : String(a).trim();
  const sb = b == null ? '' : String(b).trim();
  if (sa === sb) return true;
  const na = toNumberOrNull(sa);
  const nb = toNumberOrNull(sb);
  if (na != null && nb != null) return na === nb;
  return false;
}

/** True when every managed column (0..columnCount-1) of the two rows is confidently equal. */
export function entityRowsEqual(existing: unknown[], next: unknown[], columnCount: number): boolean {
  for (let i = 0; i < columnCount; i++) {
    if (!cellsEqual(existing?.[i], next?.[i])) return false;
  }
  return true;
}

/**
 * Diff sheet UUIDs vs TMM. UUID only — no heuristics.
 * toDelete: row indices (descending), never row 1; never outside 2..MAX_DATA_ROW.
 * Duplicate UUIDs in sheet: keep first, delete rest.
 * When `columnCount` is provided, matched rows whose managed columns already equal the TMM
 * values are skipped (not added to toUpdate) to minimize write volume.
 */
export function diffEntitySheet(
  sheetRows: { rowIndex: number; uuid: string; values?: unknown[] }[],
  tmmValues: unknown[][],
  columnCount?: number
): EntitySheetDiff {
  const tmmRows = tmmValues.slice(1);
  const tmmUuidSet = new Set(tmmRows.map((r) => String(r?.[0] ?? '').trim()));
  const tmmMap = new Map<string, unknown[]>();
  tmmRows.forEach((r) => {
    const u = String(r?.[0] ?? '').trim();
    if (u) tmmMap.set(u, r as unknown[]);
  });

  const toDelete: number[] = [];
  const toUpdate: { rowIndex: number; values: unknown[] }[] = [];
  const seenUuids = new Set<string>();

  for (const { rowIndex, uuid, values } of sheetRows) {
    if (rowIndex < 2 || rowIndex > MAX_DATA_ROW) continue;
    if (!isValidUuid(uuid)) {
      toDelete.push(rowIndex);
      continue;
    }
    if (!tmmUuidSet.has(uuid)) {
      toDelete.push(rowIndex);
      continue;
    }
    if (seenUuids.has(uuid)) {
      toDelete.push(rowIndex);
      continue;
    }
    seenUuids.add(uuid);
    const rowValues = tmmMap.get(uuid);
    if (!rowValues) continue;
    // Skip rows that already match (only when we have both the existing values and a column
    // count to compare); otherwise fall back to always updating (previous behavior).
    if (
      columnCount != null &&
      Array.isArray(values) &&
      entityRowsEqual(values, rowValues, columnCount)
    ) {
      continue;
    }
    toUpdate.push({ rowIndex, values: rowValues });
  }

  const toAdd = tmmRows.filter((r) => {
    const u = String(r?.[0] ?? '').trim();
    return u && !seenUuids.has(u);
  }) as unknown[][];

  toDelete.sort((a, b) => b - a);
  return { toDelete, toUpdate, toAdd };
}

/**
 * Apply entity sheet sync in order: update (batched) -> delete (bottom-up) -> append.
 * Updates run before deletes because deleting rows renumbers everything below them; since
 * toUpdate/toDelete are disjoint UUID sets, writing correct content first (at the pre-delete
 * indices) then deleting orphans leaves every updated row intact wherever it lands.
 * All toUpdate rows are written in a SINGLE values:batchUpdate request (one write quota unit).
 * Guardrail 6: row 1 is immutable; every delete row index must be >= 2. Fails loud on any API error.
 */
async function applyEntitySheetSync(
  spreadsheetId: string,
  sheetName: string,
  diff: EntitySheetDiff,
  lastColumnIndex: number,
  sessionToken?: string | null
): Promise<void> {
  if (diff.toDelete.some((r) => r < 2)) {
    const bad = diff.toDelete.filter((r) => r < 2);
    throw new Error(`Sheet sync: header row (1) is immutable; delete indices must be >= 2 (got ${JSON.stringify(bad)})`);
  }

  const lastCol = columnLetter(lastColumnIndex);

  if (diff.toUpdate.length > 0) {
    await batchWriteSheets(
      spreadsheetId,
      diff.toUpdate.map(({ rowIndex, values }) => ({
        range: `${sheetName}!A${rowIndex}:${lastCol}${rowIndex}`,
        values: [values]
      })),
      'USER_ENTERED',
      sessionToken
    );
  }

  if (diff.toDelete.length > 0) {
    await batchUpdateSheets(spreadsheetId, [
      { type: 'deleteRows', sheetName, rowIndices: diff.toDelete }
    ], sessionToken);
  }

  if (diff.toAdd.length > 0) {
    await appendSheet(
      spreadsheetId,
      `${sheetName}!A:${lastCol}`,
      diff.toAdd,
      'USER_ENTERED',
      sessionToken
    );
  }
}

function mapAlternatives(plan: PlanState) {
  const altNames = Object.keys(plan.alternatives || {});
  const rows = altNames.map((name) => [
    name,
    plan.altChartEnabled[name] ? 'TRUE' : 'FALSE',
    plan.altColors[name] || ''
  ]);
  return [['Alternative', 'EnabledOnChart', 'Color'], ...rows];
}

function mapSettings(plan: PlanState) {
  return [
    ['Inflation', 'Start', 'FinnhubKey'],
    [plan.assumptions.inflation, plan.assumptions.start, plan.assumptions.finnhubKey || '']
  ];
}

function mapEntitiesForAlt(altName: string, alt: Alternative, plan: PlanState) {
  const suffix = ` - ${sanitizeSheetName(altName)}`;
  const income = [
    [...INCOME_ENTITY_HEADERS],
    ...alt.income.map((r) => [
      r.uuid,
      r.name,
      r.amount,
      r.freq,
      r.start,
      r.raise || 0,
      r.dataSource || 'manual',
      r.connectedAccountId || '',
      r.autoValue ?? '',
      r.manualValue ?? '',
      r.overrideActive ? 'TRUE' : 'FALSE',
      r.lastSyncedAt || '',
      r.lastOverriddenAt || ''
    ])
  ];
  const expense = [
    [...EXPENSE_ENTITY_HEADERS],
    ...alt.expense.map((r) => [
      r.uuid,
      r.name,
      r.amount,
      r.freq,
      r.start,
      r.infl || 0,
      r.source || '',
      r.dataSource || 'manual',
      r.connectedAccountId || '',
      r.autoValue ?? '',
      r.manualValue ?? '',
      r.overrideActive ? 'TRUE' : 'FALSE',
      r.lastSyncedAt || '',
      r.lastOverriddenAt || ''
    ])
  ];
  const assets = [
    [
      'UUID',
      'Mode',
      'Name',
      'Group',
      'CurrentValue',
      'APY',
      'Ticker',
      'Qty',
      'LivePrice',
      'RecurringContribution',
      'Frequency',
      'TotalContribution',
      'Source',
      'DataSource',
      'ConnectedAccountId',
      'AutoValue',
      'ManualValue',
      'OverrideActive',
      'LastSyncedAt',
      'LastOverriddenAt'
    ],
    ...alt.asset.map((a) => [
      a.uuid,
      a.mode,
      a.name,
      a.group || '',
      a.value || 0,
      a.apy || 0,
      a.ticker || '',
      a.quantity || 0,
      a.liveprice || 0,
      a.recurAmt || 0,
      a.recurFreq || 'monthly',
      a.totalContrib || 0,
      a.source || '',
      a.dataSource || 'manual',
      a.connectedAccountId || '',
      a.autoValue ?? '',
      a.manualValue ?? '',
      a.overrideActive ? 'TRUE' : 'FALSE',
      a.lastSyncedAt || '',
      a.lastOverriddenAt || ''
    ])
  ];
  const debts = [
    [
      'UUID',
      'Name',
      'Balance',
      'APR',
      'Payment',
      'Frequency',
      'Start',
      'Source',
      'DataSource',
      'ConnectedAccountId',
      'AutoValue',
      'ManualValue',
      'OverrideActive',
      'LastSyncedAt',
      'LastOverriddenAt'
    ],
    ...alt.debt.map((d) => [
      d.uuid,
      d.name,
      d.bal,
      d.apr,
      d.pmt,
      d.freq,
      d.start,
      d.source || '',
      d.dataSource || 'manual',
      d.connectedAccountId || '',
      d.autoValue ?? '',
      d.manualValue ?? '',
      d.overrideActive ? 'TRUE' : 'FALSE',
      d.lastSyncedAt || '',
      d.lastOverriddenAt || ''
    ])
  ];
  const pipeline = plan.pipeline.byAlt[altName] || { edges: [], layout: {} };
  const layout = [
    ['NodeKind', 'NodeIndex', 'X', 'Y', 'NameSnapshot'],
    ...Object.entries(pipeline.layout || {}).map(([id, pos]) => {
      const [kind, index] = String(id).split(':');
      return [kind, index, Math.round(pos.x || 0), Math.round(pos.y || 0), ''];
    })
  ];
  const flows = [
    ['FromKind', 'FromIndex', 'ToKind', 'ToIndex', 'Mode', 'Amount', 'Frequency', 'Note'],
    ...pipeline.edges.map((e) => {
      const [fromKind, fromIndex] = String(e.from || '').split(':');
      const [toKind, toIndex] = String(e.to || '').split(':');
      return [fromKind, fromIndex, toKind, toIndex, e.mode || 'fixed', e.amount || 0, e.freq || 'monthly', e.note || ''];
    })
  ];
  return {
    [`Income${suffix}`]: income,
    [`Expenses${suffix}`]: expense,
    [`Assets${suffix}`]: assets,
    [`Debts${suffix}`]: debts,
    [`PB Layout${suffix}`]: layout,
    [`PB Flows${suffix}`]: flows
  };
}

export function planToSheets(plan: PlanState) {
  ensureEntityUuids(plan);
  const sheets: Record<string, unknown[][]> = {
    Settings: mapSettings(plan),
    Alternatives: mapAlternatives(plan),
    Augments: [
      ['ID', 'Name', 'Category', 'Description', 'Enabled', 'ActivationType', 'StartDate', 'EndDate', 'Probability', 'Effects', 'DurationType', 'DurationMonths'],
      ...plan.augments.map((a) => [
        a.id,
        a.name,
        a.category,
        a.description,
        a.enabled ? 'TRUE' : 'FALSE',
        a.activation.type,
        a.activation.startDate,
        a.activation.endDate || '',
        a.activation.probability,
        JSON.stringify(a.effects || []),
        a.duration.type,
        a.duration.months || 0
      ])
    ],
    Checkpoints: [
      [
        'CheckpointId',
        'Alt',
        'Date',
        'Type',
        'NetWorth',
        'AssetsJSON',
        'DebtsJSON',
        'IncomeJSON',
        'ExpensesJSON',
        'Provenance',
        'Source',
        'Confidence',
        'CreatedAt',
        'MetadataJSON'
      ],
      ...Object.entries(plan.checkpoints || {}).flatMap(([altName, checkpoints]) =>
        checkpoints.map((cp) => [
          cp.checkpointId,
          altName,
          cp.date,
          cp.type,
          cp.netWorth,
          JSON.stringify(cp.assets || []),
          JSON.stringify(cp.debts || []),
          JSON.stringify(cp.income || []),
          JSON.stringify(cp.expenses || []),
          cp.provenance,
          cp.source,
          cp.confidence,
          cp.createdAt,
          JSON.stringify(cp.metadata || {})
        ])
      )
    ],
    TMM_META: [
      ['export_version', 'exported_at', 'forecast_seed', 'forecast_fingerprint'],
      ['2.0', new Date().toISOString(), plan.forecastSeed || '', plan.forecastFingerprint || '']
    ]
  };

  Object.entries(plan.alternatives || {}).forEach(([altName, alt]) => {
    Object.assign(sheets, mapEntitiesForAlt(altName, alt, plan));
  });

  return sheets;
}

/** Defensive logging for sheet sync (Guardrail 9). */
function logSheetSync(
  sheetName: string,
  diff: EntitySheetDiff | null,
  rowCountBefore: number | null,
  rowCountAfter: number | null
) {
  const payload: Record<string, unknown> = { sheetName };
  if (diff) {
    payload.rowIndicesToDelete = diff.toDelete;
    payload.uuidsToUpdate = diff.toUpdate.map((u) => u.values[0]);
    payload.uuidsToAppend = diff.toAdd.map((row) => row[0]);
    payload.uuidToDeleteCount = diff.toDelete.length;
    payload.uuidToUpdateCount = diff.toUpdate.length;
    payload.uuidToAppendCount = diff.toAdd.length;
  }
  if (rowCountBefore != null) payload.rowCountBefore = rowCountBefore;
  if (rowCountAfter != null) payload.rowCountAfter = rowCountAfter;
  console.info('[TMM sheet sync]', payload);
}

export async function syncPlanToSheets(
  plan: PlanState,
  spreadsheetId: string,
  preFetchedToken?: string | null
): Promise<SyncPlanResult> {
  const sheets = planToSheets(plan);
  const entries = Object.entries(sheets);
  const sessionToken = preFetchedToken !== undefined ? preFetchedToken : await getSheetsSessionToken();
  const errors: string[] = [];
  let queuedCount = 0;

  try {
    await ensureSpreadsheetTabs(spreadsheetId, entries.map(([name]) => name), sessionToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`ensureTabs: ${msg}`);
    return { ok: false, queued: 0, errors };
  }

  for (const [sheetName, values] of entries) {
    const syncType = getSheetSyncType(sheetName);

    if (syncType === 'fixed') {
      const range = `${sheetName}!A1:${MAX_COLUMN}100`;
      try {
        await clearSheetRange(spreadsheetId, range, sessionToken);
        const result = await writeWithQueue(spreadsheetId, `${sheetName}!A1`, values, sessionToken);
        if (result.queued) {
          queuedCount += 1;
          if (result.error) errors.push(`${sheetName}: ${result.error}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${sheetName}: ${msg}`);
        return { ok: false, queued: 0, errors };
      }
      continue;
    }

    if (syncType === 'entity-uuid') {
      const expectedHeaders = (values[0] ?? []).map((header) => String(header).trim());
      const lastColIndex = Math.min(25, Math.max(0, expectedHeaders.length - 1));
      const lastCol = columnLetter(lastColIndex);

      let entityRead:
        | {
            sheetRows: SheetEntityRow[];
            hasUuidHeader: boolean;
            rowCount: number;
            headerCell: string | null;
            existingHeaders: string[];
          }
        | null = null;
      try {
        entityRead = await readEntitySheet(spreadsheetId, sheetName, lastCol, sessionToken);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${sheetName}: ${msg}`);
        return { ok: false, queued: 0, errors };
      }
      if (!entityRead.hasUuidHeader) {
        if (entityRead.rowCount === 0) {
          try {
            const result = await writeWithQueue(spreadsheetId, `${sheetName}!A1`, values, sessionToken);
            if (result.queued) {
              queuedCount += 1;
              if (result.error) errors.push(`${sheetName}: ${result.error}`);
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            errors.push(`${sheetName}: ${msg}`);
            return { ok: false, queued: 0, errors };
          }
          continue;
        }
        const msg = `Sheet "${sheetName}": UUID column not found or unexpected header (expected "UUID" in A1)`;
        errors.push(`${sheetName}: ${msg}`);
        return { ok: false, queued: 0, errors };
      }

      if (!entityHeadersMatch(entityRead.existingHeaders, expectedHeaders)) {
        try {
          const result = await writeWithQueue(spreadsheetId, `${sheetName}!A1`, values, sessionToken);
          if (result.queued) {
            queuedCount += 1;
            if (result.error) errors.push(`${sheetName}: ${result.error}`);
          }
          logSheetSync(sheetName, null, null, 1 + (values.length - 1));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`${sheetName}: ${msg}`);
          return { ok: false, queued: 0, errors };
        }
        continue;
      }

      const sheetRows = entityRead.sheetRows;
      const rowCountBefore = 1 + sheetRows.length;
      const diff = diffEntitySheet(sheetRows, values as unknown[][], expectedHeaders.length);
      try {
        await applyEntitySheetSync(spreadsheetId, sheetName, diff, lastColIndex, sessionToken);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${sheetName}: ${msg}`);
        return { ok: false, queued: 0, errors };
      }
      const rowCountAfter = 1 + rowCountBefore - diff.toDelete.length + diff.toAdd.length;
      logSheetSync(sheetName, diff, rowCountBefore, rowCountAfter);
      continue;
    }

    if (syncType === 'full-replace') {
      const dataRange = `${sheetName}!A2:${MAX_COLUMN}${MAX_DATA_ROW}`;
      try {
        await clearSheetRange(spreadsheetId, dataRange, sessionToken);
        const result = await writeWithQueue(spreadsheetId, `${sheetName}!A1`, values, sessionToken);
        if (result.queued) {
          queuedCount += 1;
          if (result.error) errors.push(`${sheetName}: ${result.error}`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${sheetName}: ${msg}`);
        return { ok: false, queued: 0, errors };
      }
      continue;
    }
  }

  if (queuedCount > 0) {
    return { ok: false, queued: queuedCount, errors };
  }
  return { ok: true };
}

export function getSheetsQueueStatus() {
  const queue = loadSheetQueue();
  return {
    pending: queue.length,
    oldest: queue[0]?.createdAt || null,
    latestError: queue[0]?.lastError || null
  };
}

export async function flushSheetQueue(spreadsheetId: string) {
  const queue = loadSheetQueue();
  if (queue.length === 0) return;
  const remaining: SheetQueueItem[] = [];
  for (const item of queue) {
    if (item.spreadsheetId !== spreadsheetId) {
      remaining.push(item);
      continue;
    }
    try {
      await writeSheet(item.spreadsheetId, item.range, item.values);
    } catch (error) {
      remaining.push({
        ...item,
        retries: item.retries + 1,
        lastError: error instanceof Error ? error.message : String(error)
      });
    }
  }
  saveSheetQueue(remaining);
}

export type SyncPlanResult =
  | { ok: true }
  | { ok: false; queued: number; errors: string[] };

// Aligned above the backend's worst-case retry/backoff window so a retried write is not
// prematurely queued (see SHEETS_REQUEST_TIMEOUT_MS in api.ts).
const WRITE_TIMEOUT_MS = 40000;

async function writeWithQueue(
  spreadsheetId: string,
  range: string,
  values: unknown[][],
  sessionToken?: string | null
): Promise<{ queued: boolean; error?: string }> {
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Write timed out')), WRITE_TIMEOUT_MS);
    });
    await Promise.race([writeSheet(spreadsheetId, range, values, sessionToken), timeoutPromise]);
    return { queued: false };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const queue = loadSheetQueue();
    queue.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      spreadsheetId,
      range,
      values,
      retries: 0,
      createdAt: new Date().toISOString(),
      lastError: errMsg
    });
    saveSheetQueue(queue);
    return { queued: true, error: errMsg };
  }
}

function rowsToObjects(rows: unknown[][]): Record<string, string>[] {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h));
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, idx) => {
      obj[header] = row?.[idx] !== undefined ? String(row[idx]) : '';
    });
    return obj;
  });
}

/** Get value from a row by header name (case-insensitive). */
function get(row: Record<string, string>, key: string): string {
  const k = key.toLowerCase();
  const found = Object.keys(row).find((h) => h.toLowerCase() === k);
  return found != null ? (row[found] ?? '') : '';
}

function hasHeader(headers: string[], name: string): boolean {
  const target = name.toLowerCase();
  return headers.some((header) => header.trim().toLowerCase() === target);
}

function entityHeadersMatch(existing: string[], expected: readonly string[]): boolean {
  if (existing.length < expected.length) return false;
  return expected.every(
    (header, idx) => String(existing[idx] ?? '').trim().toLowerCase() === header.toLowerCase()
  );
}

function sheetCell(row: unknown[] | undefined, index: number): string {
  const value = row?.[index];
  return value !== undefined && value !== null ? String(value) : '';
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOverrideActive(value: string): boolean {
  return value.trim().toUpperCase() === 'TRUE';
}

function looksLikeShiftedName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return Number.isNaN(Number(trimmed));
}

function parseIncomeRowsFromSheet(values: unknown[][], defaultStart: string): IncomeRow[] {
  if (!values || values.length < 2) return [];
  const headers = values[0].map((header) => String(header).trim());
  const hasName = hasHeader(headers, 'Name');
  const hasUuid = headers[0]?.trim().toLowerCase() === 'uuid';
  const rows: IncomeRow[] = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i] as unknown[];
    if (!row || row.every((cell) => cell === undefined || cell === null || String(cell).trim() === '')) {
      continue;
    }

    if (hasName) {
      const obj = rowToObject(headers, row);
      rows.push({
        uuid: get(obj, 'UUID') || '',
        name: get(obj, 'Name') || '',
        amount: Number(get(obj, 'Amount')) || 0,
        freq: (get(obj, 'Frequency') as Frequency) || 'monthly',
        start: get(obj, 'Start') || defaultStart,
        raise: Number(get(obj, 'Raise')) || 0,
        dataSource: (get(obj, 'DataSource') as IncomeRow['dataSource']) || 'manual',
        connectedAccountId: get(obj, 'ConnectedAccountId') || '',
        autoValue: parseOptionalNumber(get(obj, 'AutoValue')),
        manualValue: parseOptionalNumber(get(obj, 'ManualValue')),
        overrideActive: parseOverrideActive(get(obj, 'OverrideActive')),
        lastSyncedAt: get(obj, 'LastSyncedAt') || null,
        lastOverriddenAt: get(obj, 'LastOverriddenAt') || null
      });
      continue;
    }

    if (hasUuid) {
      const shifted = looksLikeShiftedName(sheetCell(row, 1));
      if (shifted) {
        rows.push({
          uuid: sheetCell(row, 0),
          name: sheetCell(row, 1),
          amount: Number(sheetCell(row, 2)) || 0,
          freq: (sheetCell(row, 3) as Frequency) || 'monthly',
          start: sheetCell(row, 4) || defaultStart,
          raise: Number(sheetCell(row, 5)) || 0,
          dataSource: (sheetCell(row, 6) as IncomeRow['dataSource']) || 'manual',
          connectedAccountId: sheetCell(row, 7) || '',
          autoValue: parseOptionalNumber(sheetCell(row, 8)),
          manualValue: parseOptionalNumber(sheetCell(row, 9)),
          overrideActive: parseOverrideActive(sheetCell(row, 10)),
          lastSyncedAt: sheetCell(row, 11) || null,
          lastOverriddenAt: sheetCell(row, 12) || null
        });
      } else {
        rows.push({
          uuid: sheetCell(row, 0),
          name: '',
          amount: Number(sheetCell(row, 1)) || 0,
          freq: (sheetCell(row, 2) as Frequency) || 'monthly',
          start: sheetCell(row, 3) || defaultStart,
          raise: Number(sheetCell(row, 4)) || 0,
          dataSource: (sheetCell(row, 5) as IncomeRow['dataSource']) || 'manual',
          connectedAccountId: sheetCell(row, 6) || '',
          autoValue: parseOptionalNumber(sheetCell(row, 7)),
          manualValue: parseOptionalNumber(sheetCell(row, 8)),
          overrideActive: parseOverrideActive(sheetCell(row, 9)),
          lastSyncedAt: sheetCell(row, 10) || null,
          lastOverriddenAt: sheetCell(row, 11) || null
        });
      }
      continue;
    }

    rows.push({
      uuid: '',
      name: sheetCell(row, 0),
      amount: Number(sheetCell(row, 1)) || 0,
      freq: (sheetCell(row, 2) as Frequency) || 'monthly',
      start: sheetCell(row, 3) || defaultStart,
      raise: Number(sheetCell(row, 4)) || 0,
      dataSource: 'manual',
      connectedAccountId: '',
      autoValue: null,
      manualValue: null,
      overrideActive: false,
      lastSyncedAt: null,
      lastOverriddenAt: null
    });
  }

  return rows;
}

function parseExpenseRowsFromSheet(values: unknown[][], defaultStart: string): ExpenseRow[] {
  if (!values || values.length < 2) return [];
  const headers = values[0].map((header) => String(header).trim());
  const hasName = hasHeader(headers, 'Name');
  const hasUuid = headers[0]?.trim().toLowerCase() === 'uuid';
  const rows: ExpenseRow[] = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i] as unknown[];
    if (!row || row.every((cell) => cell === undefined || cell === null || String(cell).trim() === '')) {
      continue;
    }

    if (hasName) {
      const obj = rowToObject(headers, row);
      rows.push({
        uuid: get(obj, 'UUID') || '',
        name: get(obj, 'Name') || '',
        amount: Number(get(obj, 'Amount')) || 0,
        freq: (get(obj, 'Frequency') as Frequency) || 'monthly',
        start: get(obj, 'Start') || defaultStart,
        infl: Number(get(obj, 'Inflation')) || 0,
        source: get(obj, 'Source') || '',
        dataSource: (get(obj, 'DataSource') as ExpenseRow['dataSource']) || 'manual',
        connectedAccountId: get(obj, 'ConnectedAccountId') || '',
        autoValue: parseOptionalNumber(get(obj, 'AutoValue')),
        manualValue: parseOptionalNumber(get(obj, 'ManualValue')),
        overrideActive: parseOverrideActive(get(obj, 'OverrideActive')),
        lastSyncedAt: get(obj, 'LastSyncedAt') || null,
        lastOverriddenAt: get(obj, 'LastOverriddenAt') || null
      });
      continue;
    }

    if (hasUuid) {
      const shifted = looksLikeShiftedName(sheetCell(row, 1));
      if (shifted) {
        rows.push({
          uuid: sheetCell(row, 0),
          name: sheetCell(row, 1),
          amount: Number(sheetCell(row, 2)) || 0,
          freq: (sheetCell(row, 3) as Frequency) || 'monthly',
          start: sheetCell(row, 4) || defaultStart,
          infl: Number(sheetCell(row, 5)) || 0,
          source: sheetCell(row, 6) || '',
          dataSource: (sheetCell(row, 7) as ExpenseRow['dataSource']) || 'manual',
          connectedAccountId: sheetCell(row, 8) || '',
          autoValue: parseOptionalNumber(sheetCell(row, 9)),
          manualValue: parseOptionalNumber(sheetCell(row, 10)),
          overrideActive: parseOverrideActive(sheetCell(row, 11)),
          lastSyncedAt: sheetCell(row, 12) || null,
          lastOverriddenAt: sheetCell(row, 13) || null
        });
      } else {
        rows.push({
          uuid: sheetCell(row, 0),
          name: '',
          amount: Number(sheetCell(row, 1)) || 0,
          freq: (sheetCell(row, 2) as Frequency) || 'monthly',
          start: sheetCell(row, 3) || defaultStart,
          infl: Number(sheetCell(row, 4)) || 0,
          source: sheetCell(row, 5) || '',
          dataSource: (sheetCell(row, 6) as ExpenseRow['dataSource']) || 'manual',
          connectedAccountId: sheetCell(row, 7) || '',
          autoValue: parseOptionalNumber(sheetCell(row, 8)),
          manualValue: parseOptionalNumber(sheetCell(row, 9)),
          overrideActive: parseOverrideActive(sheetCell(row, 10)),
          lastSyncedAt: sheetCell(row, 11) || null,
          lastOverriddenAt: sheetCell(row, 12) || null
        });
      }
      continue;
    }

    rows.push({
      uuid: '',
      name: sheetCell(row, 0),
      amount: Number(sheetCell(row, 1)) || 0,
      freq: (sheetCell(row, 2) as Frequency) || 'monthly',
      start: sheetCell(row, 3) || defaultStart,
      infl: Number(sheetCell(row, 4)) || 0,
      source: sheetCell(row, 5) || '',
      dataSource: 'manual',
      connectedAccountId: '',
      autoValue: null,
      manualValue: null,
      overrideActive: false,
      lastSyncedAt: null,
      lastOverriddenAt: null
    });
  }

  return rows;
}

function rowToObject(headers: string[], row: unknown[]): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((header, idx) => {
    obj[header] = row?.[idx] !== undefined ? String(row[idx]) : '';
  });
  return obj;
}

export async function loadPlanFromSheets(spreadsheetId: string, preFetchedToken?: string | null) {
  const sessionToken = preFetchedToken !== undefined ? preFetchedToken : await getSheetsSessionToken();
  const plan = JSON.parse(JSON.stringify(DEFAULT_PLAN_STATE)) as PlanState;
  const settings = await readSheet(spreadsheetId, 'Settings!A1:C2', sessionToken);
  const settingsRows = rowsToObjects(settings.values ?? []);
  if (settingsRows[0]) {
    const r = settingsRows[0];
    plan.assumptions.inflation = Number(get(r, 'Inflation')) || plan.assumptions.inflation;
    plan.assumptions.start = get(r, 'Start') || plan.assumptions.start;
    plan.assumptions.finnhubKey = get(r, 'FinnhubKey') || '';
  }

  const alternatives = await readSheet(spreadsheetId, 'Alternatives!A1:C', sessionToken);
  const altRows = rowsToObjects(alternatives.values ?? []);
  altRows.forEach((row) => {
    const name = get(row, 'Alternative') || 'Baseline';
    if (!plan.alternatives[name]) {
      plan.alternatives[name] = { income: [], expense: [], asset: [], debt: [] };
    }
    plan.altChartEnabled[name] = get(row, 'EnabledOnChart') === 'TRUE' || name === 'Baseline';
    const color = get(row, 'Color');
    if (color) plan.altColors[name] = color;
  });
  if (altRows.length === 0 && Object.keys(plan.alternatives).length === 0) {
    plan.alternatives.Baseline = { income: [], expense: [], asset: [], debt: [] };
    plan.altChartEnabled.Baseline = true;
  }

  try {
    const augmentsSheet = await readSheet(spreadsheetId, `Augments!A1:L${MAX_DATA_ROW}`, sessionToken);
    const augmentRows = rowsToObjects(augmentsSheet.values ?? []);
    plan.augments = augmentRows.map((row) => {
      const rawEffects = get(row, 'Effects') || '[]';
      let effects: Array<Record<string, unknown>> = [];
      try {
        const parsed = JSON.parse(rawEffects);
        effects = Array.isArray(parsed) ? parsed : [];
      } catch {
        effects = [];
      }
      return {
        id: get(row, 'ID') || `augment_${Date.now().toString(36)}`,
        name: get(row, 'Name') || 'Imported augment',
        category: get(row, 'Category') || 'global',
        description: get(row, 'Description') || '',
        enabled: get(row, 'Enabled') === 'TRUE',
        activation: {
          type: (get(row, 'ActivationType') as any) || 'fixed-date',
          startDate: get(row, 'StartDate') || plan.assumptions.start,
          endDate: get(row, 'EndDate') || null,
          probability: Number(get(row, 'Probability')) || 1
        },
        effects,
        duration: {
          type: (get(row, 'DurationType') as any) || 'instant',
          months: Number(get(row, 'DurationMonths')) || 0
        }
      };
    });
  } catch {
    // Older sheets may not have an Augments tab yet.
  }

  try {
    const checkpointsSheet = await readSheet(spreadsheetId, `Checkpoints!A1:N${MAX_DATA_ROW}`, sessionToken);
    const checkpointRows = rowsToObjects(checkpointsSheet.values ?? []);
    checkpointRows.forEach((row) => {
      const altName = get(row, 'Alt') || 'Baseline';
      if (!plan.checkpoints[altName]) plan.checkpoints[altName] = [];
      const parseJson = (value: string, fallback: unknown) => {
        try {
          return JSON.parse(value || '');
        } catch {
          return fallback;
        }
      };
      plan.checkpoints[altName].push({
        checkpointId: get(row, 'CheckpointId') || `cp_${Date.now().toString(36)}`,
        alt: altName,
        date: get(row, 'Date') || plan.assumptions.start,
        type: (get(row, 'Type') as any) || 'manual',
        netWorth: Number(get(row, 'NetWorth')) || 0,
        assets: parseJson(get(row, 'AssetsJSON'), []),
        debts: parseJson(get(row, 'DebtsJSON'), []),
        income: parseJson(get(row, 'IncomeJSON'), []),
        expenses: parseJson(get(row, 'ExpensesJSON'), []),
        provenance: get(row, 'Provenance') || 'import',
        source: get(row, 'Source') || 'sheet',
        confidence: get(row, 'Confidence') || 'high',
        createdAt: get(row, 'CreatedAt') || new Date().toISOString(),
        immutable: false,
        metadata: parseJson(get(row, 'MetadataJSON'), {})
      } as any);
    });
  } catch {
    // Older sheets may not have a Checkpoints tab yet.
  }

  try {
    const metaSheet = await readSheet(spreadsheetId, 'TMM_META!A1:D', sessionToken);
    const metaRows = rowsToObjects(metaSheet.values ?? []);
    if (metaRows[0]) {
      const seed = get(metaRows[0], 'forecast_seed');
      const fingerprint = get(metaRows[0], 'forecast_fingerprint');
      if (seed) plan.forecastSeed = seed;
      if (fingerprint) plan.forecastFingerprint = fingerprint;
    }
  } catch {
    // TMM_META is optional for older exports.
  }

  for (const altName of Object.keys(plan.alternatives)) {
    const suffix = ` - ${sanitizeSheetName(altName)}`;
    const incomeRange = `Income${suffix}!A1:M`;
    const incomeSheet = await readSheet(spreadsheetId, incomeRange, sessionToken);
    const expenseSheet = await readSheet(spreadsheetId, `Expenses${suffix}!A1:N`, sessionToken);
    const assetSheet = await readSheet(spreadsheetId, `Assets${suffix}!A1:S`, sessionToken);
    const debtSheet = await readSheet(spreadsheetId, `Debts${suffix}!A1:N`, sessionToken);
    const layoutSheet = await readSheet(spreadsheetId, `PB Layout${suffix}!A1:E`, sessionToken);
    const flowsSheet = await readSheet(spreadsheetId, `PB Flows${suffix}!A1:H`, sessionToken);
    plan.alternatives[altName].income = parseIncomeRowsFromSheet(
      incomeSheet.values ?? [],
      plan.assumptions.start
    );
    plan.alternatives[altName].expense = parseExpenseRowsFromSheet(
      expenseSheet.values ?? [],
      plan.assumptions.start
    );
    const assetRows = rowsToObjects(assetSheet.values ?? []);
    plan.alternatives[altName].asset = assetRows.map((row) => ({
      uuid: get(row, 'UUID') || '',
      mode: (get(row, 'Mode') as any) || 'Manual',
      name: get(row, 'Name') || '',
      group: get(row, 'Group') || '',
      value: Number(get(row, 'CurrentValue')) || 0,
      apy: Number(get(row, 'APY')) || 0,
      ticker: get(row, 'Ticker') || '',
      quantity: Number(get(row, 'Qty')) || 0,
      liveprice: Number(get(row, 'LivePrice')) || 0,
      recurAmt: Number(get(row, 'RecurringContribution')) || 0,
      recurFreq: (get(row, 'Frequency') as any) || 'monthly',
      totalContrib: Number(get(row, 'TotalContribution')) || 0,
      source: get(row, 'Source') || '',
      dataSource: (get(row, 'DataSource') as any) || 'manual',
      connectedAccountId: get(row, 'ConnectedAccountId') || '',
      autoValue: get(row, 'AutoValue') ? Number(get(row, 'AutoValue')) : null,
      manualValue: get(row, 'ManualValue') ? Number(get(row, 'ManualValue')) : null,
      overrideActive: get(row, 'OverrideActive') === 'TRUE',
      lastSyncedAt: get(row, 'LastSyncedAt') || null,
      lastOverriddenAt: get(row, 'LastOverriddenAt') || null
    }));
    const debtRows = rowsToObjects(debtSheet.values ?? []);
    plan.alternatives[altName].debt = debtRows.map((row) => ({
      uuid: get(row, 'UUID') || '',
      name: get(row, 'Name') || '',
      bal: Number(get(row, 'Balance')) || 0,
      apr: Number(get(row, 'APR')) || 0,
      pmt: Number(get(row, 'Payment')) || 0,
      freq: (get(row, 'Frequency') as any) || 'monthly',
      start: get(row, 'Start') || plan.assumptions.start,
      source: get(row, 'Source') || '',
      dataSource: (get(row, 'DataSource') as any) || 'manual',
      connectedAccountId: get(row, 'ConnectedAccountId') || '',
      autoValue: get(row, 'AutoValue') ? Number(get(row, 'AutoValue')) : null,
      manualValue: get(row, 'ManualValue') ? Number(get(row, 'ManualValue')) : null,
      overrideActive: get(row, 'OverrideActive') === 'TRUE',
      lastSyncedAt: get(row, 'LastSyncedAt') || null,
      lastOverriddenAt: get(row, 'LastOverriddenAt') || null
    }));

    if (!plan.pipeline.byAlt[altName]) plan.pipeline.byAlt[altName] = { edges: [], layout: {} };
    rowsToObjects(layoutSheet.values ?? []).forEach((row) => {
      const id = `${get(row, 'NodeKind')}:${get(row, 'NodeIndex')}`;
      plan.pipeline.byAlt[altName].layout[id] = { x: Number(get(row, 'X')) || 0, y: Number(get(row, 'Y')) || 0 };
    });
    rowsToObjects(flowsSheet.values ?? []).forEach((row) => {
      plan.pipeline.byAlt[altName].edges.push({
        from: `${get(row, 'FromKind')}:${get(row, 'FromIndex')}`,
        to: `${get(row, 'ToKind')}:${get(row, 'ToIndex')}`,
        mode: get(row, 'Mode').toLowerCase() === 'percent' ? 'percent' : 'fixed',
        amount: Number(get(row, 'Amount')) || 0,
        freq: (get(row, 'Frequency') as any) || 'monthly',
        note: get(row, 'Note') || ''
      });
    });
  }

  const hadUuidChanges = ensureEntityUuids(plan);
  const migrated = migratePlan(plan);
  if (hadUuidChanges) {
    await writeUuidColumnsToSheets(migrated, spreadsheetId, sessionToken);
  }
  return migrated;
}

async function writeUuidColumnsToSheets(plan: PlanState, spreadsheetId: string, sessionToken?: string | null) {
  for (const [altName, alt] of Object.entries(plan.alternatives || {})) {
    const suffix = ` - ${sanitizeSheetName(altName)}`;
    const incomeLastCol = columnLetter(INCOME_ENTITY_HEADERS.length - 1);
    const expenseLastCol = columnLetter(EXPENSE_ENTITY_HEADERS.length - 1);
    await writeWithQueue(
      spreadsheetId,
      `Income${suffix}!A1:${incomeLastCol}1`,
      [[...INCOME_ENTITY_HEADERS]],
      sessionToken
    );
    if (alt.income.length > 0) {
      await writeWithQueue(
        spreadsheetId,
        `Income${suffix}!A2:A${alt.income.length + 1}`,
        alt.income.map((row) => [row.uuid || '']),
        sessionToken
      );
    }
    await writeWithQueue(
      spreadsheetId,
      `Expenses${suffix}!A1:${expenseLastCol}1`,
      [[...EXPENSE_ENTITY_HEADERS]],
      sessionToken
    );
    if (alt.expense.length > 0) {
      await writeWithQueue(
        spreadsheetId,
        `Expenses${suffix}!A2:A${alt.expense.length + 1}`,
        alt.expense.map((row) => [row.uuid || '']),
        sessionToken
      );
    }
    await writeWithQueue(
      spreadsheetId,
      `Assets${suffix}!A1:A${alt.asset.length + 1}`,
      [['UUID'], ...alt.asset.map((row) => [row.uuid || ''])],
      sessionToken
    );
    await writeWithQueue(
      spreadsheetId,
      `Debts${suffix}!A1:A${alt.debt.length + 1}`,
      [['UUID'], ...alt.debt.map((row) => [row.uuid || ''])],
      sessionToken
    );
  }
}

