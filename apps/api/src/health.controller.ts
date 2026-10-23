import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@workbench/contracts';
import { DatabaseService } from './database.service';
import { ApiException } from './http';

@Controller('health')
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  @Get('live')
  live() {
    return { status: 'ok' as const, version: process.env.APP_VERSION || '1.0.0' };
  }

  @Get()
  async ready(): Promise<HealthResponse> {
    try {
      await this.database.pool.query('SELECT id FROM users LIMIT 1');
      return { status: 'ok', database: 'connected', version: process.env.APP_VERSION || '1.0.0' };
    } catch {
      throw new ApiException('SERVICE_UNAVAILABLE', '数据库尚未就绪，请检查连接及迁移状态', 503);
    }
  }
}
