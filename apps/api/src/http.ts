import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import type { ApiErrorCode, ApiErrorResponse } from '@workbench/contracts';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';

export type ApiRequest = Request & { requestId?: string };

export class ApiException extends HttpException {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    status: number,
    readonly details?: unknown,
  ) {
    super(message, status);
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<ApiRequest>();
    const response = context.getResponse<Response>();
    const requestId = request.requestId ?? randomUUID();
    let status = 500;
    let code: ApiErrorCode = 'INTERNAL_ERROR';
    let message = '服务暂时无法完成请求，请稍后重试';
    let details: unknown;
    if (exception instanceof ApiException) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const errors: Record<number, { code: ApiErrorCode; message: string }> = {
        400: { code: 'VALIDATION_ERROR', message: '请求内容无效，请检查 JSON 和输入字段' },
        401: { code: 'UNAUTHENTICATED', message: '请先登录' },
        403: { code: 'FORBIDDEN', message: '无权执行此操作' },
        404: { code: 'NOT_FOUND', message: '接口不存在' },
        413: { code: 'VALIDATION_ERROR', message: '请求内容过大' },
        422: { code: 'VALIDATION_ERROR', message: '请检查输入内容' },
        429: { code: 'RATE_LIMITED', message: '操作过于频繁，请稍后再试' },
        503: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' },
      };
      const mapped = errors[status];
      code = mapped?.code ?? 'INTERNAL_ERROR';
      message = mapped?.message ?? '请求无法处理';
    } else if (
      exception instanceof Error &&
      'type' in exception &&
      (exception.type === 'entity.parse.failed' || exception.type === 'entity.too.large')
    ) {
      status = exception.type === 'entity.too.large' ? 413 : 400;
      code = 'VALIDATION_ERROR';
      message = status === 413 ? '请求内容过大' : '请求需要有效的 JSON';
    }
    if (status >= 500) {
      // Log only the category and request ID: never the request body, credentials, or SQL values.
      console.error(
        `API error ${requestId}: ${exception instanceof Error ? exception.name : 'unknown'}`,
      );
    }
    const body: ApiErrorResponse = { error: { code, message, requestId } };
    if (details !== undefined) body.error.details = details;
    response.setHeader('X-Request-Id', requestId);
    if (
      code === 'RATE_LIMITED' &&
      typeof details === 'object' &&
      details !== null &&
      'retryAfterSeconds' in details
    ) {
      response.setHeader('Retry-After', String(details.retryAfterSeconds));
    }
    response.status(status).json(body);
  }
}

@Injectable()
export class SchemaPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiException('VALIDATION_ERROR', '请检查输入内容', 400, {
        fields: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
