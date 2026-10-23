import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  carryoverResolutionSchema,
  historyChangesSchema,
  historyDetailSchema,
  historyListSchema,
  pageSchema,
  sealPeriodSchema,
} from '@workbench/contracts';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { ApiException, SchemaPipe } from './http';
import { HistoryService } from './history.service';
import { RolloverService } from './rollover.service';
@Controller()
export class HistoryController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(HistoryService) private readonly history: HistoryService,
    @Inject(RolloverService) private readonly rollover: RolloverService,
  ) {}
  private async user(req: Request) {
    const id = (await this.auth.getSession(req.cookies?.[SESSION_COOKIE])).user.id;
    const expected = req.get('X-Workbench-Account');
    if (expected && expected !== id)
      throw new ApiException('FORBIDDEN', '浏览器账号已切换，请重新打开工作台', 403);
    return id;
  }
  @Post('rollover/reconcile')
  async reconcile(
    @Req() req: Request,
    @Body(new SchemaPipe(z.object({}).strict())) _body: Record<string, never>,
  ) {
    void _body;
    return this.rollover.reconcile(await this.user(req));
  }
  @Get('rollover/carryovers')
  async carryovers(
    @Req() req: Request,
    @Query(new SchemaPipe(pageSchema)) q: z.infer<typeof pageSchema>,
  ) {
    return this.rollover.carryovers(await this.user(req), q);
  }
  @Post('rollover/carryovers/:id/resolve')
  async resolve(
    @Req() req: Request,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
    @Body(new SchemaPipe(carryoverResolutionSchema))
    body: z.infer<typeof carryoverResolutionSchema>,
  ) {
    return this.rollover.resolve(await this.user(req), id, body);
  }
  @Get('history/periods')
  async periods(
    @Req() req: Request,
    @Query(new SchemaPipe(historyListSchema)) q: z.infer<typeof historyListSchema>,
  ) {
    return this.history.list(await this.user(req), q);
  }
  @Post('history/periods')
  async seal(
    @Req() req: Request,
    @Body(new SchemaPipe(sealPeriodSchema)) body: z.infer<typeof sealPeriodSchema>,
  ) {
    return { id: await this.history.seal(await this.user(req), body) };
  }
  @Get('history/periods/:id')
  async detail(
    @Req() req: Request,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
    @Query(new SchemaPipe(historyDetailSchema)) q: z.infer<typeof historyDetailSchema>,
  ) {
    return this.history.detail(await this.user(req), id, q);
  }
  @Get('history/changes')
  async changes(
    @Req() req: Request,
    @Query(new SchemaPipe(historyChangesSchema)) q: z.infer<typeof historyChangesSchema>,
  ) {
    return this.history.changes(await this.user(req), q);
  }
}
