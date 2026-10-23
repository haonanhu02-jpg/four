import { z } from 'zod';
import type { WorkItemType } from './index';

export const workItemTypeSchema = z.enum(['annual', 'monthly', 'weekly', 'daily']);
export const businessDateSchema = z.iso
  .date()
  .refine((value) => value >= '1970-01-01', '日期不能早于 1970 年');
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .refine((value) => value >= '1970-01', '月份不能早于 1970 年');
const text = z.string().max(500, '标题最多 500 字');
const note = z.string().max(10000, '说明最多 10000 字');
const parentId = z.uuid().nullable();
const progress = z.number().min(0).max(100);
const weight = z.number().min(0).max(100);
const annual = z
  .object({ title: text, note, year: z.number().int().min(1970).max(9999), progress, weight })
  .strict();
const monthly = z
  .object({
    title: text,
    note,
    month: monthSchema,
    dueDate: businessDateSchema.nullable(),
    progress,
    weight,
    parentId,
  })
  .strict();
const weekly = z
  .object({
    title: text,
    note,
    startDate: businessDateSchema,
    endDate: businessDateSchema,
    priority: z.enum(['P0', 'P1', 'P2']),
    status: z.enum(['todo', 'doing', 'block', 'done']),
    parentId,
  })
  .strict();
const daily = z
  .object({
    title: text,
    date: businessDateSchema,
    minutes: z.number().int().min(0).max(1440),
    done: z.boolean(),
    parentId,
  })
  .strict();
export const workItemValueSchemas = { annual, monthly, weekly, daily };
export const workItemCreateSchemas = {
  annual: annual.partial().required({ year: true }),
  monthly: monthly.partial().required({ month: true }),
  weekly: weekly.partial().required({ startDate: true, endDate: true }),
  daily: daily.partial().required({ date: true }),
};
export const mutationSchema = z
  .object({ operationId: z.uuid(), baseVersion: z.number().int().positive() })
  .strict();
export const workItemQuerySchema = z
  .object({
    year: z.coerce.number().int().min(1970).max(9999).optional(),
    month: monthSchema.optional(),
    start: businessDateSchema.optional(),
    end: businessDateSchema.optional(),
    date: businessDateSchema.optional(),
    search: z.string().trim().max(100).optional(),
    deleted: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict()
  .refine(
    (q) => Boolean(q.start) === Boolean(q.end) && (!q.start || !q.end || q.start <= q.end),
    '起止日期需要同时填写，且结束日期不能早于开始日期',
  );
export const workbenchQuerySchema = z
  .object({
    year: z.coerce.number().int().min(1970).max(9999),
    month: monthSchema,
    start: businessDateSchema,
    end: businessDateSchema,
    date: businessDateSchema,
  })
  .strict()
  .refine((q) => q.start <= q.end, '结束日期不能早于开始日期');
export type WorkItemQuery = z.infer<typeof workItemQuerySchema>;
export type WorkbenchQuery = z.infer<typeof workbenchQuerySchema>;
export interface WorkItemValues {
  title?: string;
  note?: string;
  year?: number;
  month?: string;
  dueDate?: string | null;
  progress?: number;
  weight?: number;
  parentId?: string | null;
  startDate?: string;
  endDate?: string;
  priority?: 'P0' | 'P1' | 'P2';
  status?: 'todo' | 'doing' | 'block' | 'done';
  date?: string;
  minutes?: number;
  done?: boolean;
}
export interface WorkItem extends WorkItemValues {
  id: string;
  type: WorkItemType;
  title: string;
  note: string;
  parentId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  rolloverCount?: number;
  archivedAt?: string | null;
  originalMonth?: string;
  originalStartDate?: string;
  originalEndDate?: string;
  originalDate?: string;
  completedAt?: string | null;
}
export interface WorkItemList {
  items: WorkItem[];
  ancestors: WorkItem[];
  total: number;
  limit: number;
  offset: number;
}
export interface WorkItemResult {
  item: WorkItem;
  detachedChildren: number;
}
export type WorkbenchResponse = Record<WorkItemType, WorkItemList>;
export interface CreateWorkItemInput {
  operationId: string;
  itemId?: string;
  values: WorkItemValues;
}
export interface UpdateWorkItemInput extends CreateWorkItemInput {
  baseVersion: number;
}
