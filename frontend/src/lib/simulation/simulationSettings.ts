import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../storage/userScopedStorage';

const SETTINGS_KEY = 'tmm_simulation_settings';

export type SimulationSettings = {
  runYears: number;
  granularity: 'monthly' | 'daily';
  forecastView?: 'likely' | 'range';
};

export function loadSimulationSettings(): SimulationSettings {
  try {
    const raw = getScopedLocalStorageItem(SETTINGS_KEY);
    if (!raw) return { runYears: 30, granularity: 'monthly', forecastView: 'likely' };
    return { runYears: 30, granularity: 'monthly', forecastView: 'likely', ...JSON.parse(raw) };
  } catch {
    return { runYears: 30, granularity: 'monthly', forecastView: 'likely' };
  }
}

export function saveSimulationSettings(settings: SimulationSettings) {
  setScopedLocalStorageItem(SETTINGS_KEY, JSON.stringify(settings));
}
