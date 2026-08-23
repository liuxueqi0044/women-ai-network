import { getWebApiBaseUrl } from './web-api-base';

export class MemberApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MemberApiError';
  }
}

type RequestOptions = {
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

function errorDetails(value: unknown): { code: string; message: string } {
  if (typeof value !== 'object' || value === null) {
    return { code: 'REQUEST_FAILED', message: 'The request could not be completed.' };
  }
  const record = value as Record<string, unknown>;
  return {
    code: typeof record['code'] === 'string' ? record['code'] : 'REQUEST_FAILED',
    message:
      typeof record['message'] === 'string'
        ? record['message']
        : 'The request could not be completed.',
  };
}

export function makeIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return `${cryptoApi.randomUUID()}-${cryptoApi.randomUUID()}`;
  if (!cryptoApi?.getRandomValues) throw new Error('Secure randomness is unavailable.');
  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function memberApi<T>(
  path: `/${string}`,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  if (options.body !== undefined) headers.set('content-type', 'application/json');

  const init: RequestInit = {
    method,
    credentials: 'include',
    headers,
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal !== undefined) init.signal = options.signal;
  const response = await (options.fetchImpl ?? fetch)(`${getWebApiBaseUrl()}${path}`, init);

  const value = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorDetails(value);
    throw new MemberApiError(response.status, error.code, error.message);
  }
  return value as T;
}

export function describeMemberApiError(error: unknown): string {
  if (error instanceof MemberApiError) {
    if (error.status === 401) return 'Please sign in to continue.';
    if (error.status === 403) return 'This action is not available for your account right now.';
    if (error.status === 409) return 'This changed elsewhere. Refresh and try again.';
    if (error.status === 429) return 'Too many requests. Please wait a moment and try again.';
    return error.message;
  }
  if (error instanceof TypeError) {
    return 'The service is temporarily unavailable. Please try again when the API is connected.';
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
