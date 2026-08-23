import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { Pool } from 'pg';
import Redis, { type RedisOptions } from 'ioredis';
import { Queue } from 'bullmq';
import type { Tracer } from '@opentelemetry/api';
import type { AppConfig } from '@wai/config';
import { QUEUE_NAMES } from '@wai/contracts';
import { createLogger, initOpenTelemetry, type WaiLogger } from '@wai/observability';
import { DenyRateLimiter } from '../account/infra/deny-rate-limiter.js';
import { ValkeyRateLimiter } from '../account/infra/valkey-rate-limiter.js';
import type { RateLimiter } from '../account/ports.js';
import { RATE_LIMITER } from '../account/ports.js';
import {
  APP_CONFIG,
  APP_LOGGER,
  APP_TRACER,
  CACHE_ADAPTER,
  CACHE_CLIENT,
  DATABASE_ADAPTER,
  IAM_POOL,
  MEDIA_QUEUE_ADAPTER,
  PRIVATE_DELIVERY_QUEUE_ADAPTER,
  TRANSLATION_QUEUE_ADAPTER,
  NOTIFICATION_QUEUE_ADAPTER,
  QUEUE_ADAPTER,
} from '../tokens.js';
import {
  BullmqQueueAdapter,
  PgDatabaseAdapter,
  ValkeyCacheAdapter,
  type CacheAdapter,
  type DatabaseAdapter,
  type QueueProducerAdapter,
} from './adapters.js';

export interface InfraOverrides {
  /** Test hooks — replace real adapters/logger/tracer with fakes. */
  tracer?: Tracer;
  logger?: WaiLogger;
  dbAdapter?: DatabaseAdapter;
  cacheAdapter?: CacheAdapter;
  queueAdapter?: QueueProducerAdapter;
  /** Test hook for the media wake-up queue; defaults to queueAdapter in tests. */
  mediaQueueAdapter?: QueueProducerAdapter;
  privateDeliveryQueueAdapter?: QueueProducerAdapter;
  /** Test hook for the translation wake-up queue. */
  translationQueueAdapter?: QueueProducerAdapter;
  notificationQueueAdapter?: QueueProducerAdapter;
  /**
   * Shared ioredis client (created by createApiApp). When the cache adapter is
   * faked, no client is created and the IAM RateLimiter falls back to the
   * fail-closed DenyRateLimiter.
   */
  cacheClient?: Redis;
  /** pg Pool for IAM repositories — real adapters share one Pool. */
  pool?: Pool;
  /** IAM RateLimiter port — default Valkey-backed, or DenyRateLimiter without a client. */
  rateLimiter?: RateLimiter;
}

/** Builds the ioredis/BullMQ connection options from validated config. */
export function buildValkeyConnection(config: AppConfig): {
  host: string;
  port: number;
  db: number;
} {
  const connection: { host: string; port: number; db: number; password?: string; tls?: object } = {
    host: config.valkey.host,
    port: config.valkey.port,
    db: config.valkey.db,
  };
  if (config.valkey.password !== undefined) {
    connection.password = config.valkey.password;
  }
  if (config.valkey.tls) {
    connection.tls = {};
  }
  return connection;
}

/** ioredis options shared by every Valkey connection in the API process. */
export function buildValkeyClientOptions(config: AppConfig): RedisOptions {
  return {
    ...buildValkeyConnection(config),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // First connect to a container can take seconds on Windows/Docker; 2s
    // was too tight for readiness.
    connectTimeout: 5000,
  };
}

/**
 * App-wide infrastructure providers (config, logger, tracer, adapters, and
 * the shared connections the IAM slice lives on: pg Pool + ioredis client).
 *
 * Global because Nest resolves constructor injections by walking the
 * consuming module's IMPORTS, not the root module — without @Global(), the
 * tokens provided here would be invisible to HealthModule/FoundationModule
 * and the cross-cutting interceptor/filter. The APP_INTERCEPTOR/APP_FILTER
 * framework tokens stay on AppModule (Nest applies those app-wide itself).
 */
