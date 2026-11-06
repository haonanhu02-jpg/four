import type { WorkItem } from './work-items';

export const activeItem = (item: WorkItem) => !item.deletedAt && !item.archivedAt;
export function weightedProgress(
  items: WorkItem[],
  value = (item: WorkItem) => item.progress ?? 0,
): number | null {
  const weight = items.reduce((sum, item) => sum + (item.weight ?? 0), 0);
  return weight > 0
    ? Math.round(items.reduce((sum, item) => sum + value(item) * (item.weight ?? 0), 0) / weight)
    : null;
}
export function effectiveProgress(item: WorkItem, records: WorkItem[]): number {
  if (
    item.type === 'annual' &&
    item.progressMode === 'auto' &&
    item.calculatedProgress !== undefined
  )
    return item.calculatedProgress;
  if (item.type === 'annual' && item.progressMode === 'auto')
    return (
      weightedProgress(
        records.filter(
          (child) => child.type === 'monthly' && child.parentId === item.id && activeItem(child),
        ),
      ) ?? 0
    );
  if (item.type === 'weekly')
    return { todo: 0, doing: 50, block: 15, done: 100 }[item.status ?? 'todo'];
  if (item.type === 'daily') return item.done ? 100 : 0;
  return item.progress ?? 0;
}
export function itemComplete(item: WorkItem, records: WorkItem[] = []): boolean {
  return effectiveProgress(item, records) === 100;
}
// Free text is retained verbatim. Parsed durations are supplementary and never
// overwrite a user's separately entered estimated minutes.
export function parseWorkMinutes(source: string): number | null {
  const text = source.trim();
  let match = text.match(/^(\d{1,2})[:：](\d{2})\s*[-–—~至到]\s*(\d{1,2})[:：](\d{2})$/);
  if (match) {
    const [h1, m1, h2, m2] = match.slice(1).map(Number) as [number, number, number, number];
    if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
    const minutes = h2 * 60 + m2 - h1 * 60 - m1;
    return minutes > 0 ? minutes : null;
  }
  match = text.match(/^(\d+(?:\.\d+)?)\s*(h|小时|时|m|分钟|分)?$/i);
  if (!match) return null;
  const minutes = Math.round(Number(match[1]) * (/^(h|小时|时)$/i.test(match[2] ?? '') ? 60 : 1));
  return minutes <= 1440 ? minutes : null;
}
