# Google Sheets auth & UI state persistence

How TMM remembers Google Sheets access, “cleared” state, and `sheets.connected` / `sheets.dismissed` for user auth persistence.

---

## 1. Google Sheets access tokens (server / Supabase)

**Where:** Backend + Supabase table `google_sheets_tokens`.

- **Storage:** `backend/storage/googleTokens.js` uses Supabase (admin client) to read/write rows keyed by **user ID** (`user_id` = Supabase Auth user UUID).
- **Contents:** Encrypted `access_token`, optional `refresh_token`, `expires_at`, `google_user_id`, `google_user_email`. Encryption uses `TOKEN_ENCRYPTION_KEY` (AES-256-GCM).
- **Who is the user?** The backend gets the user from the **Supabase JWT**: frontend sends `Authorization: Bearer <supabase_session.access_token>`; `requireAuth` validates the JWT with Supabase and sets `req.userId = user.id`. All Google token APIs use `req.userId` to load/store tokens.
- **Flow:**
  - **Connect:** OAuth callback (`/api/google/oauth/callback`) receives `state` = Supabase user id, exchanges code for tokens, then `storeGoogleTokens(state, tokens)`.
  - **Use:** `GET /api/google/tokens` (and other Sheets APIs) use `getGoogleTokens(req.userId)` / `getValidGoogleTokens(req.userId)`.
  - **Disconnect:** `DELETE /api/google/tokens` calls `removeGoogleTokens(req.userId)` and deletes the row.

So: **tokens are stored per Supabase user in the DB**. They persist across devices and clears of frontend storage. They are only removed when the user explicitly disconnects (Settings → “Disconnect from Google Sheets”), which calls the DELETE endpoint.

---

## 2. “Cleared” state (what gets reset)

**“Clear All Data”** (Settings) only clears **frontend** storage; it does **not** touch Supabase auth or backend Google tokens.

- **Frontend:** `clearAllAppData()` in `frontend/src/lib/clearAppData.ts` removes a fixed list of `localStorage`/`sessionStorage` keys (plan, spreadsheet id, queue, **tmm_connect_sheets_dismissed**, **tmm_sheets_oauth_done**, tour, onboarding, etc.). It explicitly **does not** remove Supabase auth keys (`sb-*-auth-token`), so the user stays signed in.
- **Backend:** No API is called to clear or revoke Google tokens on “Clear All Data”. So after a clear:
  - Supabase session: **unchanged** (user still signed in).
  - Google tokens in DB: **unchanged** (still present for that user).
  - If the user had chosen “disconnect from sheet first”, we only clear the **stored spreadsheet id** and set `sheets.dismissed` (see below); we still do not revoke Google tokens.

So: **“cleared” is remembered only in the sense that we don’t delete server-side Google tokens on clear.** The “source of truth” for “does this user have Google connected?” is the backend (`GET /api/google/tokens`), not localStorage.

---

## 3. `sheets.connected` (how we know if Google is connected)

- **Source of truth:** Backend. `getGoogleTokenStatus()` calls `GET /api/google/tokens`, which returns `{ connected: Boolean(tokens), ... }` based on whether a row exists for `req.userId` in `google_sheets_tokens`.
- **When it’s set:**
  - **Bootstrap:** On app load, `bootstrapLocalState()` in `frontend/src/state/localBootstrap.ts` runs before the backend is asked. It sets an **initial guess** from localStorage: `sheetsConnected = Boolean(storedSheetId) || (localStorage tmm_sheets_oauth_done === '1')`. Then `integrationsReady` is set true.
  - **After auth + integrations ready:** In `AppShell`, a `useEffect` calls `getGoogleTokenStatus()` and then dispatches `connectionVerified: true` and `connected: <from API>`. So the **real** value comes from the API and overwrites the bootstrap guess.
- **Persistence:** The **connected** value itself is not stored in the DB; it’s derived each time from “does this user have a row in `google_sheets_tokens`?”. The only “memory” on the client is the bootstrap hint (`tmm_sheets_oauth_done`) so we can show a reasonable UI before the first API call. After that, `sheets.connected` is whatever the API says.

So: **for user auth persistence, `sheets.connected` is correct:** it’s driven by the backend and the Supabase session (JWT) that identifies the user. New device or cleared localStorage: once the user signs in, the next `getGoogleTokenStatus()` will return the correct `connected` from the DB.

