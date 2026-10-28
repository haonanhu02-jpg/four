import { z } from 'zod';
export * from './work-items';
export * from './insights';
export * from './history';
export * from './data-transfer';
export * from './sample';

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, '请输入您的工号')
  .max(254, '工号最多 254 位')
  .regex(/^\S+$/, '工号不能包含空白字符');
export const passwordSchema = z.string().min(6, '密码至少 6 位').max(128, '密码最多 128 位');
export const registerSchema = z
  .object({ username: usernameSchema, password: passwordSchema })
  .strict();
export const passwordLoginSchema = z
  .object({ username: usernameSchema, password: passwordSchema })
  .strict();
export const mutationMetadataSchema = z.object({
  operationId: z.uuid(),
  baseVersion: z.number().int().positive(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;
export type MutationMetadata = z.infer<typeof mutationMetadataSchema>;
export type TaskStatus = 'todo' | 'doing' | 'block' | 'done';
export type Priority = 'P0' | 'P1' | 'P2';
export type WorkItemType = 'annual' | 'monthly' | 'weekly' | 'daily';

export interface PublicUser {
  id: string;
  username: string;
  /** Read-only compatibility for profiles cached before employee-number login. */
  email?: string;
  timezone: string;
  createdAt: string;
}
export interface AuthResponse {
  cacheGeneration?: string;
  user: PublicUser;
  sessionExpiresAt: string;
}
export interface MessageResponse {
  message: string;
}
export interface AccountSummary {
  user: PublicUser;
  counts: { annualGoals: number; monthlyGoals: number; weeklyTasks: number; dailyTasks: number };
}
export interface HealthResponse {
  status: 'ok';
  database: 'connected';
  version: string;
}
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'USERNAME_IN_USE'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';
export interface ApiErrorResponse {
  error: { code: ApiErrorCode; message: string; requestId: string; details?: unknown };
}
export interface VersionConflictDetails {
  currentVersion: number;
  currentRecord?: unknown;
}

export const API = {
  health: '/api/health',
  me: '/api/auth/me',
  register: '/api/auth/register',
  passwordLogin: '/api/auth/login',
  logout: '/api/auth/logout',
  accountSummary: '/api/account/summary',
} as const;
