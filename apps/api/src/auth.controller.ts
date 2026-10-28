import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { passwordLoginSchema, registerSchema } from '@workbench/contracts';
import type { AuthResponse, PasswordLoginInput, RegisterInput } from '@workbench/contracts';
import type { Request, Response } from 'express';
import { AppConfig } from './config';
import { AuthService, CreatedSession, SESSION_COOKIE } from './auth.service';
import { SchemaPipe } from './http';
import { DatabaseService } from './database.service';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private respond(session: CreatedSession, response: Response): AuthResponse {
    response.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/api',
      expires: new Date(session.response.sessionExpiresAt),
    });
    return session.response;
  }

  @Post('register')
  async register(
    @Body(new SchemaPipe(registerSchema)) input: RegisterInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    return this.respond(await this.auth.register(input, request.ip ?? 'unknown'), response);
  }

  @Post('login')
  async login(
    @Body(new SchemaPipe(passwordLoginSchema)) input: PasswordLoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    return this.respond(await this.auth.passwordLogin(input, request.ip ?? 'unknown'), response);
  }

  @Post('logout')
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(request.cookies?.[SESSION_COOKIE]);
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/api',
    });
    return { message: '已退出登录' };
  }

  @Get('me')
  async me(@Req() request: Request): Promise<AuthResponse> {
    const session = await this.auth.getSession(request.cookies?.[SESSION_COOKIE]);
    const state = await this.database.pool.query(
      'SELECT cache_generation FROM deployment_state WHERE singleton',
    );
    return {
      user: session.user,
      sessionExpiresAt: session.sessionExpiresAt,
      cacheGeneration: state.rows[0].cache_generation,
    };
  }
}
