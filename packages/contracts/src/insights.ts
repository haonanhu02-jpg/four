import { z } from 'zod';
import { workbenchQuerySchema, type WorkItem, type WorkItemList } from './work-items';

export const executionQuerySchema = z
  .object({
    year: z.coerce.number().int().min(1970).max(9999),
    annualId: z.uuid().optional(),
    type: z.enum(['monthly', 'weekly', 'daily']).optional(),
    completion: z.enum(['all', 'complete', 'incomplete']).default('all'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const alignmentCodes = [
  'annual_without_monthly',
  'monthly_without_annual',
  'monthly_without_weekly',
  'weekly_without_monthly',
  'weekly_without_daily',
  'daily_without_weekly',
  'parent_complete',
  'overdue',
] as const;
export const alignmentQuerySchema = workbenchQuerySchema.safeExtend({
  rule: z.enum(alignmentCodes).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export type ExecutionQuery = z.infer<typeof executionQuerySchema>;
export type AlignmentQuery = z.infer<typeof alignmentQuerySchema>;
export type AlignmentCode = (typeof alignmentCodes)[number];
export interface Metric {
  value: number | null;
  total: number;
  completed: number;
  totalWeight?: number;
  minutes?: number;
}
export interface ExecutionCount {
  total: number;
  completed: number;
}
export interface AnnualGroup extends ExecutionCount {
  annualId: string;
  title: string;
  byType: Record<'monthly' | 'weekly' | 'daily', ExecutionCount>;
}
export interface Overview {
  asOfDate: string;
  annual: Metric;
  monthly: Metric;
  weekly: Metric;
  daily: Metric;
  focus: WorkItem | null;
  ancestors: WorkItem[];
  annualGroups: AnnualGroup[];
  monthlyGroups: (ExecutionCount & {
    monthlyId: string;
    byType: Record<'weekly' | 'daily', ExecutionCount>;
  })[];
  execution: ExecutionCount;
}
export interface ExecutionItem {
  item: WorkItem;
  annualId: string;
  annualTitle: string;
  completed: boolean;
}
export interface ExecutionList {
  items: ExecutionItem[];
  ancestors: WorkItem[];
  total: number;
  limit: number;
  offset: number;
}
export interface AlignmentIssue {
  code: AlignmentCode;
  item: WorkItem;
}
export interface AlignmentList {
  items: AlignmentIssue[];
  ancestors: WorkItem[];
  total: number;
  overallTotal: number;
  affectedItems: number;
  counts: Record<AlignmentCode, number>;
  limit: number;
  offset: number;
  asOfDate: string;
}
export interface WorkItemDetail extends Pick<WorkItemList, 'ancestors'> {
  item: WorkItem;
}
