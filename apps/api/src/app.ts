import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyRequest, RouteOptions } from 'fastify';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@wai/config';
import { requestIdSchema, type ErrorCode } from '@wai/contracts';
import { AppModule, type ApiAppOverrides } from './app.module.js';
import { loadOpaConfig, type OpaConfig } from './eligibility/infra/opa-config.js';
import { buildValkeyClientOptions } from './infra/infra.module.js';
import {
  MEDIA_QUEUE_ADAPTER,
  PRIVATE_DELIVERY_QUEUE_ADAPTER,
  TRANSLATION_QUEUE_ADAPTER,
  NOTIFICATION_QUEUE_ADAPTER,
} from './tokens.js';

export const API_BODY_LIMIT_BYTES = 1_048_576; // 1 MiB

/**
 * IAM-01: per-route IP rate limits (plan D9, task book §7). More specific
 * prefixes must come first — find() takes the first match, and
 * /v1/account/sessions/mfa must use the MFA limit, not the login limit.
 */
function accountIpLimits(config: AppConfig): ReadonlyArray<{ prefix: string; max: number }> {
  const rl = config.iam.rateLimit;
  return [
    { prefix: '/v1/account/sessions/mfa', max: rl.ipMfaMax },
    { prefix: '/v1/account/mfa', max: rl.ipMfaMax },
    { prefix: '/v1/account/registrations', max: rl.ipRegistrationsMax },
    { prefix: '/v1/account/sessions', max: rl.ipSessionsMax },
  ];
}

/** Accepted client-supplied x-request-id or a fresh one (same rule as the exception filter). */
function requestIdFor(request: FastifyRequest): string {
  const raw = request.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && requestIdSchema.safeParse(value).success) {
    return value;
  }
  return randomUUID();
}

/**
 * Task book §7: login/registration accept JSON only. Route-level guard so
 * body-less routes (GET/HEAD) stay usable; a request that declares a
 * non-JSON content type is rejected before parsing. Throws the plain-object
 * envelope — the GlobalExceptionFilter recognizes it via Nest's
 * exception-layer proxy and answers 415.
 */
async function jsonContentTypeGuard(request: FastifyRequest): Promise<void> {
  const raw = request.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return;
  }
  const mediaType = value.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw {
      statusCode: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE' as ErrorCode,
      message: 'Content-Type must be application/json',
      request_id: requestIdFor(request),
    };
  }
}

/**
 * Creates a configured (not yet listening) API application.
 * `await app.listen(...)` starts it; `app.getHttpAdapter().getInstance()`
 * exposes the Fastify instance for `inject`-based tests.
 *
 * The OPA config is parsed at this env boundary (documented in
 * opa-config.ts: packages/config is outside the ELG-01 allow-list, so OPA
 * settings live here and are injected into the module).
 */
