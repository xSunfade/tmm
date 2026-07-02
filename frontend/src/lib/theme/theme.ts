import { getScopedLocalStorageItem, setScopedLocalStorageItem } from '../storage/userScopedStorage';
export type ThemeId = 'dark-green' | 'dark-blue' | 'light-green';

const THEME_KEY = 'tmm_theme';

function isThemeId(value: unknown): value is ThemeId {
  return value === 'dark-green' || value === 'dark-blue' || value === 'light-green';
}

export function getStoredTheme(): ThemeId | null {
  try {
    const raw = getScopedLocalStorageItem(THEME_KEY);
    if (!raw) return null;
    return isThemeId(raw) ? raw : null;
  } catch (error) {
    console.warn('[theme] Failed to read localStorage', error);
    return null;
  }
}

export function setStoredTheme(theme: ThemeId) {
  try {
    setScopedLocalStorageItem(THEME_KEY, theme);
  } catch (error) {
    console.warn('[theme] Failed to persist theme', error);
  }
}

export function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function initTheme(defaultTheme: ThemeId = 'dark-green'): ThemeId {
  const stored = getStoredTheme();
  const resolved = stored ?? defaultTheme;
  applyTheme(resolved);
  return resolved;
}
