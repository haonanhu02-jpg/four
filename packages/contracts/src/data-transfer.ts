import { z } from 'zod';
import {
  workItemTypeSchema,
  workItemValueSchemas,
  businessDateSchema,
  monthSchema,
  type WorkItem,
} from './work-items';
import type { WorkItemType } from './index';
export const dataKinds = ['annual', 'monthly', 'weekly', 'daily'] as const;
export interface TransferDocument {
  format: 'four-layer-workbench';
  version: 3;
  exportedAt: string;
  items: Record<WorkItemType, WorkItem[]>;
}
export interface ImportCounts {
  annual: number;
  monthly: number;
  weekly: number;
  daily: number;
}
export interface ImportPreview {
  id: string;
  mode: 'append' | 'replace';
  counts: ImportCounts;
  current: ImportCounts;
  warnings: string[];
  titles: string[];
  expiresAt: string;
  pastItems: number;
}
export interface ImportResult {
  previewId: string;
  counts: ImportCounts;
  backupId: string | null;
  requiresReconcile: boolean;
}
export interface DataBackup {
  id: string;
  reason: 'clear' | 'replace' | 'restore';
  createdAt: string;
  counts: ImportCounts;
}
export interface BackupList {
  items: DataBackup[];
  total: number;
  offset: number;
  limit: number;
}
const stamp = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(100);
const meta = {
  id,
  note: z.string().max(10000).optional(),
  parentId: id.nullable().optional(),
  type: workItemTypeSchema.optional(),
  version: z.number().int().positive().optional(),
  createdAt: stamp.optional(),
  updatedAt: stamp.optional(),
  deletedAt: stamp.nullable().optional(),
  archivedAt: stamp.nullable().optional(),
  rolloverCount: z.number().int().min(0).max(1000000).optional(),
  originalMonth: monthSchema.optional(),
  originalStartDate: businessDateSchema.optional(),
  originalEndDate: businessDateSchema.optional(),
  originalDate: businessDateSchema.optional(),
  completedAt: stamp.nullable().optional(),
};
export const transferRecordSchemas = {
  annual: workItemValueSchemas.annual.partial().required({ year: true }).extend(meta).strict(),
  monthly: workItemValueSchemas.monthly
    .partial()
    .required({ month: true })
    .extend({ ...meta, parentId: id.nullable().optional() })
    .strict(),
  weekly: workItemValueSchemas.weekly
    .partial()
    .required({ startDate: true, endDate: true })
    .extend({ ...meta, parentId: id.nullable().optional() })
    .strict(),
  daily: workItemValueSchemas.daily
    .partial()
    .required({ date: true })
    .extend({ ...meta, parentId: id.nullable().optional() })
    .strict(),
};
export function normalizeDocument(input: unknown): {
  document: TransferDocument;
  warnings: string[];
} {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('文件需要是 JSON 对象');
  const raw = input as Record<string, unknown>;
  const legacy = raw.version === 1 || raw.version === 2;
  if (!legacy && (raw.format !== 'four-layer-workbench' || raw.version !== 3))
    throw new Error('不支持此文件版本，请选择原工作台 JSON 或版本 3 导出文件');
  const root = legacy ? raw : (raw.items as Record<string, unknown>);
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('缺少四层事项列表');
  const result: Record<WorkItemType, WorkItem[]> = {
    annual: [],
    monthly: [],
    weekly: [],
    daily: [],
  };
  const ids = new Map<string, WorkItemType>();
  let total = 0;
  for (const type of dataKinds) {
    const key = legacy
      ? { annual: 'years', monthly: 'months', weekly: 'weeks', daily: 'days' }[type]
      : type;
    const rows = root[key];
    if (!Array.isArray(rows)) throw new Error(`缺少 ${key} 数组`);
    total += rows.length;
    if (total > 10000) throw new Error('单次文件最多 10000 条事项，请按周期分批整理');
    for (const [index, source] of rows.entries()) {
      if (!source || typeof source !== 'object' || Array.isArray(source))
        throw new Error(`${key} 第 ${index + 1} 条需要是事项对象`);
      const v = source as Record<string, unknown>;
      let mapped: unknown = v;
      if (legacy) {
        const common = {
          id: v.id,
          title: v.title ?? '',
          ...(['annual', 'monthly', 'weekly'].includes(type) ? { note: v.note ?? '' } : {}),
        };
        mapped =
          type === 'annual'
            ? { ...common, year: v.year, progress: v.progress ?? 0, weight: v.weight ?? 1 }
            : type === 'monthly'
              ? {
                  ...common,
                  month: v.month,
                  progress: v.progress ?? 0,
                  weight: v.weight ?? 1,
                  dueDate: v.due || null,
                  parentId: v.yearId || null,
                }
              : type === 'weekly'
                ? {
                    ...common,
                    startDate: v.wkStart,
                    endDate: v.wkEnd,
                    status: v.status ?? 'todo',
                    priority: v.priority ?? 'P1',
                    parentId: v.monthId || null,
                  }
                : {
                    ...common,
                    date: v.date,
                    minutes: v.minutes ?? 30,
                    done: v.done ?? false,
                    parentId: v.weekId || null,
                  };
      }
      const parsed = transferRecordSchemas[type].safeParse(mapped);
      if (!parsed.success)
        throw new Error(
          `${key} 第 ${index + 1} 条：${parsed.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .slice(0, 3)
            .join('；')}`,
        );
      const value = parsed.data;
      if (value.type && value.type !== type) throw new Error(`${key} 第 ${index + 1} 条层级错误`);
      if (type === 'annual' && value.parentId) throw new Error('年度目标不能关联上级');
      if (ids.has(value.id)) throw new Error(`事项编号重复：${value.id}`);
      ids.set(value.id, type);
      const now = new Date().toISOString();
      const item: WorkItem = {
        ...value,
        id: value.id,
        type,
        title: value.title ?? '',
        note: 'note' in value ? (value.note ?? '') : '',
        parentId: 'parentId' in value ? (value.parentId ?? null) : null,
        version: value.version ?? 1,
        createdAt: value.createdAt ?? now,
        updatedAt: value.updatedAt ?? now,
        deletedAt: value.deletedAt ?? null,
        archivedAt: value.archivedAt ?? null,
        rolloverCount: value.rolloverCount ?? 0,
      };
      if (type === 'annual' || type === 'monthly') {
        item.progress ??= 0;
        item.weight ??= 1;
      }
      if (type === 'monthly') {
        item.originalMonth ??= item.month;
        item.dueDate ??= null;
      }
      if (type === 'weekly') {
        if (item.startDate! > item.endDate!)
          throw new Error(`周任务 ${item.id} 结束日期早于开始日期`);
        item.originalStartDate ??= item.startDate;
        item.originalEndDate ??= item.endDate;
        if (item.originalStartDate! > item.originalEndDate!)
          throw new Error(`周任务 ${item.id} 原区间无效`);
        item.status ??= 'todo';
        item.priority ??= 'P1';
      }
      if (type === 'daily') {
        item.originalDate ??= item.date;
        item.minutes ??= 30;
        item.done ??= false;
        item.completedAt = item.done ? (item.completedAt ?? now) : null;
      }
      result[type].push(item);
    }
  }
  const warnings: string[] = [];
  let missing = 0;
  for (const type of ['monthly', 'weekly', 'daily'] as const) {
    const parentType = { monthly: 'annual', weekly: 'monthly', daily: 'weekly' }[type];
    for (const item of result[type])
      if (item.parentId) {
        const found = ids.get(item.parentId);
        if (found && found !== parentType) throw new Error(`事项 ${item.id} 的上级属于错误层级`);
        if (!found) {
          item.parentId = null;
          missing++;
        }
      }
  }
  if (missing) warnings.push(`${missing} 条事项引用了文件内不存在的上级，将保留内容并标为未关联`);
  return {
    document: {
      format: 'four-layer-workbench',
      version: 3,
      exportedAt: new Date().toISOString(),
      items: result,
    },
    warnings,
  };
}
export const documentCounts = (doc: TransferDocument): ImportCounts => ({
  annual: doc.items.annual.length,
  monthly: doc.items.monthly.length,
  weekly: doc.items.weekly.length,
  daily: doc.items.daily.length,
});
export const dataPreviewSchema = z
  .object({ document: z.unknown(), mode: z.enum(['append', 'replace']) })
  .strict();
export const dataCommitSchema = z.object({ previewId: z.uuid(), operationId: z.uuid() }).strict();
export const dataClearSchema = z
  .object({ operationId: z.uuid(), revision: z.string().min(1).max(100) })
  .strict();
