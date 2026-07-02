import React, { createContext, useContext, useMemo, useReducer } from 'react';
import type { PlanState, Alternative, PipelineState, Goal, Augment, Checkpoint } from './types';

export type PlanAction =
  | { type: 'hydrate'; plan: PlanState }
  | { type: 'setActiveAlt'; altName: string }
  | { type: 'setAssumptions'; assumptions: PlanState['assumptions'] }
  | { type: 'setAlternative'; altName: string; alt: Alternative }
  | { type: 'setAltChartEnabled'; altName: string; enabled: boolean }
  | { type: 'setAltColor'; altName: string; color: string | null }
  | { type: 'setPipeline'; pipeline: PipelineState }
  | { type: 'setGoals'; altName: string; goals: Goal[] }
  | { type: 'setAugments'; augments: Augment[] }
  | { type: 'setCheckpoints'; altName: string; checkpoints: Checkpoint[] };

type PlanStoreContextValue = {
  state: PlanState;
  dispatch: React.Dispatch<PlanAction>;
};

const PlanStoreContext = createContext<PlanStoreContextValue | null>(null);

function planReducer(state: PlanState, action: PlanAction): PlanState {
  switch (action.type) {
    case 'hydrate':
      return action.plan;
    case 'setActiveAlt':
      return { ...state, activeAlt: action.altName };
    case 'setAssumptions':
      return { ...state, assumptions: action.assumptions };
    case 'setAlternative':
      return {
        ...state,
        alternatives: { ...state.alternatives, [action.altName]: action.alt },
        activeAlt: state.activeAlt || action.altName
      };
    case 'setAltChartEnabled':
      return {
        ...state,
        altChartEnabled: { ...state.altChartEnabled, [action.altName]: action.enabled }
      };
    case 'setAltColor': {
      const next = { ...state.altColors };
      if (action.color) {
        next[action.altName] = action.color;
      } else {
        delete next[action.altName];
      }
      return { ...state, altColors: next };
    }
    case 'setPipeline':
      return { ...state, pipeline: action.pipeline };
    case 'setGoals':
      return { ...state, goals: { ...state.goals, [action.altName]: action.goals } };
    case 'setAugments':
      return { ...state, augments: action.augments };
    case 'setCheckpoints':
      return {
        ...state,
        checkpoints: { ...state.checkpoints, [action.altName]: action.checkpoints }
      };
    default:
      return state;
  }
}

export function PlanStoreProvider({
  initialState,
  children
}: {
  initialState: PlanState;
  children: React.ReactNode;
}) {
  const [state, dispatch] = useReducer(planReducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <PlanStoreContext.Provider value={value}>{children}</PlanStoreContext.Provider>;
}

export function usePlanStore() {
  const value = useContext(PlanStoreContext);
  if (!value) {
    throw new Error('usePlanStore must be used inside PlanStoreProvider');
  }
  return value;
}
