// Plaid Client Configuration
// Lazily initializes the Plaid client so the backend can boot without Plaid
// credentials (FRAGILE-5); Plaid routes return 503 when unconfigured.

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import dotenv from 'dotenv';

dotenv.config();

let cachedClient = null;

export function isPlaidConfigured() {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

const getPlaidEnvironment = (env) => {
  switch ((env || 'sandbox').toLowerCase()) {
    case 'production':
      return PlaidEnvironments.production;
    case 'development':
      return PlaidEnvironments.development;
    case 'sandbox':
    default:
      return PlaidEnvironments.sandbox;
  }
};

export function getPlaidClient() {
  if (!isPlaidConfigured()) {
    throw new Error(
      'Plaid is not configured: set PLAID_CLIENT_ID and PLAID_SECRET environment variables'
    );
  }
  if (!cachedClient) {
    const configuration = new Configuration({
      basePath: getPlaidEnvironment(process.env.PLAID_ENVIRONMENT),
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET,
        },
      },
    });
    cachedClient = new PlaidApi(configuration);
  }
  return cachedClient;
}

// Lazy proxy so existing `plaidClient.method()` call sites keep working;
// the real client is only constructed (and credentials only required) on
// first use, not at import time.
export const plaidClient = new Proxy({}, {
  get(_target, prop) {
    if (typeof prop === 'symbol') return undefined;
    const client = getPlaidClient();
    const value = client[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  }
});

// Export environment info for reference
export const plaidEnvironment = process.env.PLAID_ENVIRONMENT || 'sandbox';
