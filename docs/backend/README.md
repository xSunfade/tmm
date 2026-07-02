# TMM Plaid Backend API

Backend API server for secure Plaid integration. This server handles all Plaid API calls server-side, keeping secrets and access tokens secure. Uses Supabase PostgreSQL for persistent data storage with encryption.

## Installation

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file with your configuration:
```bash
# Create .env file manually (see SUPABASE_SETUP.md for details)
```

3. Configure your `.env` file:
```env
# Plaid Configuration (Required)
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_plaid_secret
PLAID_ENVIRONMENT=sandbox

# Supabase Configuration (Required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_SECRET_KEY=your-secret-key

# Google OAuth Client ID (for Google Sheets integration - frontend use)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com

# Server Configuration
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173

# Optional: Token Encryption
TOKEN_ENCRYPTION_KEY=your-32-byte-hex-key
```

## Running Locally

Start the development server:
```bash
npm start
```

Or with auto-reload:
```bash
npm run dev
```

The server will run on `http://localhost:3000` by default.

## API Endpoints

### Health Check
- `GET /api/health` - Check if server is running

### Plaid Integration
- `POST /api/plaid/create-link-token` - Create Plaid Link token
  - Body: `{ userId?: string }`
  - Returns: `{ link_token: string }`

- `POST /api/plaid/exchange-token` - Exchange public token for access token
  - Body: `{ public_token: string, userId?: string }`
  - Returns: `{ item_id: string }`

- `POST /api/plaid/accounts` - Fetch accounts for an item
  - Body: `{ item_id: string, userId?: string }`
  - Returns: `{ accounts: Array }`

- `POST /api/plaid/balance` - Fetch account balance
  - Body: `{ item_id: string, account_id?: string, userId?: string }`
  - Returns: `{ balance: number, accounts: Array }`

- `POST /api/plaid/transactions` - Fetch transactions
  - Body: `{ item_id: string, start_date: string, end_date: string, userId?: string }`
  - Returns: `{ transactions: Array }`

- `POST /api/plaid/transactions/sync` - Sync Plaid transactions into local DB via `/transactions/sync`
  - Body: `{ item_id?: string, force_refresh?: boolean }`
  - Returns: `{ ok: true, results: Array }`

- `GET /api/plaid/transactions/db` - Read synced transactions from local DB
  - Query: `account_id?`, `start_date?`, `end_date?`, `limit?`, `offset?`
  - Returns: `{ transactions: Array }`

- `POST /api/plaid/disconnect` - Disconnect an item
  - Body: `{ item_id: string, userId?: string }`
  - Returns: `{ success: boolean }`

### History
- `POST /api/history/archive` - Persist archive snapshots + daily net worth point for current user
  - Body: `{ use_month_end?: boolean }`
  - Returns: `{ ok: true, snapshot: {...} }`

- `POST /api/history/net-worth/tmm` - Upsert daily per-alt TMM net-worth points (manual + connected totals)
  - Body: `{ points: Array<{ alt: string; net_worth: number }>, as_of?: string }`
  - Returns: `{ ok: true, point_date, upserted_count }`

- `GET /api/history/net-worth/tmm` - Read per-alt TMM net-worth history points
  - Query: `start_date?`, `end_date?`, `alt_names?` (CSV)
  - Returns: `{ points: Array<{ alt, date, value, ... }> }`

## Environment Variables