@Global()
@Module({})
export class InfraModule {
  static forRoot(config: AppConfig, overrides: InfraOverrides = {}): DynamicModule {
    const tracer =
      overrides.tracer ??
      initOpenTelemetry({
        serviceName: 'wai-api',
        enabled: config.otel.enabled,
        exporter: config.otel.exporter,
        ...(config.otel.otlpEndpoint === undefined
          ? {}
          : { otlpEndpoint: config.otel.otlpEndpoint }),
      });
    const logger =
      overrides.logger ??
      createLogger({
        service: 'wai-api',
        environment: config.nodeEnv,
        level: config.logLevel,
        ...(config.logPretty ? { pretty: true } : {}),
      });

    // One PostgreSQL pool and one Valkey client per process, shared by the
    // health adapters, the IAM repositories and the IAM rate limiter. When an
    // adapter is faked (unit-test app instances) no client is created — the
    // IAM RateLimiter then defaults to the fail-closed DenyRateLimiter.
    const pool =
      overrides.pool ??
      new Pool({
        connectionString: config.databaseUrl,
        connectionTimeoutMillis: 5000,
        // ONB provider dispatch holds a transaction through a bounded,
        // timeout-capped adapter handoff. Keep the shared pool explicit and
        // pair it with the dispatch limiter (default capacity: two).
        max: 10,
      });
    const cacheClient =
      overrides.cacheClient ??
      (overrides.cacheAdapter === undefined
        ? new Redis(buildValkeyClientOptions(config))
        : undefined);

    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: APP_LOGGER, useValue: logger },
      { provide: APP_TRACER, useValue: tracer },
      { provide: IAM_POOL, useValue: pool },
      {
        provide: DATABASE_ADAPTER,
        useValue: overrides.dbAdapter ?? new PgDatabaseAdapter(pool),
      },
      // CACHE_ADAPTER is always provided: a test fake, or the real adapter
      // over the shared client. When the cache adapter is faked no client is
      // created and CACHE_CLIENT is not provided at all.
      {
        provide: CACHE_ADAPTER,
        useValue:
          overrides.cacheAdapter ??
          (cacheClient === undefined ? undefined : new ValkeyCacheAdapter(cacheClient)),
      },
      ...(cacheClient === undefined ? [] : [{ provide: CACHE_CLIENT, useValue: cacheClient }]),
      {
        provide: RATE_LIMITER,
        useValue:
          overrides.rateLimiter ??
          (cacheClient === undefined ? new DenyRateLimiter() : new ValkeyRateLimiter(cacheClient)),
      },
      {
        provide: QUEUE_ADAPTER,
        useValue:
          overrides.queueAdapter ??
          new BullmqQueueAdapter(
            new Queue(QUEUE_NAMES.foundation, { connection: buildValkeyConnection(config) }),
          ),
      },
      {
        provide: MEDIA_QUEUE_ADAPTER,
        useValue:
          overrides.mediaQueueAdapter ??
          overrides.queueAdapter ??
          new BullmqQueueAdapter(
            new Queue(QUEUE_NAMES.media, { connection: buildValkeyConnection(config) }),
          ),
      },
      {
        provide: PRIVATE_DELIVERY_QUEUE_ADAPTER,
        useValue:
          overrides.privateDeliveryQueueAdapter ??
          new BullmqQueueAdapter(
            new Queue(QUEUE_NAMES.privateDelivery, { connection: buildValkeyConnection(config) }),
          ),
      },
      {
        provide: TRANSLATION_QUEUE_ADAPTER,
        useValue:
          overrides.translationQueueAdapter ??
          new BullmqQueueAdapter(
            new Queue(QUEUE_NAMES.translation, { connection: buildValkeyConnection(config) }),
          ),
      },
      {
        provide: NOTIFICATION_QUEUE_ADAPTER,
        useValue:
          overrides.notificationQueueAdapter ??
          new BullmqQueueAdapter(
            new Queue(QUEUE_NAMES.notifications, { connection: buildValkeyConnection(config) }),
          ),
      },
    ];

    return {
      module: InfraModule,
      providers,
      // Nest requires providers to be EXPORTED for other modules to see them
      // — this applies to global modules too (the global binding only makes
      // the module an implicit import; the export check still runs).
      // CACHE_CLIENT is exported only when provided — Nest rejects exports of
      // providers that are absent from the module.
      exports: [
        APP_CONFIG,
        APP_LOGGER,
        APP_TRACER,
        DATABASE_ADAPTER,
        CACHE_ADAPTER,
        QUEUE_ADAPTER,
        MEDIA_QUEUE_ADAPTER,
        PRIVATE_DELIVERY_QUEUE_ADAPTER,
        TRANSLATION_QUEUE_ADAPTER,
        NOTIFICATION_QUEUE_ADAPTER,
        IAM_POOL,
        RATE_LIMITER,
        ...(cacheClient === undefined ? [] : [CACHE_CLIENT]),
      ],
    };
  }
}
