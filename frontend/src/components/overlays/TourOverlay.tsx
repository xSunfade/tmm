import { useMemo, useState } from 'react';
import { OverlayShell } from './OverlayShell';
import { setTourCompleted, setTourProgress } from '../../features/tour/tourStorage';
import { getOnboardingPath, markModuleCompleted } from '../../features/onboarding/onboardingStorage';

type TourOverlayProps = {
  onFinish?: () => void;
};

export function TourOverlay({ onFinish }: TourOverlayProps) {
  const steps = useMemo(() => {
    const path = getOnboardingPath();
    const map: Record<string, { title: string; body: string }> = {
      dashboard: { title: 'Dashboard', body: 'Review your net worth and cash flow trends.' },
      accounts: { title: 'Accounts', body: 'Add income, expenses, assets, and debts.' },
      pipeline: { title: 'Pipeline Builder', body: 'Connect cash flows between accounts.' },
      simulation: { title: 'Simulation', body: 'Run scenarios and compare outcomes.' },
      goals: { title: 'Goals', body: 'Track milestones against targets.' },
      settings: { title: 'Settings', body: 'Update assumptions and sync preferences.' }
    };
    const fallback = ['dashboard', 'accounts', 'pipeline', 'simulation', 'goals', 'settings'];
    const sequence = path.length ? path : fallback;
    return sequence.map((id, index) => ({
      id,
      title: map[id]?.title || `Step ${index + 1}`,
      body: map[id]?.body || 'Continue to the next section.'
    }));
  }, []);
  const [stepIndex, setStepIndex] = useState(0);
  const isLastStep = stepIndex >= steps.length - 1;
  const step = steps[stepIndex];

  return (
    <OverlayShell
      title={step.title}
      subtitle="Tour prompts will be consolidated here during the migration."
      actions={
        isLastStep ? (
          <button
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white"
            type="button"
            onClick={() => {
              setTourCompleted();
              onFinish?.();
            }}
          >
            Finish tour
          </button>
        ) : (
          <button
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white"
            type="button"
            onClick={() => {
              const nextIndex = Math.min(stepIndex + 1, steps.length - 1);
              const nextStep = steps[nextIndex];
              setTourProgress(nextStep.id);
              markModuleCompleted(step.id);
              setStepIndex(nextIndex);
            }}
          >
            Next step
          </button>
        )
      }
    >
      <div className="space-y-2">
        <div>{step.body}</div>
        <div className="text-xs text-slate-400">
          Step {stepIndex + 1} of {steps.length}
        </div>
      </div>
    </OverlayShell>
  );
}
