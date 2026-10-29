import { z } from 'zod';
// Kept separate from self-registration so clients cannot grant themselves roles.
export const adminUsernameSchema = z.string().trim().toLowerCase().min(1).max(254).regex(/^\S+$/);
export const adminPasswordSchema = z.string().min(6, '密码至少 6 位').max(128);
export const adminCreateSchema = z
  .object({
    username: adminUsernameSchema,
    password: adminPasswordSchema,
    role: z.enum(['user', 'admin']).default('user'),
  })
  .strict();
export const adminUpdateSchema = z
  .object({ username: adminUsernameSchema.optional(), role: z.enum(['user', 'admin']).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, '请填写要修改的内容');
export const adminResetSchema = z.object({ password: adminPasswordSchema }).strict();
export const adminListSchema = z
  .object({
    search: z.string().trim().max(100).default(''),
    status: z.enum(['all', 'active', 'disabled', 'deleted']).default('all'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const adminLogSchema = z
  .object({
    search: z.string().trim().max(100).default(''),
    action: z
      .enum([
        'all',
        'bootstrap',
        'create',
        'update',
        'reset_password',
        'disable',
        'enable',
        'delete',
        'restore',
      ])
      .default('all'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export interface ManagedAccount {
  id: string;
  username: string;
  role: 'user' | 'admin';
  disabledAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ManagedAccounts {
  items: ManagedAccount[];
  total: number;
  limit: number;
  offset: number;
}
export interface AdminAuditLog {
  id: string;
  actorId: string;
  actorUsername: string;
  targetId: string;
  targetUsername: string;
  action: string;
  before: ManagedAccount | null;
  after: ManagedAccount;
  requestId: string;
  ip: string;
  createdAt: string;
}
export interface AdminAuditList {
  items: AdminAuditLog[];
  total: number;
  limit: number;
  offset: number;
}
