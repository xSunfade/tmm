# The Money Machine (TMM)

## Frontend (Vite + React + TypeScript)

The React app lives in `frontend/` and is the single source of truth for the UI.

## Docs

Project documentation lives under `docs/`:

- `docs/project/` (architecture + audit + auth setup)
- `docs/backend/` (backend + Supabase setup)
- `docs/tests/` (test suite docs)
- `docs/security/` (security policies, incident response, privacy)
- `docs/SLACK_CHANNELS.md` (workspace channel structure and purposes)
- `docs/SLACK_QUICK_REFERENCE.md` (quick channel lookup for humans and AI agents)

### Run locally

Start both the frontend and backend (API runs on port 3000; Vite proxies `/api` to it):

```bash
# Terminal 1: Backend
cd backend && npm install && npm start

# Terminal 2: Frontend
cd frontend && npm install && npm run dev
```

For Google Sheets and Plaid features, ensure `backend/.env` has the required keys (see `backend/.env.example`).

### Build

```bash
cd frontend
npm install
npm run build
```

### UI flow controller

The single authoritative overlay state machine is in:

- `frontend/src/state/flowState.ts` (flow resolution)
- `frontend/src/app/AppShell.tsx` (entry point + overlay slot)

### Dev overrides

Set these environment variables in `frontend/.env` or your shell:

- `VITE_DEV_FORCE_ONBOARDING=true` forces onboarding during dev.
- `VITE_DEV_FORCE_ONBOARDING_ALLOWLIST=dev@tmm.ai,another@tmm.ai` optionally limits
  the override to specific emails.
