import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv, type AppConfig } from '@wai/config';
import { parseTraceparent, type WaiLogger } from '@wai/observability';
import { closeApiApp, createApiApp } from './app.js';
import { SAFETY_BLOCK_DECISION } from '@wai/contracts';
import type { InfraOverrides } from './infra/infra.module.js';
import type {
  CacheAdapter,
  DatabaseAdapter,
  QueueEnqueueOptions,
  QueueProducerAdapter,
} from './infra/adapters.js';

const TEST_REQUEST_ID = 'f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// R1-02 review sentinels: any log line carrying these raw values fails.
const SENTINEL_TOKEN = 'fake-review-token';
const SENTINEL_EMAIL = 'review-user@example.invalid';
// Production config validation rejects the development default credentials,
// so the production-mode tests supply explicit non-default URLs and IAM
// secrets (never used — adapters are faked, only config parsing is exercised).
const PROD_TEST_ENV = {
  DATABASE_URL: 'postgres://wai_prod:wai_prod_pg_6k2m@db.internal:5432/wai_prod',
  VALKEY_URL: 'redis://:wai_prod_valkey_5h7d@valkey.internal:6379',
  IAM_COOKIE_SECURE: 'true',
  IAM_SECRET_PEPPER: 'wai-prod-iam-pepper-6k2m-9f4c-2d8a-7b3e-1c5f-0a2d-4e8b',
  IAM_PII_KEYS: '{"prod-key":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}',
  // The eligibility module builds its birthday cipher from the active key
  // id — the production keyring above must match it.
  IAM_PII_KEY_ID: 'prod-key',
};

