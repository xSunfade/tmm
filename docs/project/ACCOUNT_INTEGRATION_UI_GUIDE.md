# Account Integration UI — User guide

This document explains the Connected Financial Accounts (CFA) section, the ID shown there, and the actions: Disconnect, Reconnect, Remove (trash icon at institution or per account), and Unlink. Item-level actions appear once per Plaid institution; each CFA card shows per-account status, Unlink when linked, and a trash icon to remove only that account.

---

## What is the ID below “Connected Financial Accounts”?

The label shown **above each group of accounts** (e.g. “Plaid Checking” or a long string like `KX787A48vaupGAABD9Azun1mmz9lolcVV7Nvd`) is:

- **Institution name** when Plaid provides it (e.g. “Chase”, “Plaid Checking” in sandbox).
- **Plaid Item ID** when the institution name is missing.

So the long alphanumeric “ID” is **Plaid’s Item ID** (`item_id`). It uniquely identifies one **Plaid Item** — i.e. one connection to one financial institution. All accounts (checking, savings, etc.) that come from that same login to that institution share the same Item ID. The app uses it to group accounts by institution and to call Plaid’s disconnect API for that connection. End users don’t need to know or use this ID; it’s technical context.

---

## Disconnect vs Remove vs Remove from sheet

### Disconnect from Plaid (Plaid accounts only)

- **What it does:** Calls the backend to **disconnect the Plaid Item** (the connection to that bank). The backend revokes the Plaid access token for that Item. The account(s) from that institution stay in the app’s list but are marked **Plaid Connection Lost** (no new sync; no balance/transaction calls).
- **When you see it:** Button **"Disconnect from Plaid"** only for **connected** Plaid accounts.

### Remove (trash icon) — item header when Plaid Connection Lost

- **What it does:** Removes the **entire Plaid Item** (and all its accounts) from your list. Opens an "Are you sure?" modal before calling the backend.
- **When you see it:** A **trash icon** in the **institution header** only when that item is in "Plaid Connection Lost" state (disconnected).
- **Effect:** That institution and all its accounts disappear from the CFA list after you confirm. To see them again, you would need to connect that institution again via Plaid.

### Remove (single account) — trash icon on each CFA card

- **What it does:** Removes **only that one account** (e.g. one 401k) from the CFA list. The institution and its other accounts stay.
- **When you see it:** Each Plaid CFA card (connected or disconnected) has a **trash icon** next to the account name/Unlink row.
- **Effect:** That account disappears from the list. **To add it back:** reconnect the institution in Plaid and re-select that account in the Plaid Link flow.

### Unlink (on a CFA card or TMM node)

- **What it does:** Unlinks this **Plaid account** from **TMM nodes in the current alternative only**. It does **not** disconnect from Plaid and does **not** remove the account from the CFA list. For each income/expense/asset/debt row in the **current** alternative that has `connectedAccountId` equal to this account, it:
  - Clears `connectedAccountId` (and related Plaid-derived fields).
  - Sets the entity back to manual entry using its existing `manualValue` (or 0).
- **When you see it:** The “Unlink” button on a CFA card appears when **at least one** TMM node in the current alternative is linked to this account (i.e. there is at least one green line from this account to a node).
- **Effect:** The green connection lines from this account to nodes in the **current** alternative disappear. The account remains in the left-hand list and remains in Plaid (you can still see it, sync it, and link it again). Other alternatives are not changed.

### Unlink (on a TMM node only)

- **What it does:** Unlinks **that one TMM node** from its connected account. Same field updates as above, but for **only the node you clicked** (one entity in the current alternative).
- **When you see it:** Each TMM node row that has a linked account shows an "Unlink" button.
- **Relation to Remove from sheet:** If only **one** node is linked to that account, clicking "Unlink" on that node has the **same outcome** as clicking "Remove from sheet" on the account card (that single link is removed). If **multiple** nodes are linked to the same account, "Unlink" only clears the one node you clicked; "Remove from sheet" clears **all** links from that account in the current alternative.

---

## How to add an account back to the sheet (re-link to a TMM node)

After “**Unlink** (on the CFA card), the account is still in “Connected Financial Accounts” and still connected to Plaid; only the **links** to TMM nodes in the current alternative were cleared.

**To link it again:**

1. Stay on **Account Integration**.
2. In the left column, find the account under “Connected Financial Accounts”.
3. **Drag** the account card and **drop** it onto the desired TMM node (e.g. an ASSET or INCOME row) in the right-hand “TMM Nodes” column.  
   - Only **connected** (non-Disconnected) Plaid accounts and mock accounts are draggable.
4. That node will then show the account as linked (green line) and use that account’s data for that row in the current alternative.

There is no separate “Add to sheet” menu; **drag-and-drop from the account card to the node** is the way to add (or re-add) an account to the sheet for a given node.

---

## Summary table

| Action              | Removes from CFA list? | Disconnects Plaid? | Unlinks from TMM nodes?        |
|---------------------|------------------------|--------------------|--------------------------------|
| **Disconnect from Plaid** | No                | Yes (that Item)   | No                             |
| **Reconnect**       | No                     | No (restores in place) | No                         |
| **Remove** (item header trash) | Yes (entire item + all accounts) | N/A (item already disconnected) | No (plan links can stay until user unlinks) |
| **Remove** (single account, per-CFA trash) | Yes (that account only) | No | No (to add back: reconnect institution and re-select account) |
| **Unlink** (CFA card) | No                   | No                 | Yes, current alternative only |

---

## Collapsible CFA groups and flow lines

**Plaid item groups** are collapsible (click the institution header); when collapsed, flow lines from that group's accounts start from the institution header. When you **collapse** a TMM node category (e.g. ASSET), the green flow line from a connected account no longer snaps to the **center** of the category header. It now ends at the **left edge** of the header at the same height, so the line transitions smoothly “sideways” into the category instead of jumping to the middle of the column.
