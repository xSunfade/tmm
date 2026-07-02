# TMM Authentication Setup Guide

This document provides step-by-step instructions for setting up authentication in TMM (Vite + React frontend + Supabase Auth).

## Overview

TMM uses **Supabase Auth** for user authentication.

## Prerequisites

- Supabase project (already set up)
- Google Cloud Console access (for Google OAuth and/or Google Sheets OAuth)
- A deployed frontend domain (or local dev on Vite)

## Step 1: Supabase Auth Configuration

### 1.1 Enable Auth Providers

1. Go to your Supabase Dashboard
2. Navigate to **Authentication** → **Providers**
3. Enable **Email** provider:
   - Toggle "Enable Email provider" to ON
   - Configure email templates if desired
4. Enable **Google** provider:
   - Toggle "Enable Google provider" to ON
   - You'll need Google OAuth credentials (see Step 2)

### 1.2 Configure Site URL and Redirect URLs

1. Go to **Authentication** → **URL Configuration**
2. Set **Site URL** to your production domain (React frontend):
   ```
   https://your-app.vercel.app
   ```
3. Add **Redirect URLs** (one per line). At minimum include local dev and production:
   ```
   https://your-app.example.com
   http://localhost:5173
   ```
   **Important for Local Development**: The redirect URL must match EXACTLY, including protocol and port.
   
   If you're using a different port, add it to the redirect URLs list.
   
   **Common Issue**: If you see "redirect_uri_mismatch" error, check that:
   1. The redirect URL in Supabase Dashboard matches your exact local server URL
   2. The port number matches what's shown in your browser's address bar
   3. The protocol is `http://` (not `https://`) for localhost

### 1.3 Get Supabase Credentials

1. Go to **Project Settings** → **API**
2. Note your credentials:
   - **Project URL**: `https://your-project.supabase.co`
   - **anon/public key**: Your publishable key (safe for frontend)
   - **service_role key**: Your secret key (backend only, never expose)

## Step 2: Google Cloud Console Setup

### 2.1 Create OAuth 2.0 Client ID for Google Sheets

This Client ID is used for Google Sheets integration (frontend-safe).

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (or create a new one)
3. Navigate to **APIs & Services** → **Credentials**
4. Click **Create Credentials** → **OAuth 2.0 Client ID**
5. Configure:
   - **Application type**: Web application
   - **Name**: "TMM Google Sheets Integration"
   - **Authorized JavaScript origins**:
     ```
     https://your-app.example.com
     http://localhost:5173
     ```
   - **Authorized redirect URIs**: if you use an explicit callback route in your app, add it here.
6. Click **Create**
7. **Copy the Client ID** (not the secret - not needed for frontend)

### 2.2 Create OAuth 2.0 Client ID for Supabase Auth

This Client ID + Secret is used by Supabase for Google OAuth.

1. In the same Google Cloud Console project
2. Click **Create Credentials** → **OAuth 2.0 Client ID** again
3. Configure:
   - **Application type**: Web application
   - **Name**: "TMM Supabase Auth"
   - **Authorized JavaScript origins**:
     ```
     https://your-project.supabase.co
     ```
   - **Authorized redirect URIs**:
     ```
     https://your-project.supabase.co/auth/v1/callback
     ```
4. Click **Create**
5. **Copy both the Client ID and Client Secret**

### 2.3 Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Configure:
   - **User Type**: External (or Internal if using Google Workspace)
   - **App name**: "The Money Machine"
   - **Support email**: Your email
   - **Scopes**: Add `email`, `profile`, `openid`
   - **Test users**: Add test email addresses (if in testing mode)
3. Save and continue

### 2.4 Enable Required APIs

1. Go to **APIs & Services** → **Library**
2. Enable:
   - **Google Sheets API**
   - **Google Drive API** (for file picker)

## Step 3: Configure Supabase Google Provider

1. Go back to Supabase Dashboard
2. Navigate to **Authentication** → **Providers** → **Google**
3. Enter:
   - **Client ID (for Supabase Auth)**: From Step 2.2
   - **Client Secret (for Supabase Auth)**: From Step 2.2
4. Click **Save**

## Step 4: Environment Variables

### 4.1 Frontend (Vite) environment variables

Set these in `frontend/.env` (or your hosting platform’s environment variables):

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

### 4.2 Backend Environment Variables

In your Vercel project (backend):

1. Go to **Settings** → **Environment Variables**
2. Add (in addition to existing vars):

```
GOOGLE_CLIENT_ID=your-google-sheets-client-id.apps.googleusercontent.com
```

All other backend vars should already be set (Supabase, Plaid, etc.).

### 4.3 Static HTML injection note (obsolete)

TMM no longer relies on build-time injection into a root `index.html`; the frontend is built with Vite and reads `import.meta.env.VITE_*`.

## Step 5: Database Migration

1. Go to Supabase Dashboard → **SQL Editor**
2. Open the migration file: `backend/supabase/migrations/004_add_auth_tables.sql`
3. Copy and paste the SQL into the editor
4. Click **Run**
5. Verify the `google_sheets_tokens` table was created:
   - Go to **Table Editor**
   - Check that `google_sheets_tokens` table exists
   - Verify RLS policies are enabled

## Step 6: Testing

### 6.1 Local Development

1. Set environment variables in `.env` file (for local testing):
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   GOOGLE_CLIENT_ID=your-google-sheets-client-id
   ```

2. Start the dev servers:

```bash
cd frontend
npm install
npm run dev
```

```bash
cd backend
npm install
npm start
```

3. Test flows:
   - Sign up with email/password
   - Sign in with Google
   - Sign in with email/password
   - Test Google Sheets integration
   - Test Plaid integration (requires auth)

### 6.2 Vercel Preview

1. Push changes to trigger preview deployment
2. Test with preview URL
3. Verify redirect URLs work correctly

### 6.3 Production

1. Deploy to production
2. Test all auth flows
3. Monitor error logs in Vercel dashboard

## Troubleshooting

### Auth callback not working

- Check redirect URLs in Supabase Dashboard match exactly
- Verify your redirect URLs include your frontend origin (e.g. `http://localhost:5173`)
- Check browser console for errors

### Environment variables not available

- Verify variables are set in Vercel dashboard
- Verify `frontend/.env` is present for local dev

### Google OAuth errors

- Verify Client IDs are correct
- Check authorized origins and redirect URIs
- Ensure OAuth consent screen is configured

### Database errors

- Verify migration was run
- Check RLS policies are enabled
- Verify user has proper permissions

## Next Steps

After setup is complete:
1. Test all auth flows
2. Verify user data is properly scoped
3. Test Google Sheets integration with authenticated users
4. Test Plaid integration (requires authentication)
5. Monitor error logs

## Support

For issues:
1. Check Supabase Dashboard → Logs
2. Check Vercel Dashboard → Functions → Logs
3. Check browser console for frontend errors
4. Review this guide for common issues
