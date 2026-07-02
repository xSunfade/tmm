export type DashboardSummary = {
  netWorth: number;
  cashFlow: number;
  runYears: number;
  granularity: 'monthly' | 'daily';
};

const DEFAULT_SUMMARY: DashboardSummary = {
  netWorth: 0,
  cashFlow: 0,
  runYears: 10,
  granularity: 'monthly'
};

export function loadDashboardSummary(): DashboardSummary {
  return DEFAULT_SUMMARY;
}
