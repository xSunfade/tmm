import { getSupabaseClient } from '../supabaseClient';

export type SheetsPrefs = {
  sheetsNudgeDismissed: boolean;
  lastSpreadsheetId: string | null;
};

export type SheetsPrefsUpdate = {
  sheetsNudgeDismissed?: boolean;
  lastSpreadsheetId?: string | null;
};

/**
 * Fetch sheets preferences from profiles (requires authenticated user).
 * Returns null if not authenticated or fetch fails.
 */
export async function getSheetsPrefs(): Promise<SheetsPrefs | null> {
  try {
    const supabase = getSupabaseClient();
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user?.id;
    if (!userId) return null;

    const { data, error } = await supabase
      .from('profiles')
      .select('sheets_nudge_dismissed, last_spreadsheet_id')
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) {
      return null;
    }

    return {
      sheetsNudgeDismissed: Boolean(data.sheets_nudge_dismissed),
      lastSpreadsheetId: data.last_spreadsheet_id ?? null
    };
  } catch {
    return null;
  }
}

/**
 * Update sheets preferences (partial update; only provided fields are written).
 * No-op if not authenticated.
 */
export async function setSheetsPrefs(prefs: SheetsPrefsUpdate): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user?.id;
    if (!userId) return;

    const updates: { sheets_nudge_dismissed?: boolean; last_spreadsheet_id?: string | null } = {};
    if (prefs.sheetsNudgeDismissed !== undefined) {
      updates.sheets_nudge_dismissed = prefs.sheetsNudgeDismissed;
    }
    if (prefs.lastSpreadsheetId !== undefined) {
      updates.last_spreadsheet_id = prefs.lastSpreadsheetId ?? null;
    }
    if (Object.keys(updates).length === 0) return;

    await supabase.from('profiles').update(updates).eq('id', userId);
  } catch {
    // Non-blocking; prefer app to continue
  }
}
