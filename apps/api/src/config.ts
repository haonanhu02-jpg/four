import { Injectable } from '@nestjs/common';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(__dirname, '../../../.env'), quiet: true });

function integer(name: string, fallback: number, min = 1, max = 65535): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}–${max} 的整数`);
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

@Injectable()
export class AppConfig {
  readonly databaseUrl = required('DATABASE_URL');
  readonly authTokenSecret = required('AUTH_TOKEN_SECRET');
  readonly appOrigin = new URL(required('APP_ORIGIN')).origin;
  readonly port = integer('PORT', 3000);
  readonly poolMax = integer('DB_POOL_MAX', 10, 1, 100);
  readonly sessionTtlDays = integer('SESSION_TTL_DAYS', 7, 1, 30);
  readonly trustProxyHops = integer('TRUST_PROXY_HOPS', 0, 0, 5);
  readonly smtpHost = required('SMTP_HOST');
  readonly smtpPort = integer('SMTP_PORT', 1025);
  readonly smtpFrom = required('SMTP_FROM');
  readonly smtpSecure = process.env.SMTP_SECURE === 'true';
  readonly smtpUser = process.env.SMTP_USER;
  readonly smtpPassword = process.env.SMTP_PASS ?? process.env.SMTP_PASSWORD;
  readonly production = process.env.NODE_ENV === 'production';
  readonly cookieSecure = process.env.COOKIE_SECURE === 'true';

  constructor() {
    if (this.authTokenSecret.length < 32) {
      throw new Error('AUTH_TOKEN_SECRET 至少需要 32 个字符');
    }
    const origin = new URL(this.appOrigin);
    if (!['http:', 'https:'].includes(origin.protocol)) {
      throw new Error('APP_ORIGIN 必须使用 HTTP 或 HTTPS');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (this.production && !loopback && (!this.cookieSecure || origin.protocol !== 'https:')) {
      throw new Error('生产环境需要 HTTPS APP_ORIGIN 和 COOKIE_SECURE=true');
    }
  }
}
