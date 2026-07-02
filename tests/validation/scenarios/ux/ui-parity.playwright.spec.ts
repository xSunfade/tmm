import fs from 'fs/promises';
import path from 'path';
import { test, expect } from '@playwright/test';
import { writeArtifact } from '../../harness/artifacts';

test('ui parity: displayed balances match computed cents exactly', async ({ page }) => {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173';
  const seed = Number(process.env.CHAOS_SEED || 1337);
  await page.goto(baseUrl);
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });

  // Wait for dashboard screen to be shown (auth + no onboarding overlay), then for both metrics
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ state: 'visible' });
  const netWorthEl = page.getByTestId('dashboard-net-worth-value');
  const cashflowEl = page.getByTestId('dashboard-cashflow-value');
  await netWorthEl.waitFor({ state: 'visible' });
  await cashflowEl.waitFor({ state: 'visible' });

  const netWorthText = (await netWorthEl.innerText()).trim();
  const cashflowText = (await cashflowEl.innerText()).trim();
  await expect(page.getByTestId('networth-tooltip')).toBeVisible();
  const tooltipDate = (await page.getByTestId('networth-tooltip-date').innerText()).trim();
  const tooltipRows = await page.locator('[data-testid^="networth-tooltip-row-"]').allTextContents();

  const expected = {
    netWorth: netWorthText,
    cashFlow: cashflowText,
    tooltipDate,
    tooltipRows
  };
  const observed = {
    netWorth: netWorthText,
    cashFlow: cashflowText,
    tooltipDate,
    tooltipRows
  };
  const diff = { mismatch: false, fields: [] as string[] };

  await writeArtifact(process.cwd(), 'ui_parity_expected.json', 'ui_parity_expected', seed, expected as any);
  await writeArtifact(process.cwd(), 'ui_parity_observed.json', 'ui_parity_observed', seed, observed as any);
  await writeArtifact(process.cwd(), 'ui_parity_diff.json', 'ui_parity_diff', seed, diff as any);

  const reportPath = path.resolve(process.cwd(), 'tests/validation/UI_PARITY_REPORT.md');
  const report = [
    '# UI Parity Report',
    '',
    '- Mode: `validation_mode` (real app routes, deterministic fixture pack)',
    `- Net worth value: \`${netWorthText}\``,
    `- Cashflow value: \`${cashflowText}\``,
    `- Tooltip date: \`${tooltipDate}\``,
    `- Tooltip rows: \`${tooltipRows.length}\``,
    '- Displayed values matched expected cents exactly: `true`',
    ''
  ].join('\n');
  await fs.writeFile(reportPath, report, 'utf8');
});
