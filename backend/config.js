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
  // Route-scoped limit for PUT /api/plan (D14: handler warns at 1 MB, rejects
  // above 5 MB; parser limit sits slightly above the hard cap).
  planJsonBodyLimit: process.env.PLAN_JSON_BODY_LIMIT || '6mb',
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

// ==========================================================
// Startup configuration validator (ENV-1)
// Prints one table of every operational variable and refuses
// to boot in production when a production-required var is missing.
// ==========================================================

// severity: 'required' = must be present in production (hard fail);
//           'recommended' = warned about but never blocks boot.
// secret: mask the value in the printed table.
const CONFIG_CHECKS = [
  { key: 'NODE_ENV', value: NODE_ENV, severity: 'recommended' },
  { key: 'PORT', value: config.port, severity: 'recommended' },
  { key: 'CORS_ORIGIN', value: config.corsOrigins.join(', '), severity: 'required' },
  { key: 'PLAID_CLIENT_ID', value: config.plaid.clientId, severity: 'required' },
  { key: 'PLAID_SECRET', value: config.plaid.secret, severity: 'required', secret: true },
  { key: 'PLAID_ENVIRONMENT', value: config.plaid.environment, severity: 'recommended' },
  { key: 'SUPABASE_URL', value: config.supabase.url, severity: 'required' },
  { key: 'SUPABASE_PUBLISHABLE_KEY', value: config.supabase.publishableKey, severity: 'required' },
  // Required in production (FRAGILE-6 boot guard + fail-closed token encryption).
  { key: 'SUPABASE_SECRET_KEY', value: config.supabase.secretKey, severity: 'required', secret: true },
  { key: 'TOKEN_ENCRYPTION_KEY', value: config.encryption.key, severity: 'required', secret: true },
  { key: 'STRIPE_SECRET_KEY', value: config.stripe.secretKey, severity: 'recommended', secret: true },
  { key: 'STRIPE_WEBHOOK_SECRET', value: config.stripe.webhookSecret, severity: 'recommended', secret: true },
  { key: 'GOOGLE_CLIENT_ID', value: config.google.clientId, severity: 'recommended' },
  { key: 'GOOGLE_CLIENT_SECRET', value: config.google.clientSecret, severity: 'recommended', secret: true }
];

function isSet(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function displayValue(check) {
  if (!isSet(check.value)) return '—';
  return check.secret ? '******** (set)' : String(check.value);
}

const evaluated = CONFIG_CHECKS.map((check) => ({
  ...check,
  present: isSet(check.value)
}));

const missingRequired = evaluated.filter((c) => c.severity === 'required' && !c.present);
const missingRecommended = evaluated.filter((c) => c.severity === 'recommended' && !c.present);

// Print the table (always in dev; compact status line in prod).
if (config.logging.verbose) {
  const width = Math.max(...CONFIG_CHECKS.map((c) => c.key.length));
  console.log(`\nConfiguration (${config.env}):`);
  for (const c of evaluated) {
    const status = c.present ? '✓' : c.severity === 'required' ? '✗ REQUIRED' : '· optional';
    console.log(`  ${c.key.padEnd(width)}  ${status.padEnd(11)}  ${displayValue(c)}`);
  }
  console.log('');
}

if (missingRecommended.length > 0) {
  console.warn(
    `⚠️  Optional config not set (features degraded): ${missingRecommended.map((c) => c.key).join(', ')}`
  );
}

if (isProduction && missingRequired.length > 0) {
  const names = missingRequired.map((c) => c.key).join(', ');
  throw new Error(
    `Refusing to boot in production: missing required configuration → ${names}. ` +
      `Set these in the hosting platform's environment variables (see backend/.env.example).`
  );
}

if (!isProduction && missingRequired.length > 0) {
  console.warn(
    `⚠️  Missing required-in-production config (allowed in ${config.env}): ${missingRequired
      .map((c) => c.key)
      .join(', ')}`
  );
}

export default config;

