import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { AccountSummary } from '@workbench/contracts';
import type { Request } from 'express';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { DatabaseService } from './database.service';

@Controller('account')
export class AccountController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get('summary')
  async summary(@Req() request: Request): Promise<AccountSummary> {
    const session = await this.auth.getSession(request.cookies?.[SESSION_COOKIE]);
    const result = await this.database.pool.query<{
      annual: number;
      monthly: number;
      weekly: number;
      daily: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM annual_goals WHERE user_id = $1 AND deleted_at IS NULL) AS annual,
        (SELECT count(*)::int FROM monthly_goals WHERE user_id = $1 AND deleted_at IS NULL) AS monthly,
        (SELECT count(*)::int FROM weekly_tasks WHERE user_id = $1 AND deleted_at IS NULL) AS weekly,
        (SELECT count(*)::int FROM daily_tasks WHERE user_id = $1 AND deleted_at IS NULL) AS daily`,
      [session.user.id],
    );
    const counts = result.rows[0];
    return {
      user: session.user,
      counts: {
        annualGoals: counts?.annual ?? 0,
        monthlyGoals: counts?.monthly ?? 0,
        weeklyTasks: counts?.weekly ?? 0,
        dailyTasks: counts?.daily ?? 0,
      },
    };
  }
}
