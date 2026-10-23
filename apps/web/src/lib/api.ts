import type { ApiErrorCode, ApiErrorResponse } from '@workbench/contracts';

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | 'NETWORK_ERROR',
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export async function request<T>(
  url: string,
  body?: unknown,
  options: { method?: 'POST' | 'PATCH'; headers?: Record<string, string> } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : (options.method ?? 'POST'),
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const error = (payload as Partial<ApiErrorResponse> | null)?.error;
      const retryHeader = Number(response.headers.get('Retry-After'));
      throw new ApiClientError(
        response.status,
        error?.code ?? (response.status === 401 ? 'UNAUTHENTICATED' : 'SERVICE_UNAVAILABLE'),
        error?.message ?? '服务暂时不可用，请稍后重试。',
        error?.requestId,
        error?.details,
        Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined,
      );
    }

    if (payload === null) {
      throw new ApiClientError(response.status, 'SERVICE_UNAVAILABLE', '服务返回异常，请重试。');
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? '请求超时，请检查网络后重试。'
        : '暂时无法连接服务，请检查网络后重试。';
    throw new ApiClientError(0, 'NETWORK_ERROR', message);
  } finally {
    window.clearTimeout(timeout);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}
