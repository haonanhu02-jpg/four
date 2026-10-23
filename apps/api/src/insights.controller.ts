import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  alignmentQuerySchema,
  executionQuerySchema,
  workbenchQuerySchema,
  type AlignmentQuery,
  type ExecutionQuery,
  type WorkbenchQuery,
} from '@workbench/contracts';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { ApiException, SchemaPipe } from './http';
import { InsightsService } from './insights.service';

@Controller()
export class InsightsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(InsightsService) private readonly insights: InsightsService,
  ) {}
  private async user(request: Request) {
    const id = (await this.auth.getSession(request.cookies?.[SESSION_COOKIE])).user.id;
    const expected = request.get('X-Workbench-Account');
    if (expected && expected !== id)
      throw new ApiException('FORBIDDEN', '浏览器账号已切换，请重新打开工作台', 403);
    return id;
  }
  @Get('overview')
  async overview(
    @Req() req: Request,
    @Query(new SchemaPipe(workbenchQuerySchema)) q: WorkbenchQuery,
  ) {
    return this.insights.overview(await this.user(req), q);
  }
  @Get('annual-execution')
  async execution(
    @Req() req: Request,
    @Query(new SchemaPipe(executionQuerySchema)) q: ExecutionQuery,
  ) {
    return this.insights.execution(await this.user(req), q);
  }
  @Get('alignment-check')
  async alignment(
    @Req() req: Request,
    @Query(new SchemaPipe(alignmentQuerySchema)) q: AlignmentQuery,
  ) {
    return this.insights.alignment(await this.user(req), q);
  }
}
