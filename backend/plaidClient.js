// Plaid Client Configuration
// Initializes and exports a configured Plaid client instance

import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import dotenv from 'dotenv';

dotenv.config();

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENVIRONMENT = process.env.PLAID_ENVIRONMENT || 'sandbox';

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
  throw new Error('PLAID_CLIENT_ID and PLAID_SECRET must be set in environment variables');
}

// Map environment string to Plaid environment
const getPlaidEnvironment = (env) => {
  switch (env.toLowerCase()) {
    case 'production':
      return PlaidEnvironments.production;
    case 'development':
      return PlaidEnvironments.development;
    case 'sandbox':
    default:
      return PlaidEnvironments.sandbox;
  }
};

// Create Plaid configuration
const configuration = new Configuration({
  basePath: getPlaidEnvironment(PLAID_ENVIRONMENT),
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
      'PLAID-SECRET': PLAID_SECRET,
    },
  },
});

// Create and export Plaid client
export const plaidClient = new PlaidApi(configuration);

// Export environment info for reference
export const plaidEnvironment = PLAID_ENVIRONMENT;

