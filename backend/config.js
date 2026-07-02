// Environment Configuration
// Handles multi-environment setup (development vs production)

import dotenv from 'dotenv';

// Detect environment
const NODE_ENV = process.env.NODE_ENV || 'development';
const isDevelopment = NODE_ENV === 'development';
const isProduction = NODE_ENV === 'production';

// Load .env file only in development
if (isDevelopment) {
  dotenv.config();
}


/**
 * Get CORS origins based on environment
 */
function getCorsOrigins() {
  const origins = [];

  // Add production origin if set
  if (process.env.CORS_ORIGIN) {
    origins.push(process.env.CORS_ORIGIN);
  }

  // In development, add local dev origins
  if (isDevelopment) {
    origins.push('http://localhost:5173');
    origins.push('http://127.0.0.1:5173');
    origins.push('http://localhost:5500');
    origins.push('http://127.0.0.1:5500');
    origins.push('http://localhost:8080');
  }

  // Filter out empty values and return
  return origins.filter(Boolean);
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Get logging configuration
 */
function getLoggingConfig() {
  return {
    level: isProduction ? 'error' : 'debug',
    verbose: !isProduction
  };
}

// Export configuration object
export const config = {
  // Environment
  env: NODE_ENV,
  isDevelopment,
  isProduction,

  // Server
  port: process.env.PORT || 3000,
  corsOrigins: getCorsOrigins(),
  allowDevUnlistedCors: isDevelopment && process.env.ALLOW_DEV_UNLISTED_CORS === 'true',
  requestTimeoutMs: toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 30000),
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || '256kb',
  enableHsts: isProduction && process.env.ENABLE_HSTS === 'true',

  // Plaid
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
    environment: process.env.PLAID_ENVIRONMENT || 'sandbox'
  },

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
    secretKey: process.env.SUPABASE_SECRET_KEY
  },

  // Google OAuth (for Google Sheets integration)
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || null,
    frontendRedirect: process.env.GOOGLE_OAUTH_FRONTEND_REDIRECT || null,
    scopes:
      process.env.GOOGLE_OAUTH_SCOPES ||
      'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file'
  },

  // Stripe
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    tmmPlusPriceId: process.env.STRIPE_PRICE_ID_TMM_PLUS || null
  },

  // Encryption
  encryption: {
    key: process.env.TOKEN_ENCRYPTION_KEY || null // Will generate if not set
  },

  // Logging
  logging: getLoggingConfig(),

  // TLS — dev workaround when antivirus/proxy breaks Google/Plaid cert chains
  tls: {
    insecureSkipVerify:
      isDevelopment && process.env.TLS_INSECURE_SKIP_VERIFY === 'true'
  }
};

if (config.tls.insecureSkipVerify) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn(
    '⚠️  TLS certificate verification disabled (TLS_INSECURE_SKIP_VERIFY=true). Development only — do not use in production.'
  );
}

// Validate required configuration
if (!config.plaid.clientId || !config.plaid.secret) {
  if (isProduction) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set in production');
  } else {
    console.warn('⚠️  PLAID_CLIENT_ID and PLAID_SECRET not set. Plaid features will not work.');
  }
}

if (!config.supabase.url || !config.supabase.publishableKey) {
  if (isProduction) {
    throw new Error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be set in production');
  } else {
    console.warn('⚠️  SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY not set. Database features will not work.');
  }
}

if (isProduction && config.corsOrigins.length === 0) {
  throw new Error('CORS_ORIGIN must be set in production');
}

// Log configuration (non-sensitive)
if (config.logging.verbose) {
  console.log('Configuration loaded:');
  console.log(`  Environment: ${config.env}`);
  console.log(`  Port: ${config.port}`);
  console.log(`  CORS Origins: ${config.corsOrigins.join(', ')}`);
  console.log(`  Supabase URL: ${config.supabase.url ? '✓ Set' : '✗ Missing'}`);
  console.log(`  Plaid Environment: ${config.plaid.environment}`);
}

export default config;

