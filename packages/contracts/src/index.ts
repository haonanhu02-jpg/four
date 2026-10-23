import { z } from 'zod';
export * from './work-items';
export * from './insights';
export * from './history';
export * from './data-transfer';
export * from './sample';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位');
export const codeSchema = z.string().regex(/^\d{6}$/, '请输入 6 位验证码');
export const otpPurposeSchema = z.enum(['register', 'login', 'reset']);
export const requestCodeSchema = z
  .object({ email: emailSchema, purpose: otpPurposeSchema })
  .strict();
export const registerSchema = z
  .object({ email: emailSchema, password: passwordSchema, code: codeSchema })
  .strict();
export const passwordLoginSchema = z
  .object({ email: emailSchema, password: passwordSchema })
  .strict();
export const otpLoginSchema = z.object({ email: emailSchema, code: codeSchema }).strict();
export const resetPasswordSchema = z
  .object({ email: emailSchema, code: codeSchema, password: passwordSchema })
  .strict();
export const mutationMetadataSchema = z.object({
  operationId: z.uuid(),
  baseVersion: z.number().int().positive(),
});

export type OtpPurpose = z.infer<typeof otpPurposeSchema>;
export type RequestCodeInput = z.infer<typeof requestCodeSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type PasswordLoginInput = z.infer<typeof passwordLoginSchema>;
export type OtpLoginInput = z.infer<typeof otpLoginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type MutationMetadata = z.infer<typeof mutationMetadataSchema>;
export type TaskStatus = 'todo' | 'doing' | 'block' | 'done';
export type Priority = 'P0' | 'P1' | 'P2';
export type WorkItemType = 'annual' | 'monthly' | 'weekly' | 'daily';

export interface PublicUser {
  id: string;
  email: string;
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
export interface RequestCodeResponse extends MessageResponse {
  retryAfterSeconds: number;
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
  | 'INVALID_CODE'
  | 'EMAIL_IN_USE'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'MAIL_UNAVAILABLE'
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
  requestCode: '/api/auth/code',
  register: '/api/auth/register',
  passwordLogin: '/api/auth/login',
  otpLogin: '/api/auth/login/otp',
  resetPassword: '/api/auth/password/reset',
  logout: '/api/auth/logout',
  accountSummary: '/api/account/summary',
} as const;
