export function addMonths(start: Date, months: number): Date {
  const date = new Date(start);
  date.setMonth(date.getMonth() + months);
  return date;
}

export function addDays(start: Date, days: number): Date {
  const date = new Date(start);
  date.setDate(date.getDate() + days);
  return date;
}