---

## 4. `sheets.dismissed` (Connect Google Sheets nudge)

- **Where:** **Supabase `profiles.sheets_nudge_dismissed`** (per user), plus **localStorage** key `tmm_connect_sheets_dismissed` as a cache (see `frontend/src/state/localBootstrap.ts` and `frontend/src/lib/sheets/sheetsPrefs.ts`).
- **Read:** Bootstrap sets an initial value from localStorage. After auth, `getSheetsPrefs()` in AppShell fetches `profiles.sheets_nudge_dismissed` and dispatches `state.sheets.dismissed`; backend is the source of truth when authenticated.
- **Write:** When the user dismisses the nudge or clicks Connect, we call `persistSheetsDismissed()` (localStorage) and `setSheetsPrefs({ sheetsNudgeDismissed })` (Supabase). Same on “disconnect from sheet first” in Clear All Data.
- **Cleared by:** `clearAllAppData()` still removes the localStorage key, but after the next auth the app fetches `sheets_nudge_dismissed` from `profiles`, so the nudge state persists across devices and after clear.

So: **dismissed is stored per user in `profiles`** and synced after auth; localStorage is used for first-paint and offline.

---

## 5. Stored spreadsheet id (which sheet is “current”)

- **Where:** **Supabase `profiles.last_spreadsheet_id`** (per user), plus **localStorage** keys `tmm_spreadsheet_id` / `tmm_sheet_id` and **app state** `sheets.spreadsheetId` (see `frontend/src/lib/sheets/storage.ts`, `frontend/src/lib/sheets/sheetsPrefs.ts`, and `appState.tsx`).
- **Read:** After auth, `getSheetsPrefs()` fetches `last_spreadsheet_id`; AppShell dispatches `sheets.spreadsheetId` and calls `setStoredSheetId(id)` when present. The UI uses `appState.sheets.spreadsheetId ?? getStoredSheetId()` (effective sheet id).
- **Write:** When the user picks or creates a sheet we call `setStoredSheetId(id)`, `appDispatch({ type: 'sheets', spreadsheetId: id })`, and `setSheetsPrefs({ lastSpreadsheetId: id })`. On unlink or “disconnect from sheet first” we clear local storage, dispatch `spreadsheetId: null`, and `setSheetsPrefs({ lastSpreadsheetId: null })`.
- **Cleared by:** “Clear All Data” (and “disconnect from sheet first”) clears localStorage and app state and updates `profiles.last_spreadsheet_id` to null when the user chooses to disconnect first.

So: **last spreadsheet id is stored per user in `profiles`**; after clear or on a new device, the app restores it from the backend when authenticated. localStorage and app state are kept in sync for the current session.

---

## Summary table

| What                     | Stored where              | Keyed by        | Cleared on “Clear All Data”? | Survives new device? |
|--------------------------|---------------------------|-----------------|------------------------------|-----------------------|
| Google access/refresh    | Supabase `google_sheets_tokens` | `user_id` (Supabase) | No                           | Yes (per user)        |
| sheets.connected (truth) | Derived from API          | Supabase JWT → userId | N/A (re-fetched)             | Yes                   |
| sheets.dismissed         | Supabase `profiles.sheets_nudge_dismissed` + localStorage cache | `user_id` / device | Local cache yes; backend updated on “disconnect first” | Yes (per user)        |
| Last spreadsheet id      | Supabase `profiles.last_spreadsheet_id` + localStorage + app state | `user_id` / device | Local yes; backend set to null on “disconnect first” | Yes (per user)        |
| Supabase auth session    | Supabase / client         | (session)      | No (explicitly kept)         | Depends on session    |

---

## Recommendations for auth persistence

1. **Google tokens:** Correct. They live in Supabase by `user_id` and are only removed on explicit disconnect.
2. **sheets.connected:** Correct. It’s driven by the API using the same `user_id`.
3. **sheets.dismissed:** Persisted in `profiles.sheets_nudge_dismissed`. After auth the app fetches it and sets `state.sheets.dismissed`; on dismiss/connect we write to Supabase and localStorage.
4. **Spreadsheet id:** Persisted in `profiles.last_spreadsheet_id`. After auth the app fetches it and sets `state.sheets.spreadsheetId` and localStorage; on pick/create/unlink we update Supabase and app state.
