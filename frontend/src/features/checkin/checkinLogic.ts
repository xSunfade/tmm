import {
  getScopedLocalStorageItem,
  setScopedLocalStorageItem
} from '../../lib/storage/userScopedStorage';

const CHECKIN_KEY = 'lastCheckInDate';

export function shouldShowCheckIn(): boolean {
  const last = getScopedLocalStorageItem(CHECKIN_KEY);
  if (!last) return true;
  const lastDate = new Date(last);
  const today = new Date();
  const daysSince = Math.floor((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
  return daysSince >= 7;
}

export function setLastCheckInDate(date = new Date()) {
  setScopedLocalStorageItem(CHECKIN_KEY, date.toISOString());
}
