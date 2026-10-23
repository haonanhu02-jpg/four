import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  dataClearSchema,
  dataCommitSchema,
  dataPreviewSchema,
  pageSchema,
} from '@workbench/contracts';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { ApiException, SchemaPipe } from './http';
import { DataService } from './data.service';
@Controller('data')
export class DataController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(DataService) private readonly data: DataService,
  ) {}
  private async user(req: Request) {
    const id = (await this.auth.getSession(req.cookies?.[SESSION_COOKIE])).user.id;
    const expected = req.get('X-Workbench-Account');
    if (expected && expected !== id)
      throw new ApiException('FORBIDDEN', '浏览器账号已切换，请重新打开工作台', 403);
    return id;
  }
  @Get('export') async export(@Req() req: Request) {
    return this.data.export(await this.user(req));
  }
  @Get('cache') async cache(@Req() req: Request) {
    return this.data.cache(await this.user(req));
  }
  @Get('state') async state(@Req() req: Request) {
    return this.data.state(await this.user(req));
  }
  @Get('sample') async sample(@Req() req: Request) {
    return this.data.sample(await this.user(req));
  }
  @Post('preview') async preview(
    @Req() req: Request,
    @Body(new SchemaPipe(dataPreviewSchema)) body: z.infer<typeof dataPreviewSchema>,
  ) {
    return this.data.preview(await this.user(req), body.document, body.mode);
  }
  @Post('commit') async commit(
    @Req() req: Request,
    @Body(new SchemaPipe(dataCommitSchema)) body: z.infer<typeof dataCommitSchema>,
  ) {
    return this.data.commit(await this.user(req), body.previewId, body.operationId);
  }
  @Post('clear') async clear(
    @Req() req: Request,
    @Body(new SchemaPipe(dataClearSchema)) body: z.infer<typeof dataClearSchema>,
  ) {
    return this.data.clear(await this.user(req), body.revision, body.operationId);
  }
  @Get('backups') async backups(
    @Req() req: Request,
    @Query(new SchemaPipe(pageSchema)) q: z.infer<typeof pageSchema>,
  ) {
    return this.data.backups(await this.user(req), q);
  }
  @Post('backups/:id/preview') async restore(
    @Req() req: Request,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
  ) {
    return this.data.restorePreview(await this.user(req), id);
  }
}
