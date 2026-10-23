import type { WorkItem, WorkItemType } from '@workbench/contracts';
export const DEFINITIONS = {
  annual: { table: 'annual_goals', parent: null, parentColumn: null, child: 'monthly' },
  monthly: {
    table: 'monthly_goals',
    parent: 'annual',
    parentColumn: 'annual_goal_id',
    child: 'weekly',
  },
  weekly: {
    table: 'weekly_tasks',
    parent: 'monthly',
    parentColumn: 'monthly_goal_id',
    child: 'daily',
  },
  daily: { table: 'daily_tasks', parent: 'weekly', parentColumn: 'weekly_task_id', child: null },
} as const;
type Row = Record<string, unknown>;
const date = (v: unknown): string =>
  typeof v === 'string' ? v.slice(0, 10) : (v as Date).toISOString().slice(0, 10);
const stamp = (v: unknown): string => new Date(v as string | Date).toISOString();
export function item(type: WorkItemType, row: Row): WorkItem {
  const definition = DEFINITIONS[type];
  const result: WorkItem = {
    id: String(row.id),
    type,
    title: String(row.title),
    note: String(row.note ?? ''),
    parentId: definition.parentColumn ? (row[definition.parentColumn] as string | null) : null,
    version: Number(row.version),
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at),
    deletedAt: row.deleted_at ? stamp(row.deleted_at) : null,
    archivedAt: row.archived_at ? stamp(row.archived_at) : null,
    rolloverCount: Number(row.rollover_count ?? 0),
  };
  if (type === 'annual') result.year = Number(row.year);
  if (type === 'annual' || type === 'monthly') {
    result.progress = Number(row.progress);
    result.weight = Number(row.weight);
  }
  if (type === 'monthly') {
    result.month = date(row.current_month).slice(0, 7);
    result.originalMonth = date(row.original_month).slice(0, 7);
    result.dueDate = row.due_date ? date(row.due_date) : null;
  }
  if (type === 'weekly') {
    result.startDate = date(row.current_start);
    result.endDate = date(row.current_end);
    result.originalStartDate = date(row.original_start);
    result.originalEndDate = date(row.original_end);
    result.priority = row.priority as WorkItem['priority'];
    result.status = row.status as WorkItem['status'];
  }
  if (type === 'daily') {
    result.date = date(row.scheduled_date);
    result.originalDate = date(row.original_date);
    result.minutes = Number(row.minutes);
    result.done = Boolean(row.done);
    result.completedAt = row.completed_at ? stamp(row.completed_at) : null;
  }
  return result;
}
