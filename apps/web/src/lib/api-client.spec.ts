import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEventId, makeRequestId, makeTraceparent } from '@wai/testkit';
import {
  ApiClientError,
  getApiBaseUrl,
  getHealthReady,
  makeRequestId as clientMakeRequestId,
  postFoundationTrace,
} from './api-client.js';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
afterEach(() => {
  fetchMock.mockReset();
});

describe('api-client', () => {
  it('parses the foundation trace response and propagates x-request-id + x-traceparent', async () => {
    const requestId = makeRequestId();
    const traceparent = makeTraceparent();
    const eventId = makeEventId();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        201,
        {
          status: 'accepted',
          event_id: eventId,
          job_id: eventId,
          request_id: requestId,
          accepted_at: new Date().toISOString(),
          schema_version: '1.0.0',
        },
        { 'x-request-id': requestId },
      ),
    );

    const result = await postFoundationTrace({
      message: 'hello from the unit test',
      requestId,
      traceparent,
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUrl: 'http://api.test',
    });

    expect(result.status).toBe(201);
    expect(result.body.event_id).toBe(eventId);
    expect(result.requestId).toBe(requestId);
    expect(result.traceId).toBe(traceparent.split('-')[1]);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-request-id')).toBe(requestId);
    expect(new Headers(init?.headers).get('traceparent')).toBe(traceparent);
    expect(JSON.parse(String(init?.body))).toEqual({ message: 'hello from the unit test' });
  });

  it('parses the ready response', async () => {
    const requestId = makeRequestId();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        status: 'ready',
        checks: { postgres: 'up', valkey: 'up', queue: 'up' },
        timestamp: new Date().toISOString(),
      }),
    );

    const result = await getHealthReady({
      requestId,
      traceparent: makeTraceparent(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUrl: 'http://api.test',
    });

    expect(result.status).toBe(200);
    expect(result.body.status).toBe('ready');
    expect(result.body.checks.postgres).toBe('up');
  });

  it('throws ApiClientError carrying the parsed error envelope on failures', async () => {
    const requestId = makeRequestId();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        code: 'VALIDATION_ERROR',
        message: 'message must be a string',
        details: ['message: Expected string, received number'],
        request_id: requestId,
      }),
    );

    const attempt = postFoundationTrace({
      requestId,
      traceparent: makeTraceparent(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUrl: 'http://api.test',
    });
    await expect(attempt).rejects.toBeInstanceOf(ApiClientError);
    await attempt.catch((error: unknown) => {
      const apiError = error as ApiClientError;
      expect(apiError.status).toBe(400);
      expect(apiError.envelope?.code).toBe('VALIDATION_ERROR');
      expect(apiError.envelope?.request_id).toBe(requestId);
      expect(apiError.message).toContain('VALIDATION_ERROR');
    });
  });

  it('throws a generic ApiClientError when the error body is not an envelope', async () => {
    fetchMock.mockResolvedValueOnce(new Response('gateway exploded', { status: 502 }));

    const attempt = getHealthReady({
      requestId: makeRequestId(),
      traceparent: makeTraceparent(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUrl: 'http://api.test',
    });
    await expect(attempt).rejects.toBeInstanceOf(ApiClientError);
    await attempt.catch((error: unknown) => {
      expect((error as ApiClientError).envelope).toBeNull();
    });
  });

  it('fails loudly when a 2xx body does not match the contract', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: 'who-knows' }));

    await expect(
      getHealthReady({
        requestId: makeRequestId(),
        traceparent: makeTraceparent(),
        fetchImpl: fetchMock as unknown as typeof fetch,
        baseUrl: 'http://api.test',
      }),
    ).rejects.toThrow(/contract/);
  });

  it('generates valid request ids and resolves the shared versioned base URL', () => {
    expect(clientMakeRequestId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      getApiBaseUrl({
        NODE_ENV: 'test',
        NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3100/v1',
      }),
    ).toBe('http://127.0.0.1:3100/v1');
  });
});