### Required
- `PLAID_CLIENT_ID` - Your Plaid client ID
- `PLAID_SECRET` - Your Plaid secret (keep this secure!)
- `PLAID_ENVIRONMENT` - Plaid environment: `sandbox`, `development`, or `production`
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY` - Your Supabase publishable key (replaces deprecated anon key)
- `SUPABASE_SECRET_KEY` - Your Supabase secret key (replaces deprecated service_role key, keep this secret!)

### Optional
- `GOOGLE_CLIENT_ID` - Google OAuth Client ID for Google Sheets integration (frontend use)
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment: `development` or `production` (default: development)
- `CORS_ORIGIN` - Production CORS origin (dev origins auto-added: localhost:5173, 127.0.0.1:5173)
- `TOKEN_ENCRYPTION_KEY` - 32-byte hex key for token encryption (auto-generated if not set)
- `PLAID_TRANSACTIONS_SYNC_INTERVAL_MINUTES` - Scheduled sync interval in minutes (default: `1440`; set `0` to disable)
- `PLAID_WEBHOOK_SECRET` - Shared secret expected in `x-plaid-webhook-secret` for `/api/webhooks/plaid`
- `HISTORY_SNAPSHOT_INTERVAL_MINUTES` - Scheduled archive interval in minutes (default: `10080`; set `0` to disable)
- `HISTORY_ARCHIVE_NOOP_WINDOW_MINUTES` - Skip redundant archive writes when equivalent point was updated recently (default: `0`, disabled)
- `HISTORY_TMM_WRITE_USER_HOURLY_MAX` - Per-user hourly cap for writing TMM history points (default: `12`)
- `HISTORY_TMM_WRITE_GLOBAL_HOURLY_MAX` - Global hourly cap for writing TMM history points (default: `10000`)
- `HISTORY_TMM_WRITE_GLOBAL_USER_ID` - Optional auth UUID used for global TMM history write quota tracking

## Multi-Environment Support

The backend automatically detects the environment and configures accordingly:

### Development Mode (`NODE_ENV=development`)
- Loads `.env` file automatically
- Database: Supabase PostgreSQL (configured via `SUPABASE_URL`)
- CORS: Allows `localhost:5173`, `127.0.0.1:5173`, and `CORS_ORIGIN`
- Verbose logging enabled
- Works with Vite dev server on port 5173

### Production Mode (`NODE_ENV=production`)
- Reads from `process.env` (set by hosting platform)
- Database: Supabase PostgreSQL (configured via `SUPABASE_URL`)
- CORS: Only allows `CORS_ORIGIN`
- Minimal error logging

## Database Storage

### Supabase PostgreSQL
- Persistent token storage with encryption
- Tables: `users`, `plaid_tokens`, `accounts`, `transactions`
- Row Level Security (RLS) enabled
- Auto-scaling and managed backups
- See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for schema setup

### Plaid Transactions Sync storage model
- The backend stores a per-item cursor in `plaid_tokens.transactions_sync_cursor`
- Plaid updates are applied incrementally (`added`, `modified`, `removed`) to the `transactions` table
- Scheduled sync is intended to align with Plaid's own 1-4x/day refresh cadence; on-demand refresh can be triggered via `force_refresh` in `/api/plaid/transactions/sync`

## Security Considerations

1. **Never commit `.env` file** - It contains sensitive credentials
2. **Use environment variables** - Never hardcode secrets in code
3. **CORS Configuration** - Set `CORS_ORIGIN` to your client domain in production
4. **Token Storage** - Uses Supabase PostgreSQL with AES-256-GCM encryption
5. **HTTPS** - Always use HTTPS in production
6. **Encryption Key** - Generate a secure `TOKEN_ENCRYPTION_KEY` for production
7. **Secret Key** - Keep `SUPABASE_SECRET_KEY` secret (bypasses RLS, cannot be used in browsers)
8. **Rate Limiting** - Consider adding rate limiting for production use
9. **RLS Policies** - Update Row Level Security policies when implementing user authentication

## Setup Instructions

See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for complete setup instructions including:
- Creating a Supabase project
- Running database migrations
- Configuring Row Level Security
- Setting up environment variables
- Deployment options

## Deployment

### Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. In `backend/`, run: `vercel`
3. Set environment variables in Vercel dashboard
4. Deploy: `vercel --prod`

### Render

1. Connect your repository to Render
2. Create a new **Web Service**
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variables in dashboard
6. Deploy

### Fly.io

1. Install Fly CLI: `flyctl auth login`
2. In `backend/`, run: `flyctl launch`
3. Set secrets: `flyctl secrets set SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SECRET_KEY=...`
4. Deploy: `flyctl deploy`

### Railway

1. Connect repository to Railway
2. Create new project
3. Add environment variables
4. Deploy automatically on push

## Local Development Workflow

### Backend Setup

1. **Install dependencies:**
   ```bash
   cd backend
   npm install
   ```

2. **Create `.env` file:**
   ```bash
   cp .env.example .env
   # Edit .env with your actual credentials
   ```

3. **Start backend server:**
   ```bash
   npm start
   # Server runs on http://localhost:3000
   ```

### Frontend Setup

Run the React frontend with Vite:

```bash
cd frontend
npm install
npm run dev
```

### CORS Configuration

The backend automatically allows localhost origins in development:
- `http://localhost:5173`
- `http://127.0.0.1:5173`
- Plus any origin specified in `CORS_ORIGIN` environment variable

No additional CORS configuration needed for local development!

### Environment Variables

See `backend/.env.example` for all required variables:
- Plaid credentials (sandbox for development)
- Supabase credentials (use dev project)
- Token encryption key (generate with `openssl rand -hex 32`)

## Development Notes

- **Database**: Supabase PostgreSQL (managed, no local setup needed)
- **Storage**: All data stored in Supabase (tokens, accounts, transactions)
- **Multi-Environment**: Automatic detection and configuration
- **CORS**: Supports multiple origins for development
- **Encryption**: Tokens encrypted at rest using AES-256-GCM
- **Error Handling**: Environment-aware (verbose in dev, minimal in prod)

## Troubleshooting

### Database connection errors
- Verify `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are correct
- Check Supabase project is active
- Verify network connectivity
- See [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) for detailed troubleshooting

### CORS errors
- Verify `CORS_ORIGIN` matches your frontend URL exactly
- In development, localhost origins are auto-allowed
- Check browser console for specific CORS error

### Token not found
- Verify `plaid_tokens` table exists in Supabase
- Check user was created successfully
- Verify item_id matches exactly
- Check Supabase logs for errors

### Schema errors
- Run migration SQL in Supabase SQL Editor
- Verify migration completed successfully
- Check table names match exactly

For more help, see [SUPABASE_SETUP.md](./SUPABASE_SETUP.md) troubleshooting section.