import type { WorkItem, WorkItemType } from '@workbench/contracts';

/** Only follow the selected annual goal's current associations, across all dates. */
export function annualDeletionPlan(root: WorkItem, records: WorkItem[]) {
  const levels: WorkItem[][] = [];
  let parents = new Set([root.id]);
  if (root.type === 'annual') {
    for (const type of ['monthly', 'weekly', 'daily'] as const) {
      const rows = records.filter(
        (v) => v.type === type && !v.deletedAt && v.parentId && parents.has(v.parentId),
      );
      levels.push(rows);
      parents = new Set(rows.map((v) => v.id));
    }
  }
  const counts: Partial<Record<WorkItemType, number>> = {};
  for (const [index, type] of (['monthly', 'weekly', 'daily'] as const).entries())
    counts[type] = levels[index]?.length ?? 0;
  // Delete leaves first so normal parent deletion never detaches a queued child.
  const descendants = [...levels].reverse().flat();
  return { descendants, counts, total: descendants.length };
}
