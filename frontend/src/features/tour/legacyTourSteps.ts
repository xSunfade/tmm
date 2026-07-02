import type { TourStep } from './tourTypes';
import { loadLastRun } from '../../lib/simulation/runHistory';

const moduleSteps: Record<string, TourStep[]> = {
  dashboard: [
    {
      id: 'nav-dashboard',
      title: 'Dashboard',
      description: 'Start on the Dashboard to review your plan at a glance.',
      target: '[data-tour="nav-dashboard"]',
      route: 'dashboard',
      action: 'click',
      position: 'right',
      moduleId: 'dashboard'
    },
    {
      id: 'run-simulation',
      title: 'Run Your First Simulation',
      description: 'Click Run Simulation to generate projections and charts.',
      target: '[data-tour="run-simulation"]',
      route: 'dashboard',
      action: 'click',
      position: 'right',
      required: true,
      moduleId: 'dashboard',
      waitFor: () => Boolean(loadLastRun())
    },
    {
      id: 'net-worth-metric',
      title: 'Current Net Worth',
      description: 'This shows assets minus debts at the latest point in time.',
      target: '[data-tour="net-worth-metric"]',
      route: 'dashboard',
      action: 'observe',
      position: 'bottom-right',
      moduleId: 'dashboard'
    },
    {
      id: 'cash-flow-metric',
      title: 'Monthly Cash Flow',
      description: 'Income minus expenses. Positive means you are saving each month.',
      target: '[data-tour="cash-flow-metric"]',
      route: 'dashboard',
      action: 'observe',
      position: 'bottom-right',
      moduleId: 'dashboard'
    },
    {
      id: 'run-range-controls',
      title: 'Simulation Range',
      description: 'Adjust run years and granularity to control the projection.',
      target: '[data-tour="run-range-controls"]',
      route: 'dashboard',
      action: 'observe',
      position: 'bottom-right',
      moduleId: 'dashboard'
    },
    {
      id: 'net-worth-chart',
      title: 'Net Worth Projection',
      description: 'Hover to read values and compare alternatives over time.',
      target: '[data-tour="net-worth-chart"]',
      route: 'dashboard',
      action: 'observe',
      position: 'top',
      moduleId: 'dashboard'
    },
    {
      id: 'timeline-slider',
      title: 'Timeline Slider',
      description: 'Drag the handles to zoom and pan the chart range.',
      target: '[data-tour="timeline-slider"]',
      route: 'dashboard',
      action: 'observe',
      position: 'top',
      moduleId: 'dashboard'
    },
    {
      id: 'alt-toggles',
      title: 'Alternative Toggles',
      description: 'Enable multiple alternatives to compare scenarios.',
      target: '[data-tour="alt-toggles"]',
      route: 'dashboard',
      action: 'observe',
      position: 'bottom-right',
      moduleId: 'dashboard'
    },
    {
      id: 'cashflow-chart',
      title: 'Cashflow Breakdown',
      description: 'See how income, expenses, assets, and debts stack up.',
      target: '[data-tour="cashflow-chart"]',
      route: 'dashboard',
      action: 'observe',
      position: 'top',
      moduleId: 'dashboard'
    }
  ],
  accounts: [
    {
      id: 'nav-accounts',
      title: 'Accounts',
      description: 'Manage your income, expenses, assets, and debts.',
      target: '[data-tour="nav-accounts"]',
      route: 'accounts',
      action: 'click',
      position: 'right',
      moduleId: 'accounts'
    },
    {
      id: 'account-alternatives',
      title: 'Alternatives',
      description: 'Create and switch between scenarios for comparison.',
      target: '[data-tour="account-alternatives"]',
      route: 'accounts',
      action: 'observe',
      position: 'bottom-right',
      moduleId: 'accounts'
    },
    {
      id: 'accounts-tables',
      title: 'Account Tables',
      description: 'Add and edit your income, expense, asset, and debt rows.',
      target: '[data-tour="accounts-tables"]',
      route: 'accounts',
      action: 'observe',
      position: 'top',
      moduleId: 'accounts'
    }
  ],
  pipeline: [
    {
      id: 'nav-pipeline',
      title: 'Pipeline Builder',
      description: 'Visualize how money flows between accounts.',
      target: '[data-tour="nav-pipeline"]',
      route: 'pipeline',
      action: 'click',
      position: 'right',
      moduleId: 'pipeline'
    },
    {
      id: 'pipeline-canvas',
      title: 'Pipeline Canvas',
      description: 'Drag between ports to connect income, expenses, assets, and debts.',
      target: '[data-tour="pipeline-canvas"]',
      route: 'pipeline',
      action: 'observe',
      position: 'top-right',
      moduleId: 'pipeline'
    }
  ],
  simulation: [
    {
      id: 'nav-simulation',
      title: 'Simulation',
      description: 'Model changes over time and explore scenarios.',
      target: '[data-tour="nav-simulation"]',
      route: 'simulation',
      action: 'click',
      position: 'right',
      moduleId: 'simulation'
    }
  ],
  goals: [
    {
      id: 'nav-goals',
      title: 'Goals',
      description: 'Track milestones and progress toward your targets.',
      target: '[data-tour="nav-goals"]',
      route: 'goals',
      action: 'click',
      position: 'right',
      moduleId: 'goals'
    },
    {
      id: 'goals-header',
      title: 'Goals Overview',
      description: 'Define and monitor your financial goals.',
      target: '[data-tour="goals-header"]',
      route: 'goals',
      action: 'observe',
      position: 'bottom-right',
      moduleId: 'goals'
    }
  ],
  settings: [
    {
      id: 'nav-settings',
      title: 'Settings',
      description: 'Manage global assumptions and sheet connections.',
      target: '[data-tour="nav-settings"]',
      route: 'settings',
      action: 'click',
      position: 'right',
      moduleId: 'settings'
    },
    {
      id: 'settings-header',
      title: 'Plan Settings',
      description: 'Update assumptions, sync settings, and integrations.',
      target: '[data-tour="settings-header"]',
      route: 'settings',
      action: 'observe',
      position: 'bottom-right',
      moduleId: 'settings'
    }
  ]
};

const defaultPath = ['dashboard', 'accounts', 'pipeline', 'simulation', 'goals', 'settings'];

const loadSampleDataStep: TourStep = {
  id: 'load-sample-data',
  title: 'Load Sample Data (Optional)',
  description: 'Load sample data to see a populated plan, or click Next to continue with your own data.',
  target: '[data-tour="load-sample-data"]',
  route: 'simulation',
  action: 'click',
  position: 'bottom-right',
  moduleId: 'simulation'
};

export function buildLegacyTourSteps(path: string[]) {
  const sequence = path.length ? path : defaultPath;
  const rest = sequence.flatMap((moduleId) => moduleSteps[moduleId] || []);
  return [loadSampleDataStep, ...rest];
}
