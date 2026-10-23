export function todayIn(timezone = 'Asia/Shanghai'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
export function addDays(value: string, count: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
export function monday(value: string): string {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return addDays(value, day === 0 ? -6 : 1 - day);
}
export const daySpan = (start: string, end: string): number =>
  Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
export const dayLabel = (value: string): string =>
  `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
