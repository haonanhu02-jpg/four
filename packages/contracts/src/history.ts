import { z } from 'zod';
import {
  businessDateSchema,
  mutationSchema,
  workItemTypeSchema,
  type WorkItem,
} from './work-items';
export const periodTypes = ['year', 'month', 'week', 'day'] as const;
export type PeriodType = (typeof periodTypes)[number];
export const pageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const historyListSchema = pageSchema.extend({ periodType: z.enum(periodTypes).optional() });
export const historyDetailSchema = pageSchema.extend({
  type: workItemTypeSchema.optional(),
  completion: z.enum(['all', 'complete', 'incomplete']).default('all'),
});
export const historyChangesSchema = pageSchema.extend({
  itemType: workItemTypeSchema.optional(),
  itemId: z.uuid().optional(),
});
export const sealPeriodSchema = z
  .object({ periodType: z.enum(periodTypes), start: businessDateSchema, end: businessDateSchema })
  .strict()
  .refine((v) => v.start <= v.end, '结束日期不能早于开始日期');
export const carryoverResolutionSchema = mutationSchema
  .extend({ choice: z.enum(['keep', 'relink']), annualId: z.uuid().optional() })
  .refine(
    (v) => (v.choice === 'relink' ? Boolean(v.annualId) : !v.annualId),
    '更换年度目标时需要指定新目标',
  );
export interface PeriodDefinition {
  periodType: PeriodType;
  start: string;
  end: string;
}
export interface FrozenItem {
  item: WorkItem;
  ancestors: WorkItem[];
}
export interface PeriodRecord extends PeriodDefinition {
  id: string;
  key: string;
  capturedAt: string;
  reason: string;
  total: number;
  completed: number;
}
export interface PeriodList {
  items: PeriodRecord[];
  total: number;
  limit: number;
  offset: number;
}
export interface PeriodDetail {
  period: PeriodRecord;
  items: FrozenItem[];
  total: number;
  limit: number;
  offset: number;
}
export interface ScheduleChange {
  id: string;
  itemType: WorkItem['type'];
  itemId: string;
  from: Record<string, string>;
  to: Record<string, string>;
  reason: string;
  createdAt: string;
  snapshot: FrozenItem;
}
export interface ChangeList {
  items: ScheduleChange[];
  total: number;
  limit: number;
  offset: number;
}
export interface Carryover {
  id: string;
  fromYear: number;
  targetYear: number;
  source: FrozenItem;
  current: WorkItem;
  ancestors: WorkItem[];
}
export interface CarryoverList {
  items: Carryover[];
  total: number;
  limit: number;
  offset: number;
}
export interface ReconcileResult {
  asOfDate: string;
  changed: Record<'monthly' | 'weekly' | 'daily', number>;
  remaining: number;
  pendingCarryovers: number;
}
