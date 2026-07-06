export function addMonths(start: Date, months: number): Date {
  const date = new Date(start);
  date.setMonth(date.getMonth() + months);
  return date;
}

