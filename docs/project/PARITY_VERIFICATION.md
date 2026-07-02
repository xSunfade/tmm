# TMM Parity Verification

This document records parity verification checks against the legacy behaviors and workflows.

## Environment
- Date: 2026-01-26
- Build: Vite/React/Tailwind
- Notes: Automated UI walkthroughs not executed in this environment. Steps below describe the intended verification flow.

## Workflow Checks
- UI parity: sidebar shell (logo, offline banner, nav, run/check-in, auth/sheets)
  - Status: Not executed
- UI parity: Dashboard layout (metrics, control strip, chart legend/slider, events)
  - Status: Not executed
- UI parity: Simulation layout (augments, backup/export, audit trail)
  - Status: Not executed
- UI parity: Accounts tables + alternatives controls
  - Status: Not executed
- UI parity: Pipeline layout + controls row
  - Status: Not executed
- UI parity: Goals layout + cards
  - Status: Not executed
- UI parity: Settings layout (assumptions, market data, restore, auth, plaid, tour, checkpoints, sync)
  - Status: Not executed
- Wiring: Run Simulation button updates last-run audit panel
  - Status: Not executed
- Wiring: Weekly Check-In button opens modal and creates checkpoint
  - Status: Not executed
- Wiring: Account Integration drag-connect + override drawer
  - Status: Not executed
- Wiring: Pipeline header controls (add node, auto-layout, commit)
  - Status: Not executed
- Wiring: Goals progress uses legacy formula
  - Status: Not executed
- Wiring: Sheets queue badge + error status + flush on reconnect
  - Status: Not executed
- Onboarding flow: survey → path → tour
  - Status: Not executed (requires manual browser session)
- Restore accept/decline behavior
  - Status: Not executed
- Accounts editing → simulation update
  - Status: Not executed
- Alternatives switching + chart toggles
  - Status: Not executed
- Pipeline flow creation → account propagation + layout persistence
  - Status: Not executed
- Simulation run (monthly/daily) + parity runner hashes
  - Status: Not executed
- Charts (net worth, asset pie, cashflow) interactions + slider
  - Status: Not executed
- Net Worth chart: augment asymptotes + SVG icons + hover tooltip
  - Status: Not executed
- Net Worth chart: cursor-follow crosshair + multi-alt tooltip + intersection dots
  - Status: Not executed
- Net Worth chart: timeline slider height + mini projection + window handles
  - Status: Not executed
- Google Sheets connect → create sheet → sync → refresh → queue flush
  - Status: Not executed
- XLSX export → import → rehydrate state
  - Status: Not executed
- UUID normalization after load/import/sheets refresh
  - Status: Not executed
- Plaid connect → accounts list → link entity → overrides
  - Status: Not executed

## Next Steps
- Run the app locally and verify each step above.
- Use the Dev Debug panel → Parity Runner to capture hashes per fixture.
- Capture any deviations and iterate on parity fixes.

