let activeUserId: string | null = null;

function normalizeUserId(userId?: string | null): string {
  const trimmed = String(userId || '').trim();
  return trimmed || 'anon';
}

function scopedKey(baseKey: string, userId?: string | null): string {
  return `${baseKey}::${normalizeUserId(userId ?? activeUserId)}`;
}

export function setActiveStorageUserId(userId?: string | null): void {
  activeUserId = userId ? String(userId) : null;
}

export function getActiveStorageUserId(): string {
  return normalizeUserId(activeUserId);
}

export function getScopedStorageKey(baseKey: string, ...suffixParts: Array<string | number>): string {
  const suffix = suffixParts
    .map((part) => String(part))
    .filter((part) => part.length > 0)
    .join('::');
  const key = scopedKey(baseKey);
  return suffix ? `${key}::${suffix}` : key;
}

export function getScopedLocalStorageItem(baseKey: string, ...suffixParts: Array<string | number>): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(getScopedStorageKey(baseKey, ...suffixParts));
}

export function setScopedLocalStorageItem(baseKey: string, value: string, ...suffixParts: Array<string | number>): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(getScopedStorageKey(baseKey, ...suffixParts), value);
}

export function removeScopedLocalStorageItem(baseKey: string, ...suffixParts: Array<string | number>): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(getScopedStorageKey(baseKey, ...suffixParts));
}

export function getScopedSessionStorageItem(baseKey: string, ...suffixParts: Array<string | number>): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(getScopedStorageKey(baseKey, ...suffixParts));
}

export function setScopedSessionStorageItem(baseKey: string, value: string, ...suffixParts: Array<string | number>): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(getScopedStorageKey(baseKey, ...suffixParts), value);
}

export function removeScopedSessionStorageItem(baseKey: string, ...suffixParts: Array<string | number>): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(getScopedStorageKey(baseKey, ...suffixParts));
}

export function removeAllScopedLocalStorageItems(baseKey: string): void {
  if (typeof window === 'undefined') return;
  const prefix = `${scopedKey(baseKey)}::`;
  const exact = scopedKey(baseKey);
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key === exact || key.startsWith(prefix)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
}

export function removeAllScopedSessionStorageItems(baseKey: string): void {
  if (typeof window === 'undefined') return;
  const prefix = `${scopedKey(baseKey)}::`;
  const exact = scopedKey(baseKey);
  const keysToRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (!key) continue;
    if (key === exact || key.startsWith(prefix)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => sessionStorage.removeItem(key));
}

