import { useState } from 'react';
import { OverlayShell } from './OverlayShell';
import { setOnboardingSurvey, type OnboardingSurvey } from '../../features/onboarding/onboardingStorage';
import { clearTourCompleted, clearTourDeclined, setTourProgress } from '../../features/tour/tourStorage';

type OnboardingOverlayProps = {
  onComplete?: () => void;
  onSkip?: () => void;
};

export function OnboardingOverlay({ onComplete, onSkip }: OnboardingOverlayProps) {
  const [survey, setSurvey] = useState<OnboardingSurvey>({
    primary_goal: '',
    experience_level: '',
    data_preference: '',
    time_horizon: ''
  });

  const buildPath = (responses: OnboardingSurvey) => {
    const base = ['dashboard', 'accounts', 'pipeline', 'simulation', 'goals', 'settings'];
    if (responses.experience_level === 'beginner') {
      return ['accounts', 'dashboard', 'simulation', 'pipeline', 'goals', 'settings'];
    }
    if (responses.primary_goal === 'retirement') {
      return ['dashboard', 'simulation', 'goals', 'accounts', 'pipeline', 'settings'];
    }
    return base;
  };

  return (
    <OverlayShell
      title="Welcome to TMM"
      subtitle="Answer a few quick questions to personalize your path."
      actions={
        <>
          <button
            className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white"
            type="button"
            onClick={() => {
              const path = buildPath(survey);
              setOnboardingSurvey(survey, path);
              clearTourCompleted();
              clearTourDeclined();
              setTourProgress('load-sample-data');
              onComplete?.();
            }}
          >
            Start tour
          </button>
          <button
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200"
            type="button"
            onClick={onSkip}
          >
            Skip for now
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-200">
        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-slate-400">Primary goal</span>
          <select
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            value={survey.primary_goal}
            onChange={(event) => setSurvey((prev) => ({ ...prev, primary_goal: event.target.value }))}
          >
            <option value="">Select…</option>
            <option value="retirement">Retirement planning</option>
            <option value="debt">Debt payoff</option>
            <option value="growth">Net worth growth</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-slate-400">Experience level</span>
          <select
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            value={survey.experience_level}
            onChange={(event) => setSurvey((prev) => ({ ...prev, experience_level: event.target.value }))}
          >
            <option value="">Select…</option>
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-slate-400">Data preference</span>
          <select
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            value={survey.data_preference}
            onChange={(event) => setSurvey((prev) => ({ ...prev, data_preference: event.target.value }))}
          >
            <option value="">Select…</option>
            <option value="manual">Manual entry</option>
            <option value="connected">Connected accounts</option>
            <option value="mixed">Mixed</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-slate-400">Time horizon</span>
          <select
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            value={survey.time_horizon}
            onChange={(event) => setSurvey((prev) => ({ ...prev, time_horizon: event.target.value }))}
          >
            <option value="">Select…</option>
            <option value="short">0-2 years</option>
            <option value="mid">3-10 years</option>
            <option value="long">10+ years</option>
          </select>
        </label>
      </div>
    </OverlayShell>
  );
}
