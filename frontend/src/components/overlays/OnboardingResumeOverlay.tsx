import { useEffect } from 'react';
import { OverlayShell } from './OverlayShell';
import { markAbandonmentPromptShown } from '../../features/onboarding/onboardingAbandonment';

type OnboardingResumeOverlayProps = {
  daysSinceAbandonment?: number | null;
  onResume: () => void;
  onRestart: () => void;
  onSkip: () => void;
};

export function OnboardingResumeOverlay({
  daysSinceAbandonment,
  onResume,
  onRestart,
  onSkip
}: OnboardingResumeOverlayProps) {
  useEffect(() => {
    markAbandonmentPromptShown();
  }, []);

  const subtitle = daysSinceAbandonment !== null && daysSinceAbandonment !== undefined
    ? `You paused the tour ${daysSinceAbandonment} day${daysSinceAbandonment === 1 ? '' : 's'} ago.`
    : 'Continue where you left off or restart the tour.';

  return (
    <OverlayShell
      title="Resume your tour?"
      subtitle={subtitle}
      actions={
        <>
          <button
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white"
            type="button"
            onClick={onResume}
          >
            Resume tour
          </button>
          <button
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200"
            type="button"
            onClick={onRestart}
          >
            Start over
          </button>
          <button
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-400"
            type="button"
            onClick={onSkip}
          >
            Skip for now
          </button>
        </>
      }
    >
      <div className="text-sm text-slate-200">
        The guided tour will highlight each major section and help you connect the pieces quickly.
      </div>
    </OverlayShell>
  );
}
