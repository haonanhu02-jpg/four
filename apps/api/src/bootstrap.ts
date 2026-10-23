import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Response } from 'express';
import { json } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { AppConfig } from './config';
import { ApiException, ApiExceptionFilter, ApiRequest } from './http';

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const config = app.get(AppConfig);
  app.disable('x-powered-by');
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  app.use('/api/data', json({ limit: '6mb' }));
  app.useBodyParser('json', { limit: '32kb' });
  app.use(helmet());
  app.use(cookieParser());
  app.use((request: ApiRequest, response: Response, next: NextFunction) => {
    const supplied = request.get('X-Request-Id');
    request.requestId = supplied && /^[\w-]{1,64}$/.test(supplied) ? supplied : randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    response.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.get('Origin');
      if (
        (origin && origin !== config.appOrigin) ||
        request.get('Sec-Fetch-Site') === 'cross-site'
      ) {
        // Middleware exceptions do not pass through Nest route exception filters.
        const error = new ApiException('FORBIDDEN', '请求来源不被允许', 403);
        response.status(403).json({
          error: { code: error.code, message: error.message, requestId: request.requestId },
        });
        return;
      }
    }
    next();
  });
  app.enableCors({ origin: config.appOrigin, credentials: true });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
