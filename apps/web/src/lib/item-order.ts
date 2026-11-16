import type { WorkItem } from '@workbench/contracts';

export function newestFirst(a: WorkItem, b: WorkItem): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}
