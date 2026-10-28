import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthResponse,
  PasswordLoginInput,
  PublicUser,
  RegisterInput,
} from '@workbench/contracts';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppConfig } from './config';
import { hashPassword, hashToken, hmac, verifyPassword } from './crypto';
import { DatabaseService } from './database.service';
import { ApiException } from './http';

export const SESSION_COOKIE = 'workbench_session';
const DUMMY_PASSWORD_HASH = `scrypt$32768$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`;

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  timezone: string;
  created_at: Date;
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
    username: row.username,
    timezone: row.timezone,
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AppConfig) private readonly config: AppConfig,
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

  async register(input: RegisterInput, ip: string): Promise<CreatedSession> {
    await this.limit(`register:${ip}`, 20, 900);
    const passwordHash = await hashPassword(input.password);
    return this.database.withTransaction(async (client) => {
      const user = await client.query<UserRow>(
        `INSERT INTO users (username, password_hash) VALUES ($1, $2)
         ON CONFLICT (username) DO NOTHING RETURNING *`,
        [input.username, passwordHash],
      );
      const row = user.rows[0];
      if (!row) throw new ApiException('USERNAME_IN_USE', '这个工号已注册，请直接登录', 409);
      return this.createSession(client, row);
    });
  }

  async passwordLogin(input: PasswordLoginInput, ip: string): Promise<CreatedSession> {
    await this.limit(`login:ip:${ip}`, 100, 900);
    await this.limit(`login:username-ip:${input.username}:${ip}`, 15, 900);
    const result = await this.database.pool.query<UserRow>(
      'SELECT * FROM users WHERE username = $1',
      [input.username],
    );
    const row = result.rows[0];
    const valid = await verifyPassword(input.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!row || !valid) {
      throw new ApiException('INVALID_CREDENTIALS', '工号或密码不正确', 401);
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
