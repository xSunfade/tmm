import type { TourState, TourStep } from './tourTypes';
import { setTourCompleted, setTourProgress, setTourDeclined } from './tourStorage';
import { setOnboardingCompleted, setOnboardingCurrentModule, setOnboardingCurrentStep } from '../onboarding/onboardingStorage';
import { clearAbandonmentRecord, markOnboardingAbandoned } from '../onboarding/onboardingAbandonment';

type Listener = (state: TourState) => void;

const listeners = new Set<Listener>();

let state: TourState = {
  status: 'idle',
  steps: [],
  currentIndex: 0
};

function emit() {
  listeners.forEach((listener) => listener(state));
}

function clampIndex(index: number, steps: TourStep[]) {
  if (index < 0) return 0;
  if (index >= steps.length) return Math.max(steps.length - 1, 0);
  return index;
}

function updateProgress(step: TourStep | undefined) {
  if (!step) return;
  setTourProgress(step.id);
  setOnboardingCurrentStep(step.id);
  if (step.moduleId) {
    setOnboardingCurrentModule(step.moduleId);
  }
}

export function getTourState() {
  return state;
}

export function subscribeTour(listener: Listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function startTour(steps: TourStep[], startAtId?: string) {
  if (!steps.length) return;
  const startIndex = startAtId ? steps.findIndex((step) => step.id === startAtId) : 0;
  const nextIndex = clampIndex(startIndex >= 0 ? startIndex : 0, steps);
  state = {
    status: 'active',
    steps,
    currentIndex: nextIndex
  };
  updateProgress(steps[nextIndex]);
  emit();
}

export function resumeTour(steps: TourStep[], startAtId?: string) {
  startTour(steps, startAtId);
}

export function nextStep() {
  if (state.status !== 'active') return;
  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.steps.length) {
    completeTour();
    return;
  }
  state = { ...state, currentIndex: nextIndex };
  updateProgress(state.steps[nextIndex]);
  emit();
}

export function prevStep() {
  if (state.status !== 'active') return;
  const nextIndex = clampIndex(state.currentIndex - 1, state.steps);
  state = { ...state, currentIndex: nextIndex };
  updateProgress(state.steps[nextIndex]);
  emit();
}

export function skipTour() {
  if (state.status !== 'active') return;
  updateProgress(state.steps[state.currentIndex]);
  setTourDeclined();
  markOnboardingAbandoned();
  state = { ...state, status: 'idle' };
  emit();
}

export function completeTour() {
  setTourCompleted();
  setOnboardingCompleted(true);
  clearAbandonmentRecord();
  state = { ...state, status: 'completed' };
  emit();
}
