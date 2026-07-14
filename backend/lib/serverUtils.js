// Small date/parse utilities shared across route modules and services.
// Moved verbatim from server.js (Phase 2.9 router split).

export function dateToIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

export function shiftIsoDateByDays(days, fromDate = new Date()) {
  const d = new Date(fromDate);
  d.setUTCDate(d.getUTCDate() - days);
  return dateToIsoDate(d);
}

export function parseIsoTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function getLocalDateString(value, timezone = 'UTC') {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const safeTimezone = timezone || 'UTC';
  const toLocalDate = (timeZone) => {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  };
  try {
    return toLocalDate(safeTimezone) || toLocalDate('UTC');
  } catch {
    return toLocalDate('UTC');
  }
}

export function parseBooleanFlag(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function parseAltNamesFromValue(value) {
  if (!value) return [];
  const csv = String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set(csv));
}

export function isFutureIso(value, now = new Date()) {
  const d = parseIsoTimestamp(value);
  return !!d && d.getTime() > now.getTime();
}
