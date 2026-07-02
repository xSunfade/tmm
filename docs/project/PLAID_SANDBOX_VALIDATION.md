# Plaid Sandbox Validation

Use this checklist to validate the Plaid integration in **sandbox** environment against the architecture (see *Robust Plaid Integration Validation* PDF).

## Prerequisites

- Backend: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `TOKEN_ENCRYPTION_KEY` set; Plaid environment = `sandbox`.
- Supabase: migration `006_add_profiles_tier.sql` applied; at least one user has `profiles.plan_tier = 'tmm_plus'`.
- Frontend: Signed-in user with TMM+ tier; Settings > Plaid Integration enabled with correct Backend API URL.

## Validation steps

### 1. Sandbox institution connects successfully

1. Go to **Account Integration**.
2. Click **+ Connect Account** and choose **Connect with Plaid**.
3. In Plaid Link, select a sandbox institution (e.g. "First Platypus Bank" or any sandbox bank).
4. Use sandbox credentials (e.g. `user_good` / `pass_good`).
5. Complete the flow.
6. **Pass:** The new institution appears under "Connected Financial Accounts", grouped by institution. No error toast.

### 2. Multiple Plaid sub-accounts appear under one Plaid account

1. Connect one sandbox institution that returns multiple accounts (e.g. multiple checking/savings).
2. **Pass:** Under a single institution header, multiple sub-accounts (e.g. "Plaid Checking", "Plaid Savings") are listed. Each has its own card with name and "Last sync".

### 3. Each sub-account can be surfaced as a CFA (linked to nodes)

1. With at least one connected institution and multiple sub-accounts visible:
2. Create or use an existing **Income**, **Expense**, **Asset**, or **Debt** node in the current alternative.
3. Drag a sub-account card onto a node (or use the connect flow) to link it.
4. **Pass:** The node shows as linked (e.g. "Unlink" or linked state). Repeat for another sub-account on another node.
5. **Pass:** Each sub-account can be linked to one or more nodes independently (CFA behavior).

### 4. UI clearly groups sub-accounts under their institution

1. With one or more connected institutions:
2. **Pass:** The left column shows institution-level headers (e.g. institution name or "Institution") with a "Disconnected" badge when the token was removed.
3. **Pass:** Under each institution, only that institution’s sub-accounts are listed. Mock accounts (if any) appear in a separate "Mock accounts" section.

### 5. Disconnect marks as disconnected (no CFA delete)

1. With at least one connected institution and sub-accounts linked to nodes:
2. Click **Disconnect** on one institution’s account (or any sub-account under that institution).
3. **Pass:** The backend removes the token only. The institution and its sub-accounts remain in the list with a "Disconnected" badge. Linked nodes still show the link (CFAs preserved); data flow is paused until reconnected.
4. **Pass:** "Remove from sheet" still appears for linked, disconnected accounts; using it clears links in the current sheet only.

### 6. Multi-sheet safety (no cross-sheet bleed)

1. Create **Alternative A** and **Alternative B** (or use existing).
2. In **Alternative A**, link a Plaid sub-account to a node.
3. Switch to **Alternative B**.
4. **Pass:** The same sub-account can be linked to different nodes (or none) in B. Links in A are not visible or editable in B.
5. **Pass:** Switching back to A shows only A’s links.

### 7. Orphan prevention

1. **Remove from sheet:** Link a sub-account to a node, then click **Remove from sheet** for that account.
   - **Pass:** All links from that account in the current alternative are cleared; the account remains in the list (and remains connected if it was connected).
2. **Delete node:** Link a sub-account, then delete that income/expense/asset/debt row elsewhere in the app.
   - **Pass:** The link is removed with the entity; no orphan link remains.
3. **Delete alternative:** Link sub-accounts in one alternative, then delete that alternative.
   - **Pass:** All links for that sheet are removed with the alternative; no cross-sheet or orphan state.

## Optional: API-level checks

- `GET /api/plaid/items` (auth + TMM+): returns `items: [{ item_id }]` for the user.
- `GET /api/plaid/items-with-accounts` (auth + TMM+): returns `items: [{ item_id, connected, accounts: [...] }]`.
- `GET /api/plaid/user-accounts` (auth + TMM+): returns all stored accounts for the user.
- Free-tier user: Plaid endpoints return **403** with message that Plaid is available on TMM+.

## Notes

- Sandbox credentials and test banks: [Plaid Sandbox](https://plaid.com/docs/sandbox/test-credentials/).
- If `profiles` has no row for the user, tier is treated as **free** (no Plaid access).
