import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './scenarios/ux',
  timeout: 60_000,
  globalSetup: './auth-setup.ts',
  use: {
    headless: true,
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173',
    storageState: 'tests/validation/.auth/user.json'
  },
  reporter: [['list']]
});
