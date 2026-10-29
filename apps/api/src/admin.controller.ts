import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  adminCreateSchema,
  adminUpdateSchema,
  adminResetSchema,
  adminListSchema,
  adminLogSchema,
} from '@workbench/contracts';
import { AuthService, SESSION_COOKIE } from './auth.service';
import { AdminService } from './admin.service';
import { ApiException, SchemaPipe, type ApiRequest } from './http';
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AdminService) private readonly admin: AdminService,
  ) {}
  private async actor(req: ApiRequest) {
    const session = await this.auth.getSession(req.cookies?.[SESSION_COOKIE]);
    if (session.user.role !== 'admin')
      throw new ApiException('FORBIDDEN', '仅管理员可以管理账号', 403);
    return { id: session.user.id, requestId: req.requestId ?? 'unknown', ip: req.ip ?? 'unknown' };
  }
  @Get('accounts') async list(
    @Req() req: ApiRequest,
    @Query(new SchemaPipe(adminListSchema)) q: z.infer<typeof adminListSchema>,
  ) {
    return this.admin.list(await this.actor(req), q);
  }
  @Get('logs') async logs(
    @Req() req: ApiRequest,
    @Query(new SchemaPipe(adminLogSchema)) q: z.infer<typeof adminLogSchema>,
  ) {
    return this.admin.logs(await this.actor(req), q);
  }
  @Post('accounts') async create(
    @Req() req: ApiRequest,
    @Body(new SchemaPipe(adminCreateSchema)) body: z.infer<typeof adminCreateSchema>,
  ) {
    return this.admin.create(await this.actor(req), body);
  }
  @Post('accounts/:id/update') async update(
    @Req() req: ApiRequest,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
    @Body(new SchemaPipe(adminUpdateSchema)) body: z.infer<typeof adminUpdateSchema>,
  ) {
    return this.admin.change(await this.actor(req), id, 'update', body);
  }
  @Post('accounts/:id/password') async password(
    @Req() req: ApiRequest,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
    @Body(new SchemaPipe(adminResetSchema)) body: z.infer<typeof adminResetSchema>,
  ) {
    return this.admin.change(await this.actor(req), id, 'reset_password', body);
  }
  @Post('accounts/:id/:action') async state(
    @Req() req: ApiRequest,
    @Param('id', new SchemaPipe(z.uuid())) id: string,
    @Param('action', new SchemaPipe(z.enum(['disable', 'enable', 'delete', 'restore'])))
    action: 'disable' | 'enable' | 'delete' | 'restore',
    @Body(new SchemaPipe(z.object({}).strict())) _body: Record<string, never>,
  ) {
    void _body;
    return this.admin.change(await this.actor(req), id, action);
  }
}
