import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  mutationSchema,
  workbenchQuerySchema,
  workItemQuerySchema,
  workItemTypeSchema,
} from '@workbench/contracts';
import { z } from 'zod';
import type { Request } from 'express';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { ApiException, SchemaPipe } from './http';
import { WorkItemsService } from './work-items.service';

const create = z
  .object({
    operationId: z.uuid(),
    itemId: z.uuid().optional(),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();
const update = create.omit({ itemId: true }).extend({ baseVersion: z.number().int().positive() });

@Controller()
export class WorkItemsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WorkItemsService) private readonly items: WorkItemsService,
  ) {}
  private async user(request: Request): Promise<string> {
    const user = (await this.auth.getSession(request.cookies?.[SESSION_COOKIE])).user.id;
    const expected = request.get('X-Workbench-Account');
    if (expected && expected !== user)
      throw new ApiException(
        'FORBIDDEN',
        '浏览器账号已切换，请先保存当前内容并重新打开工作台',
        403,
      );
    return user;
  }

  @Get('workbench')
  async workbench(
    @Req() request: Request,
    @Query(new SchemaPipe(workbenchQuerySchema)) query: z.infer<typeof workbenchQuerySchema>,
  ) {
    return this.items.workbench(await this.user(request), query);
  }
  @Get('work-items/:type')
  async list(
    @Req() request: Request,
    @Param('type', new SchemaPipe(workItemTypeSchema)) type: z.infer<typeof workItemTypeSchema>,
    @Query(new SchemaPipe(workItemQuerySchema)) query: z.infer<typeof workItemQuerySchema>,
  ) {
    return this.items.list(await this.user(request), type, query);
  }
  @Post('work-items/:type')
  async create(
    @Req() request: Request,
    @Param('type', new SchemaPipe(workItemTypeSchema)) type: z.infer<typeof workItemTypeSchema>,
    @Body(new SchemaPipe(create)) body: z.infer<typeof create>,
  ) {
    return this.items.create(
      await this.user(request),
      type,
      body.operationId,
      body.values,
      body.itemId,
    );
  }
  @Get('work-items/:type/:id')
  async detail(
    @Req() request: Request,
    @Param('type', new SchemaPipe(workItemTypeSchema)) type: z.infer<typeof workItemTypeSchema>,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
  ) {
    return this.items.detail(await this.user(request), type, id);
  }
  @Patch('work-items/:type/:id')
  async update(
    @Req() request: Request,
    @Param('type', new SchemaPipe(workItemTypeSchema)) type: z.infer<typeof workItemTypeSchema>,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
    @Body(new SchemaPipe(update)) body: z.infer<typeof update>,
  ) {
    return this.items.update(
      await this.user(request),
      type,
      id,
      body.operationId,
      body.baseVersion,
      body.values,
    );
  }
  @Post('work-items/:type/:id/delete')
  async remove(
    @Req() request: Request,
    @Param('type', new SchemaPipe(workItemTypeSchema)) type: z.infer<typeof workItemTypeSchema>,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
    @Body(new SchemaPipe(mutationSchema)) body: z.infer<typeof mutationSchema>,
  ) {
    return this.items.remove(
      await this.user(request),
      type,
      id,
      body.operationId,
      body.baseVersion,
    );
  }
  @Post('work-items/:type/:id/restore')
  async restore(
    @Req() request: Request,
    @Param('type', new SchemaPipe(workItemTypeSchema)) type: z.infer<typeof workItemTypeSchema>,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
    @Body(new SchemaPipe(mutationSchema)) body: z.infer<typeof mutationSchema>,
  ) {
    return this.items.restore(
      await this.user(request),
      type,
      id,
      body.operationId,
      body.baseVersion,
    );
  }
}
