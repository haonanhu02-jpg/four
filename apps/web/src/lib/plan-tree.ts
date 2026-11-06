import { activeItem, effectiveProgress, itemComplete, type WorkItem } from '@workbench/contracts';
export interface PlanNode {
  item: WorkItem;
  progress: number;
  completed: boolean;
  children: PlanNode[];
}
export function planTree(records: WorkItem[], year: number, completion = 'all', search = '') {
  const all = records.filter(activeItem);
  const children = new Map<string, WorkItem[]>();
  for (const row of all)
    if (row.parentId) {
      const list = children.get(row.parentId) ?? [];
      list.push(row);
      children.set(row.parentId, list);
    }
  const visited = new Set<string>();
  const text = search.trim().toLowerCase();
  const build = (item: WorkItem, depth = 0): PlanNode | null => {
    if (visited.has(item.id) || depth > 3) return null;
    visited.add(item.id);
    const nested = (children.get(item.id) ?? [])
      .map((v) => build(v, depth + 1))
      .filter((v): v is PlanNode => Boolean(v));
    const done = itemComplete(item, all);
    const match =
      (!text || `${item.title} ${item.note} ${item.time ?? ''}`.toLowerCase().includes(text)) &&
      (completion === 'all' || done === (completion === 'complete'));
    if (!match && !nested.length) return null;
    return { item, progress: effectiveProgress(item, all), completed: done, children: nested };
  };
  const roots = all
    .filter((v) => v.type === 'annual' && v.year === year)
    .map((v) => build(v))
    .filter((v): v is PlanNode => Boolean(v));
  // Preserve unlinked and other-year-source work; a missing association must
  // never make a current-year task disappear from the full list.
  const extra: PlanNode[] = [];
  for (const type of ['monthly', 'weekly', 'daily'] as const)
    for (const item of all.filter((v) => v.type === type && !visited.has(v.id))) {
      const inYear =
        type === 'monthly'
          ? item.month?.startsWith(`${year}-`)
          : type === 'daily'
            ? item.date?.startsWith(`${year}-`)
            : item.startDate! <= `${year}-12-31` && item.endDate! >= `${year}-01-01`;
      if (inYear) {
        const node = build(item);
        if (node) extra.push(node);
      }
    }
  return { roots, extra };
}
