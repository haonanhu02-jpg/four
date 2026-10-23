import type { AlignmentCode, WorkItem, WorkItemType } from '@workbench/contracts';
export const itemNames: Record<WorkItemType, string> = {
  annual: '年度目标',
  monthly: '月度目标',
  weekly: '周任务',
  daily: '日待办',
};
export const issueNames: Record<AlignmentCode, string> = {
  annual_without_monthly: '年度目标还没有拆出月度目标',
  monthly_without_annual: '月度目标未关联年度目标',
  monthly_without_weekly: '月目标在当前区间还没有拆周任务',
  weekly_without_monthly: '周任务未关联月度目标',
  weekly_without_daily: '未完成周任务在当前区间还没有安排动作',
  daily_without_weekly: '当日待办未关联周任务',
  parent_complete: '直接上级已完成，这条事项仍未完成',
  overdue: '已超过截止或执行日期，仍未完成',
};
export const periodOf = (item: WorkItem) =>
  item.year ? `${item.year}年` : item.month || item.date || `${item.startDate} — ${item.endDate}`;
export const progressOf = (item: WorkItem) =>
  item.type === 'daily'
    ? item.done
      ? '已完成'
      : '未完成'
    : item.type === 'weekly'
      ? ({ todo: '未开始', doing: '进行中', block: '受阻', done: '已完成' }[item.status!] ?? '')
      : `手动进度 ${item.progress}%`;
export function sourceOf(value: WorkItem, ancestors: WorkItem[]): WorkItem[] {
  const records = new Map(ancestors.map((v) => [v.id, v]));
  const result: WorkItem[] = [];
  let current = value;
  for (let i = 0; i < 3 && current.parentId; i++) {
    const parent = records.get(current.parentId);
    if (!parent) break;
    result.push(parent);
    current = parent;
  }
  return result;
}