class FakeDbAdapter implements DatabaseAdapter {
  up = true;
  closeCalls = 0;
  async ping(): Promise<boolean> {
    return this.up;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeCacheAdapter implements CacheAdapter {
  up = true;
  closeCalls = 0;
  async ping(): Promise<boolean> {
    return this.up;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeQueueAdapter implements QueueProducerAdapter {
  up = true;
  closeCalls = 0;
  jobs: Array<{ name: string; data: unknown; options: QueueEnqueueOptions }> = [];

  async enqueue(name: string, data: unknown, options: QueueEnqueueOptions): Promise<void> {
    if (!this.up) {
      throw new Error('queue down');
    }
    this.jobs.push({ name, data, options });
  }

  async check(): Promise<boolean> {
    return this.up;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const silentLogger: WaiLogger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

interface CapturedLogCall {
  obj: Record<string, unknown>;
  msg: string | undefined;
}

/** Records every logger call so tests can assert on what was (not) logged. */
function capturingLogger(): { logger: WaiLogger; calls: CapturedLogCall[] } {
  const calls: CapturedLogCall[] = [];
  const logger = {} as WaiLogger;
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    logger[level] = ((obj: Record<string, unknown>, msg?: string): void => {
      calls.push({ obj, msg });
    }) as WaiLogger[typeof level];
  }
  logger.child = () => logger;
  return { logger, calls };
}

function testConfig(extra: NodeJS.ProcessEnv = {}): AppConfig {
  return loadEnv({ NODE_ENV: 'test', LOG_PRETTY: 'false', ...extra });
}

interface TestContext {
  app: NestFastifyApplication;
  fastify: FastifyInstance;
  queue: FakeQueueAdapter;
  db: FakeDbAdapter;
  cache: FakeCacheAdapter;
}

const contexts: TestContext[] = [];

async function createTestApp(
  configOverrides: NodeJS.ProcessEnv = {},
  overrides: { rateLimiter?: InfraOverrides['rateLimiter'] } = {},
): Promise<TestContext> {
  const db = new FakeDbAdapter();
  const cache = new FakeCacheAdapter();
  const queue = new FakeQueueAdapter();
  const app = await createApiApp(testConfig(configOverrides), {
    logger: silentLogger,
    dbAdapter: db,
    cacheAdapter: cache,
    queueAdapter: queue,
    ...(overrides.rateLimiter === undefined ? {} : { rateLimiter: overrides.rateLimiter }),
  });
  const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
  const context = { app, fastify, queue, db, cache };
  contexts.push(context);
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    await context?.app.close();
  }
});

describe('GET /v1/health/live', () => {
  it('returns 200 alive with a generated x-request-id header', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({ method: 'GET', url: '/v1/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toMatch(UUID_V4);
    const body = response.json();
    expect(body.status).toBe('alive');
    expect(typeof body.timestamp).toBe('string');
  });

  it('echoes a client-supplied x-request-id', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({
      method: 'GET',
      url: '/v1/health/live',
      headers: { 'x-request-id': TEST_REQUEST_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe(TEST_REQUEST_ID);
  });
});

describe('cross-module safety DI', () => {
  it('resolves the canonical contracts safety decision token', async () => {
    const { app } = await createTestApp();
    expect(app.get(SAFETY_BLOCK_DECISION)).toBeTruthy();
  });
});

describe('application lifecycle', () => {
  it('closes each infrastructure adapter token exactly once', async () => {
    const db = new FakeDbAdapter();
    const cache = new FakeCacheAdapter();
    const foundation = new FakeQueueAdapter();
    const media = new FakeQueueAdapter();
    const privateDelivery = new FakeQueueAdapter();
    const translation = new FakeQueueAdapter();
    const app = await createApiApp(testConfig(), {
      logger: silentLogger,
      dbAdapter: db,
      cacheAdapter: cache,
      queueAdapter: foundation,
      mediaQueueAdapter: media,
      privateDeliveryQueueAdapter: privateDelivery,
      translationQueueAdapter: translation,
    });

    await closeApiApp(app);

    expect(db.closeCalls).toBe(1);
    expect(cache.closeCalls).toBe(1);
    expect(foundation.closeCalls).toBe(1);
    expect(media.closeCalls).toBe(1);
    expect(privateDelivery.closeCalls).toBe(1);
    expect(translation.closeCalls).toBe(1);
  });
});

describe('request logging (R1-02 regression)', () => {
  it('logs only the normalized route — raw query strings never reach logs', async () => {
    const captured = capturingLogger();
    const db = new FakeDbAdapter();
    const cache = new FakeCacheAdapter();
    const queue = new FakeQueueAdapter();
    const app = await createApiApp(testConfig(), {
      logger: captured.logger,
      dbAdapter: db,
      cacheAdapter: cache,
      queueAdapter: queue,
    });
    const fastify = app.getHttpAdapter().getInstance() as FastifyInstance;
    contexts.push({ app, fastify, queue, db, cache });

    const response = await fastify.inject({
      method: 'GET',
      url: `/v1/health/live?token=${SENTINEL_TOKEN}&email=${SENTINEL_EMAIL}`,
    });
    expect(response.statusCode).toBe(200);

    const completed = captured.calls.filter(
      (call) => call.obj['event'] === 'http.request.completed',
    );
    expect(completed.length).toBeGreaterThan(0);
    for (const call of completed) {
      // Route template only — never the raw URL with its query string.
      expect(call.obj['route']).toBe('/v1/health/live');
      // Whole-call containment: no field may carry the raw sentinels.
      expect(JSON.stringify(call)).not.toContain(SENTINEL_TOKEN);
      expect(JSON.stringify(call)).not.toContain(SENTINEL_EMAIL);
    }
  });
});

describe('GET /v1/health/ready', () => {
  it('reports ready when every dependency is up', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: { postgres: 'up', valkey: 'up', queue: 'up' },
    });
  });

  it('reports degraded with per-dependency state when something is down', async () => {
    const context = await createTestApp();
    context.db.up = false;
    context.cache.up = false;
    context.queue.up = false;
    const response = await context.fastify.inject({ method: 'GET', url: '/v1/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      checks: { postgres: 'down', valkey: 'down', queue: 'down' },
    });
  });

  it('never leaks connection details in the DTO', async () => {
    const context = await createTestApp();
    context.db.up = false;
    const response = await context.fastify.inject({ method: 'GET', url: '/v1/health/ready' });
    const raw = response.body;
    expect(raw).not.toMatch(/postgres:\/\//);
    expect(raw).not.toMatch(/wai_dev/);
    expect(raw).not.toMatch(/127\.0\.0\.1:5433/);
  });
});

describe('error envelope', () => {
  it('returns a NOT_FOUND envelope for unknown routes with the request id', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({
      method: 'GET',
      url: '/v1/does-not-exist',
      headers: { 'x-request-id': TEST_REQUEST_ID },
    });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body).toEqual({
      code: 'NOT_FOUND',
      message: expect.any(String),
      request_id: TEST_REQUEST_ID,
    });
    expect(response.headers['x-request-id']).toBe(TEST_REQUEST_ID);
  });

  it('rejects an invalid x-request-id header with 400 BAD_REQUEST', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({
      method: 'GET',
      url: '/v1/health/live',
      headers: { 'x-request-id': 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('BAD_REQUEST');
  });
});

describe('POST /v1/foundation/trace', () => {
  it('enqueues a job whose envelope carries the same request id and a valid traceparent', async () => {
    const { fastify, queue } = await createTestApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/foundation/trace',
      headers: {
        'x-request-id': TEST_REQUEST_ID,
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
      payload: { message: 'smoke' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.status).toBe('accepted');
    expect(body.request_id).toBe(TEST_REQUEST_ID);
    expect(body.job_id).toBe(body.event_id);
    expect(body.schema_version).toBe('1.0.0');

    expect(queue.jobs).toHaveLength(1);
    const job = queue.jobs[0];
    expect(job?.name).toBe('foundation.trace');
    const envelope = job?.data as {
      event_id: string;
      request_id: string;
      traceparent?: string;
      schema_version: string;
      occurred_at: string;
      payload: unknown;
    };
    expect(envelope.request_id).toBe(TEST_REQUEST_ID);
    expect(envelope.event_id).toBe(body.event_id);
    expect(envelope.schema_version).toBe('1.0.0');
    expect(envelope.payload).toEqual({ message: 'smoke' });
    expect(parseTraceparent(envelope.traceparent)).not.toBeNull();
    expect(parseTraceparent(envelope.traceparent)?.traceId).toBe(
      '4bf92f3577b34da6a3ce929d0e0e4736',
    );
    // Queue-level dedup key: BullMQ jobId must equal the event id.
    expect(job?.options.jobId).toBe(body.event_id);
  });

  it('generates a fresh request id and traceparent when the client sends none', async () => {
    const { fastify, queue } = await createTestApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/foundation/trace',
      payload: {},
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.request_id).toMatch(UUID_V4);
    expect(response.headers['x-request-id']).toBe(body.request_id);
    const envelope = queue.jobs[0]?.data as { traceparent?: string };
    expect(parseTraceparent(envelope.traceparent)).not.toBeNull();
  });

  it('rejects invalid payloads with 400 VALIDATION_ERROR and details', async () => {
    const { fastify, queue } = await createTestApp();
    const longMessage = await fastify.inject({
      method: 'POST',
      url: '/v1/foundation/trace',
      payload: { message: 'a'.repeat(501) },
    });
    expect(longMessage.statusCode).toBe(400);
    const longBody = longMessage.json();
    expect(longBody.code).toBe('VALIDATION_ERROR');
    expect(longBody.request_id).toMatch(UUID_V4);
    expect(Array.isArray(longBody.details)).toBe(true);

    const unknownKey = await fastify.inject({
      method: 'POST',
      url: '/v1/foundation/trace',
      payload: { business_field: 'not allowed' },
    });
    expect(unknownKey.statusCode).toBe(400);
    expect(unknownKey.json().code).toBe('VALIDATION_ERROR');

    expect(queue.jobs).toHaveLength(0);
  });

  it('returns 503 QUEUE_UNAVAILABLE when the queue rejects the job', async () => {
    const context = await createTestApp();
    context.queue.up = false;
    const response = await context.fastify.inject({
      method: 'POST',
      url: '/v1/foundation/trace',
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('QUEUE_UNAVAILABLE');
  });
});

describe('OpenAPI gating', () => {
  it('serves the generated document outside production', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({ method: 'GET', url: '/v1/docs' });
    expect(response.statusCode).toBe(200);
    const document = response.json() as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe('3.0.3');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/v1/health/live', '/v1/health/ready', '/v1/foundation/trace']),
    );
  });

  it('is disabled by default in production', async () => {
    const { fastify } = await createTestApp({
      NODE_ENV: 'production',
      ENABLE_OPENAPI: 'false',
      ...PROD_TEST_ENV,
    });
    const response = await fastify.inject({ method: 'GET', url: '/v1/docs' });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('NOT_FOUND');
  });

  it('is enabled in production only with the explicit switch', async () => {
    const { fastify } = await createTestApp({
      NODE_ENV: 'production',
      ENABLE_OPENAPI: 'true',
      ...PROD_TEST_ENV,
    });
    const response = await fastify.inject({ method: 'GET', url: '/v1/docs' });
    expect(response.statusCode).toBe(200);
  });
});

describe('IAM fast-fail paths (task book §7)', () => {
  it('rejects non-JSON content types on account routes with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/account/sessions',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-request-id': TEST_REQUEST_ID,
      },
      payload: 'email=someone%40example.com&password=not-a-secret',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: expect.any(String),
      request_id: TEST_REQUEST_ID,
    });
    expect(response.headers['x-request-id']).toBe(TEST_REQUEST_ID);
  });

  it('rate-limits account sessions by IP with a 429 RATE_LIMITED envelope', async () => {
    // Without a cache client the IAM RateLimiter is fail-closed (DenyRateLimiter)
    // and every login would 429 on the email domain before reaching the IP
    // check — override it so this test isolates the Fastify IP limit.
    const { fastify } = await createTestApp(
      {
        IAM_RATE_LIMIT_IP_SESSIONS_MAX: '3',
        IAM_RATE_LIMIT_IP_WINDOW_SECONDS: '300',
      },
      {
        rateLimiter: {
          async consume(): Promise<{ allowed: true }> {
            return { allowed: true };
          },
        },
      },
    );
    for (let i = 0; i < 3; i += 1) {
      const response = await fastify.inject({
        method: 'POST',
        url: '/v1/account/sessions',
        headers: { 'content-type': 'application/json', 'x-request-id': TEST_REQUEST_ID },
        payload: { email: 'someone@example.com', password: 'not-a-secret' },
      });
      expect(response.statusCode).not.toBe(429);
    }
    const response = await fastify.inject({
      method: 'POST',
      url: '/v1/account/sessions',
      headers: { 'content-type': 'application/json', 'x-request-id': TEST_REQUEST_ID },
      payload: { email: 'someone@example.com', password: 'not-a-secret' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({
      code: 'RATE_LIMITED',
      message: expect.any(String),
      request_id: TEST_REQUEST_ID,
    });
    expect(response.headers['retry-after']).toBeDefined();
    expect(response.headers['x-request-id']).toBe(TEST_REQUEST_ID);
  });
});

describe('CORS and security headers', () => {
  it('sends Helmet headers', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({ method: 'GET', url: '/v1/health/live' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('allows configured origins in development', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({
      method: 'OPTIONS',
      url: '/v1/foundation/trace',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,idempotency-key,if-match',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-methods']).toContain('GET');
    expect(response.headers['access-control-allow-methods']).toContain('HEAD');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
    expect(response.headers['access-control-allow-methods']).toContain('PATCH');
    expect(response.headers['access-control-allow-methods']).toContain('DELETE');
    expect(response.headers['access-control-allow-methods']).toContain('OPTIONS');
    expect(response.headers['access-control-allow-headers']).toContain('if-match');
  });

  it('does not grant credentials to an unconfigured origin', async () => {
    const { fastify } = await createTestApp();
    const response = await fastify.inject({
      method: 'OPTIONS',
      url: '/v1/onboarding/state?purpose=discovery',
      headers: {
        origin: 'https://not-allowed.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    // `credentials: true` is an application-wide CORS option, but without an
    // allow-origin echo the browser cannot expose a credentialed response.
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});
