import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthResponse,
  OtpLoginInput,
  OtpPurpose,
  PasswordLoginInput,
  PublicUser,
  RegisterInput,
  RequestCodeInput,
  RequestCodeResponse,
  ResetPasswordInput,
} from '@workbench/contracts';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppConfig } from './config';
import { equalHash, hashPassword, hashToken, hmac, verifyPassword } from './crypto';
import { DatabaseService } from './database.service';
import { ApiException } from './http';
import { MailService } from './mail.service';

export const SESSION_COOKIE = 'workbench_session';
const CODE_TTL_MINUTES = 10;
const DUMMY_PASSWORD_HASH = `scrypt$32768$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  timezone: string;
  created_at: Date;
}

interface CodeRow {
  id: string;
  code_hash: string;
  attempts: number;
  consumed_at: Date | null;
  expired: boolean;
}

export interface CreatedSession {
  token: string;
  response: AuthResponse;
}

export interface CurrentSession {
  user: PublicUser;
  sessionExpiresAt: string;
  sessionId: string;
}

function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    timezone: row.timezone,
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  private async limit(bucket: string, limit: number, seconds: number): Promise<void> {
    const key = hmac(this.config.authTokenSecret, bucket);
    const result = await this.database.pool.query<{ attempts: number; retry_after: number }>(
      `INSERT INTO auth_rate_limits (bucket, window_started_at, attempts)
       VALUES ($1, now(), 1)
       ON CONFLICT (bucket) DO UPDATE SET
         attempts = CASE WHEN auth_rate_limits.window_started_at <= now() - $2 * interval '1 second'
           THEN 1 ELSE auth_rate_limits.attempts + 1 END,
         window_started_at = CASE WHEN auth_rate_limits.window_started_at <= now() - $2 * interval '1 second'
           THEN now() ELSE auth_rate_limits.window_started_at END
       RETURNING attempts,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_started_at + $2 * interval '1 second' - now()))))::int AS retry_after`,
      [key, seconds],
    );
    const row = result.rows[0];
    if (row && row.attempts > limit) {
      throw new ApiException('RATE_LIMITED', '操作过于频繁，请稍后再试', 429, {
        retryAfterSeconds: row.retry_after,
      });
    }
  }

  async requestCode(input: RequestCodeInput, ip: string): Promise<RequestCodeResponse> {
    await this.limit(`code:ip:${ip}`, 30, 600);
    await this.limit(`code:email:${input.email}`, 12, 3600);
    const result = await this.database.withTransaction(async (client) => {
      // Lock even before a code row exists, so concurrent first requests cannot bypass the cooldown.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `auth-code:${input.email}:${input.purpose}`,
      ]);
      const previous = await client.query<{ retry_after: number }>(
        `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (sent_at + interval '60 seconds' - now()))))::int AS retry_after
         FROM auth_codes WHERE email = $1 AND purpose = $2 FOR UPDATE`,
        [input.email, input.purpose],
      );
      const retryAfter = previous.rows[0]?.retry_after ?? 0;
      if (retryAfter > 0) {
        throw new ApiException('RATE_LIMITED', '验证码已发送，请稍后再试', 429, {
          retryAfterSeconds: retryAfter,
        });
      }
      const exists = await client.query('SELECT id FROM users WHERE email = $1', [input.email]);
      if (input.purpose === 'register' && exists.rowCount) {
        throw new ApiException('EMAIL_IN_USE', '这个邮箱已注册，请直接登录', 409);
      }
      // Store the cooldown for unknown addresses too, so a second request has the same behavior.
      const deliver = input.purpose === 'register' || Boolean(exists.rowCount);
      const id = randomUUID();
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const codeHash = this.codeHash(id, input.email, input.purpose, code);
      await client.query(
        `INSERT INTO auth_codes (id, email, purpose, code_hash, expires_at, attempts, sent_at, created_at, consumed_at)
         VALUES ($1, $2, $3, $4, now() + $5 * interval '1 minute', 0, now(), now(), NULL)
         ON CONFLICT (email, purpose) DO UPDATE SET id = EXCLUDED.id, code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = now(), created_at = now(), consumed_at = NULL`,
        [id, input.email, input.purpose, codeHash, CODE_TTL_MINUTES],
      );
      return { id, code, deliver };
    });
    if (result.deliver) {
      try {
        await this.mail.sendCode(input.email, input.purpose, result.code);
      } catch (error) {
        // Delete only this failed attempt; never delete a replacement code from a newer request.
        await this.database.pool.query('DELETE FROM auth_codes WHERE id = $1', [result.id]);
        throw error;
      }
    }
    return {
      message: '如果邮箱可用于此操作，验证码邮件已发送，请检查收件箱',
      retryAfterSeconds: 60,
    };
  }

  private codeHash(id: string, email: string, purpose: OtpPurpose, code: string): string {
    return hmac(this.config.authTokenSecret, `${id}:${email}:${purpose}:${code}`);
  }

  private async consumeCode(
    client: PoolClient,
    email: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<boolean> {
    const result = await client.query<CodeRow>(
      `SELECT id, code_hash, attempts, consumed_at, expires_at <= now() AS expired
       FROM auth_codes WHERE email = $1 AND purpose = $2 FOR UPDATE`,
      [email, purpose],
    );
    const row = result.rows[0];
    if (!row || row.expired || row.consumed_at || row.attempts >= 5) return false;
    if (!equalHash(row.code_hash, this.codeHash(row.id, email, purpose, code))) {
      await client.query('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return false;
    }
    await client.query('UPDATE auth_codes SET consumed_at = now() WHERE id = $1', [row.id]);
    return true;
  }

  private invalidCode(): ApiException {
    return new ApiException('INVALID_CODE', '验证码无效、已过期或已使用，请重新获取', 400);
  }

  async register(input: RegisterInput, ip: string): Promise<CreatedSession> {
    await this.limit(`register:${ip}`, 20, 900);
    const passwordHash = await hashPassword(input.password);
    const result = await this.database.withTransaction(async (client) => {
      if (!(await this.consumeCode(client, input.email, 'register', input.code))) return null;
      const user = await client.query<UserRow>(
        `INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, $2, now())
         ON CONFLICT (email) DO NOTHING RETURNING *`,
        [input.email, passwordHash],
      );
      const row = user.rows[0];
      if (!row) return { duplicate: true as const };
      return this.createSession(client, row);
    });
    if (!result) throw this.invalidCode();
    if ('duplicate' in result)
      throw new ApiException('EMAIL_IN_USE', '这个邮箱已注册，请直接登录', 409);
    return result;
  }

  async passwordLogin(input: PasswordLoginInput, ip: string): Promise<CreatedSession> {
    await this.limit(`login:ip:${ip}`, 100, 900);
    await this.limit(`login:email-ip:${input.email}:${ip}`, 15, 900);
    const result = await this.database.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [
      input.email,
    ]);
    const row = result.rows[0];
    const valid = await verifyPassword(input.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!row || !valid) {
      throw new ApiException('INVALID_CREDENTIALS', '邮箱或密码不正确', 401);
    }
    // Lock user against password reset while validating the password again and creating a session.
    return this.database.withTransaction(async (client) => {
      const current = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [
        row.id,
      ]);
      const currentUser = current.rows[0];
      if (!currentUser || currentUser.password_hash !== row.password_hash) {
        throw new ApiException('INVALID_CREDENTIALS', '密码已更新，请使用新密码登录', 401);
      }
      return this.createSession(client, currentUser);
    });
  }

  async otpLogin(input: OtpLoginInput, ip: string): Promise<CreatedSession> {
    await this.limit(`otp-login:${ip}`, 60, 900);
    const result = await this.database.withTransaction(async (client) => {
      const user = await client.query<UserRow>('SELECT * FROM users WHERE email = $1 FOR UPDATE', [
        input.email,
      ]);
      const row = user.rows[0];
      if (!row) return null;
      if (!(await this.consumeCode(client, input.email, 'login', input.code))) return null;
      return this.createSession(client, row);
    });
    if (!result) throw this.invalidCode();
    return result;
  }

  async resetPassword(input: ResetPasswordInput, ip: string): Promise<CreatedSession> {
    await this.limit(`reset:${ip}`, 20, 900);
    const passwordHash = await hashPassword(input.password);
    const result = await this.database.withTransaction(async (client) => {
      // Every existing-account code flow locks user before code, avoiding reset/login deadlocks.
      const existing = await client.query<UserRow>(
        'SELECT * FROM users WHERE email = $1 FOR UPDATE',
        [input.email],
      );
      if (!existing.rows[0]) return null;
      if (!(await this.consumeCode(client, input.email, 'reset', input.code))) return null;
      const user = await client.query<UserRow>(
        'UPDATE users SET password_hash = $2, updated_at = now() WHERE email = $1 RETURNING *',
        [input.email, passwordHash],
      );
      const row = user.rows[0];
      if (!row) return null;
      await client.query(
        'UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [row.id],
      );
      await client.query(
        "UPDATE auth_codes SET consumed_at = now() WHERE email = $1 AND purpose = 'login' AND consumed_at IS NULL",
        [input.email],
      );
      return this.createSession(client, row);
    });
    if (!result) throw this.invalidCode();
    return result;
  }

  private async createSession(client: PoolClient, user: UserRow): Promise<CreatedSession> {
    const token = randomBytes(32).toString('base64url');
    const result = await client.query<{ expires_at: Date }>(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + $3 * interval '1 day') RETURNING expires_at`,
      [user.id, hashToken(token), this.config.sessionTtlDays],
    );
    const expiry = result.rows[0]?.expires_at;
    if (!expiry) throw new Error('Session was not created');
    return { token, response: { user: publicUser(user), sessionExpiresAt: expiry.toISOString() } };
  }

  async getSession(token: unknown): Promise<CurrentSession> {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) {
      throw new ApiException('UNAUTHENTICATED', '请先登录', 401);
    }
    const result = await this.database.pool.query<
      UserRow & { session_id: string; expires_at: Date }
    >(
      `SELECT u.*, s.id AS session_id, s.expires_at FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hashToken(token)],
    );
    const row = result.rows[0];
    if (!row) throw new ApiException('UNAUTHENTICATED', '登录已过期，请重新登录', 401);
    return {
      user: publicUser(row),
      sessionExpiresAt: row.expires_at.toISOString(),
      sessionId: row.session_id,
    };
  }

  async logout(token: unknown): Promise<void> {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) return;
    await this.database.pool.query(
      'UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(token)],
    );
  }
}
