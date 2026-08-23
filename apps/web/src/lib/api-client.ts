import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import {
  errorEnvelopeSchema,
  foundationTraceResponseSchema,
  healthReadyResponseSchema,
  type ErrorEnvelope,
  type FoundationTraceResponse,
  type HealthReadyResponse,
} from '@wai/contracts';
import { createTraceparent, parseTraceparent } from '@wai/observability';
import { getWebApiBaseUrl } from './web-api-base';

/**
 * Minimal typed client for the FND-01 API surface. Every response body is
 * parsed against the shared @wai/contracts schemas — an unexpected shape
 * fails loudly instead of being rendered.
 */

export interface ApiCallResult<T> {
  status: number;
  body: T;
  /** The request id echoed by the API (same value we sent). */
  requestId: string;
  /** Trace id derived from the traceparent sent with the request. */
  traceId: string;
}

export interface ApiErrorResult {
  status: number;
  envelope: ErrorEnvelope | null;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly envelope: ErrorEnvelope | null;

  constructor(status: number, envelope: ErrorEnvelope | null, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.envelope = envelope;
  }
}

export function getApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return getWebApiBaseUrl(env);
}

/** Fresh UUID v4 request id — the Web side of the Request ID vertical chain. */
export function makeRequestId(): string {
  return randomUUID();
}

export function makeTraceparent(): string {
  return createTraceparent();
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  requestId: string;
  traceparent: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

async function rawRequest(options: RequestOptions): Promise<Response> {
  const base = options.baseUrl ?? getApiBaseUrl();
  const headers: Record<string, string> = {
    'x-request-id': options.requestId,
    // W3C trace context header (standard name, read by the API interceptor).
    traceparent: options.traceparent,
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await (options.fetchImpl ?? fetch)(`${base}${options.path}`, {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return response;
}

async function parseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function request<T>(options: RequestOptions, schema: ZodType<T>): Promise<ApiCallResult<T>> {
  const response = await rawRequest(options);
  const raw = await parseBody(response);

  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(raw);
    if (envelope.success) {
      throw new ApiClientError(
        response.status,
        envelope.data,
        `${envelope.data.code}: ${envelope.data.message}`,
      );
    }
    throw new ApiClientError(
      response.status,
      null,
      `API returned ${response.status} with an unrecognized error body`,
    );
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`API response for ${options.path} did not match the expected contract`);
  }
  const parsedTraceparent = parseTraceparent(options.traceparent);
  return {
    status: response.status,
    body: parsed.data,
    requestId: options.requestId,
    traceId: parsedTraceparent?.traceId ?? '',
  };
}

export interface HealthReadyCall {
  requestId: string;
  traceparent: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function getHealthReady(
  options: HealthReadyCall,
): Promise<ApiCallResult<HealthReadyResponse>> {
  return request(
    {
      method: 'GET',
      path: '/health/ready',
      requestId: options.requestId,
      traceparent: options.traceparent,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    },
    healthReadyResponseSchema,
  );
}

export interface TraceCall {
  message?: string;
  requestId: string;
  traceparent: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function postFoundationTrace(
  options: TraceCall,
): Promise<ApiCallResult<FoundationTraceResponse>> {
  return request(
    {
      method: 'POST',
      path: '/foundation/trace',
      requestId: options.requestId,
      traceparent: options.traceparent,
      ...(options.message === undefined ? {} : { body: { message: options.message } }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    },
    foundationTraceResponseSchema,
  );
}
