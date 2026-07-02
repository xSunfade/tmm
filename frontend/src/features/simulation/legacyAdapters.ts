import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

export type SimulationSettings = {
  runYears: number;
  granularity: 'monthly' | 'daily';
};

export type SimulationAugment = {
  id: string;
  name: string;
  enabled: boolean;
};

const SETTINGS_KEY = 'tmm_simulation_settings';
const AUGMENTS_KEY = 'tmm_simulation_augments';

export function loadSimulationSettings(): SimulationSettings {
  if (typeof window === 'undefined') {
    return { runYears: 10, granularity: 'monthly' };
  }
  const raw = getScopedLocalStorageItem(SETTINGS_KEY);
  if (!raw) return { runYears: 10, granularity: 'monthly' };
  try {
    return JSON.parse(raw) as SimulationSettings;
  } catch (error) {
    console.warn('[simulation] Failed to parse settings', error);
    return { runYears: 10, granularity: 'monthly' };
  }
}

export function saveSimulationSettings(settings: SimulationSettings) {
  if (typeof window === 'undefined') return;
  setScopedLocalStorageItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadAugments(): SimulationAugment[] {
  if (typeof window === 'undefined') return [];
  const raw = getScopedLocalStorageItem(AUGMENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SimulationAugment[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[simulation] Failed to parse augments', error);
    return [];
  }
}

export function saveAugments(augments: SimulationAugment[]) {
  if (typeof window === 'undefined') return;
  setScopedLocalStorageItem(AUGMENTS_KEY, JSON.stringify(augments));
}
