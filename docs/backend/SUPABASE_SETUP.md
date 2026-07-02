# Supabase Setup Guide

Complete guide for setting up Supabase for the TMM Plaid Backend.

## Prerequisites

1. Supabase account ([sign up](https://supabase.com))
2. Plaid account with credentials
3. Node.js 18+ installed

## Step 1: Create Supabase Project

1. Go to [Supabase Dashboard](https://app.supabase.com)
2. Click **New Project**
3. Fill in project details:
   - **Name**: `tmm-plaid-backend` (or your preferred name)
   - **Database Password**: Choose a strong password (save it!)
   - **Region**: Choose closest to your users
   - **Pricing Plan**: Free tier is sufficient for development
4. Click **Create new project**
5. Wait for project to be provisioned (2-3 minutes)

## Step 2: Get API Keys

1. In your Supabase project, go to **Settings** > **API**
2. **Opt in to new API keys** (if not already enabled):
   - Look for the option to enable new API keys
   - This creates a default publishable key and a single secret API key
   - New keys provide better security, zero-downtime rotation, and instant revocation
3. Copy the following values (you'll paste these into your `.env` file in Step 5):
   - **Project URL** → `SUPABASE_URL`
   - **Publishable key** → `SUPABASE_PUBLISHABLE_KEY` (replaces deprecated anon key)
     - New keys start with `sb_publishable_` prefix
     - Safe to use client-side (respects RLS policies)
   - **Secret key** → `SUPABASE_SECRET_KEY` (replaces deprecated service_role key)
     - New keys start with `sb_secret_` prefix
     - **Keep this secret!** Never commit to version control
     - Secret keys are hidden by default - click "reveal" to see the value
     - Cannot be used in browsers (will fail with HTTP 401)
     - Each reveal action appears in your organization's Audit Log
   
   **Note:** You can copy these values now and paste them into your `.env` file when you create it in Step 5. Alternatively, you can create the `.env` file first and paste them directly.

## Step 3: Create Database Schema

1. In Supabase Dashboard, go to **SQL Editor**
2. Click **New Query**
3. Copy and paste the contents of `supabase/migrations/001_initial_schema.sql`
4. Click **Run** (or press `Ctrl+Enter`)
5. Verify tables were created:
   - Go to **Table Editor**
   - You should see: `users`, `plaid_tokens`, `accounts`, `transactions`

## Step 4: Configure Row Level Security (RLS)

The migration script creates basic RLS policies. For production with user authentication:

1. Go to **Authentication** > **Policies**
2. Update policies to use `auth.uid()` instead of allowing all access
3. Example policy for users table:
   ```sql
   CREATE POLICY "Users can view own data" 
   ON users FOR SELECT 
   USING (auth.uid() = id);
   ```

**Note**: For now, the service role key bypasses RLS, which is appropriate for server-side operations. When implementing user authentication, update policies accordingly.

## Step 5: Configure Environment Variables

Create a `.env` file in `backend/`:

```env
# Plaid Configuration
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_plaid_secret
PLAID_ENVIRONMENT=sandbox

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-key
SUPABASE_SECRET_KEY=your-secret-key

# Server Configuration
PORT=3000
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173

# Optional: Token Encryption
TOKEN_ENCRYPTION_KEY=your-32-byte-hex-key
```

## Step 6: Install Dependencies

```bash
cd backend
npm install
```

## Step 7: Test Connection

```bash
npm start
```

You should see:
```
🚀 TMM Plaid Backend API running on port 3000
📡 Environment: development
🌐 CORS origins: http://localhost:5173, http://127.0.0.1:5173
💾 Database: Supabase PostgreSQL
🔐 Plaid environment: sandbox
```

Test the health endpoint:
```bash
curl http://localhost:3000/api/health
```

Should return:
```json
{"status":"ok","timestamp":"2024-01-01T00:00:00.000Z"}
```

## Step 8: Deploy Backend Server

The Express server can be deployed to various platforms:

### Option 1: Vercel

1. Install Vercel CLI: `npm i -g vercel`
2. In `backend/`, run: `vercel`
3. Set environment variables in Vercel dashboard
4. Deploy: `vercel --prod`

### Option 2: Render

1. Connect your repository to Render
2. Create a new **Web Service**
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variables in dashboard
6. Deploy

### Option 3: Fly.io

1. Install Fly CLI: `flyctl auth login`
2. In `backend/`, run: `flyctl launch`
3. Set secrets: `flyctl secrets set SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SECRET_KEY=...`
4. Deploy: `flyctl deploy`

### Option 4: Railway

1. Connect repository to Railway
2. Create new project
3. Add environment variables
4. Deploy automatically on push

## Production Checklist

- [ ] Supabase project created
- [ ] Database schema migrated
- [ ] RLS policies configured (if using auth)
- [ ] Environment variables set in hosting platform
- [ ] `SUPABASE_SECRET_KEY` kept secure (never commit!)
- [ ] CORS_ORIGIN set to production frontend URL
- [ ] Health endpoint tested
- [ ] Plaid connection tested end-to-end

## Security Notes

1. **Never commit `.env` file** - Contains sensitive credentials
2. **Secret Key** - Keep `SUPABASE_SECRET_KEY` secret! It bypasses RLS and cannot be used in browsers
3. **Secret Key Visibility** - Secret keys are hidden by default in Supabase dashboard - click "reveal" to view
4. **Use HTTPS** - Always use HTTPS in production
5. **Token Encryption** - Set `TOKEN_ENCRYPTION_KEY` in production
6. **RLS Policies** - Update policies when implementing user authentication
7. **CORS** - Set `CORS_ORIGIN` to your exact frontend domain
8. **Key Rotation** - New API keys support zero-downtime rotation and instant revocation
9. **Audit Logging** - Each secret key reveal appears in your organization's Audit Log

## Troubleshooting

### Connection Errors

**Error: `Failed to connect to Supabase`**
- Verify `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are correct
- Check Supabase project is active
- Verify network connectivity
- Ensure you've opted in to new API keys in Supabase dashboard

### Schema Errors

**Error: `relation "users" does not exist`**
- Run the migration SQL in Supabase SQL Editor
- Verify migration completed successfully
- Check table names match exactly

### RLS Policy Errors

**Error: `new row violates row-level security policy`**
- Check RLS policies in Supabase dashboard
- Verify service role key is being used for server operations
- Update policies if implementing user authentication

### Token Storage Errors

**Error: `Token not found`**
- Verify `plaid_tokens` table exists
- Check user was created successfully
- Verify item_id matches exactly

## Next Steps

1. **User Authentication**: Implement Supabase Auth for multi-user support
2. **Webhooks**: Set up Plaid webhooks for real-time updates
3. **Monitoring**: Set up Supabase monitoring and alerts
4. **Backups**: Configure Supabase database backups
5. **Scaling**: Monitor usage and upgrade plan if needed

## Support

- [Supabase Documentation](https://supabase.com/docs)
- [Supabase Discord](https://discord.supabase.com)
- [Plaid Documentation](https://plaid.com/docs)
