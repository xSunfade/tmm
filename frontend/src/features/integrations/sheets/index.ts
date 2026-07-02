import type { PlanState } from '../../../lib/plan/types';
import { getGoogleAuthUrl, createSpreadsheet } from '../../../lib/sheets/api';
import { getStoredSheetId, setStoredSheetId } from '../../../lib/sheets/storage';
import { syncPlanToSheets, sanitizeSheetName } from '../../../lib/sheets/sync';

export async function connectSheets() {
  const url = await getGoogleAuthUrl();
  window.location.href = url;
}

export async function ensureSheet(plan: PlanState) {
  let sheetId = getStoredSheetId();
  if (!sheetId) {
    const altNames = Object.keys(plan.alternatives || {});
    const altSheets = altNames.flatMap((name) => {
      const suffix = ` - ${sanitizeSheetName(name)}`;
      return [`Income${suffix}`, `Expenses${suffix}`, `Assets${suffix}`, `Debts${suffix}`, `PB Layout${suffix}`, `PB Flows${suffix}`];
    });
    const created = await createSpreadsheet('The Money Machine Plan', [
      'Settings',
      'Alternatives',
      'Augments',
      'Checkpoints',
      'TMM_META',
      ...altSheets
    ]);
    const id = created.spreadsheetId;
    if (typeof id !== 'string') throw new Error('Create spreadsheet did not return an ID');
    sheetId = id;
    setStoredSheetId(sheetId);
  }
  if (!sheetId) throw new Error('No spreadsheet ID');
  return sheetId;
}

export async function syncToSheets(plan: PlanState) {
  const sheetId = await ensureSheet(plan);
  await syncPlanToSheets(plan, sheetId);
  return sheetId;
}