export async function createApiApp(
  config: AppConfig,
  overrides: ApiAppOverrides = {},
  opaConfig: OpaConfig = loadOpaConfig(process.env),
): Promise<NestFastifyApplication> {
  // One shared ioredis client for the cache adapter, the IAM rate limiter
  // and the HTTP rate-limit plugin. When the cache adapter is faked (test
  // apps) no client is created and the IAM slice falls back to the
  // fail-closed DenyRateLimiter.
  const cacheClient =
    overrides.cacheClient ??
    (overrides.cacheAdapter === undefined
      ? new Redis(buildValkeyClientOptions(config))
      : undefined);

  // The HTTP rate-limit plugin and ValkeyRateLimiter send commands at the
  // FIRST request. With enableOfflineQueue: false a command issued while the
  // client is still connecting throws instead of queuing — an app that
  // cannot rate-limit its account routes must not serve them, so boot waits
  // for readiness (bounded; the health endpoint keeps reporting the
  // dependency state at runtime).
  if (cacheClient !== undefined) {
    await waitForValkeyReady(cacheClient);
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(
      config,
      cacheClient === undefined ? overrides : { ...overrides, cacheClient },
      opaConfig,
    ),
    // No Fastify `disableRequestLogging` option: it is deprecated (Fastify 6
    // removes it) and emits a startup warning. Request logging is driven by
    // our own RequestContextInterceptor with normalized routes, and Fastify
    // only logs requests when it is given its own logger — which it is not.
    new FastifyAdapter({ bodyLimit: API_BODY_LIMIT_BYTES }),
    // Never core-dump on an init error: reject instead, so main.ts can log
    // and exit non-zero cleanly (and tests can see the actual error).
    { logger: false, abortOnError: false, rawBody: true },
  );

  app.setGlobalPrefix('v1');

  const fastify = app.getHttpAdapter().getInstance();

  // NOTE: no custom fastify.setErrorHandler here — Nest core replaces it at
  // app.init() with its exception-layer proxy, which forwards everything to
  // the GlobalExceptionFilter. Hook-thrown plain-object envelopes (rate-limit
  // 429, content-type 415) are recognized and mapped there.

  // Per-route IAM security config. This hook must be registered before
  // @fastify/rate-limit loads: its own onRoute hook reads
  // `routeOptions.config.rateLimit` when each route is registered, and
  // onRoute hooks run in registration order.
  fastify.addHook('onRoute', (routeOptions: RouteOptions) => {
    const url = typeof routeOptions.url === 'string' ? routeOptions.url : '';
    const limit = accountIpLimits(config).find((entry) => url.startsWith(entry.prefix));
    if (limit === undefined) {
      return;
    }
    const existing = routeOptions.onRequest;
    routeOptions.onRequest = Array.isArray(existing)
      ? [jsonContentTypeGuard, ...existing]
      : existing === undefined
        ? [jsonContentTypeGuard]
        : [jsonContentTypeGuard, existing];
    const routeConfig = routeOptions.config ?? {};
    routeOptions.config = routeConfig;
    routeConfig.rateLimit = {
      max: limit.max,
      timeWindow: config.iam.rateLimit.ipWindowSeconds * 1000,
    };
  });

  // Security basics: Helmet headers, CORS from validated config
  // (wildcard is rejected in production by packages/config), explicit body limit.
  await app.register(cookie);
  await app.register(helmet);
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'idempotency-key',
      'if-match',
      'origin',
      'x-consent-receipt-version',
      'x-csrf-token',
      'x-request-id',
    ],
  });
  await app.register(rateLimit, {
    // IAM routes opt in per-route via `config.rateLimit` (see onRoute hook).
    global: false,
    nameSpace: 'wai:iam:rl:http:',
    // IETF draft-spec headers (ratelimit-*, retry-after) instead of the
    // legacy x-ratelimit-* names the plugin uses by default.
    enableDraftSpec: true,
    ...(cacheClient === undefined ? {} : { redis: cacheClient }),
    // The plugin throws the builder's return value from its hook; the
    // GlobalExceptionFilter maps it to the 429 contract envelope. The
    // statusCode property is what makes the response a 429 — it never
    // reaches the body.
    errorResponseBuilder: (req: FastifyRequest, context: { statusCode: number }): object => ({
      statusCode: context.statusCode,
      code: 'RATE_LIMITED' as ErrorCode,
      message: 'Too many requests; try again later',
      request_id: requestIdFor(req),
    }),
  });

  await app.init();
  return app;
}

async function waitForValkeyReady(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Valkey client not ready within 15s (status ${client.status})`)),
      15_000,
    );
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface Closeable {
  close(): Promise<unknown>;
}

/**
 * Tears down the app AND its real infrastructure adapters (pg pool, ioredis,
 * BullMQ queues). HealthService owns the database/cache/foundation queue
 * lifecycle during `app.close()`; the other queues are closed here after the
 * module teardown. Keeping ownership split avoids closing any adapter twice,
 * while still covering every queue opened by InfraModule.
 */
export async function closeApiApp(app: NestFastifyApplication): Promise<void> {
  // HealthService.onModuleDestroy closes these three tokens as part of the
  // Nest application shutdown. Do not call them before app.close(), or the
  // module teardown will race and close the same sockets a second time.
  await app.close();

  const resources: Closeable[] = [];
  for (const token of [
    MEDIA_QUEUE_ADAPTER,
    PRIVATE_DELIVERY_QUEUE_ADAPTER,
    TRANSLATION_QUEUE_ADAPTER,
    NOTIFICATION_QUEUE_ADAPTER,
  ]) {
    const resource = app.get<Closeable | undefined>(token, { strict: false });
    if (resource !== undefined) {
      resources.push(resource);
    }
  }
  await Promise.allSettled(resources.map((resource) => resource.close()));
}
