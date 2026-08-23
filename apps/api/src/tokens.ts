import type { InjectionToken } from '@nestjs/common';
import type { Tracer } from '@opentelemetry/api';
import type { AppConfig } from '@wai/config';
import type { WaiLogger } from '@wai/observability';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import type { CacheAdapter, DatabaseAdapter, QueueProducerAdapter } from './infra/adapters.js';

/** NestJS DI tokens for the API's shared infrastructure. */
export const APP_CONFIG: InjectionToken<AppConfig> = Symbol('APP_CONFIG');
export const APP_LOGGER: InjectionToken<WaiLogger> = Symbol('APP_LOGGER');
export const APP_TRACER: InjectionToken<Tracer> = Symbol('APP_TRACER');
export const DATABASE_ADAPTER: InjectionToken<DatabaseAdapter> = Symbol('DATABASE_ADAPTER');
export const CACHE_ADAPTER: InjectionToken<CacheAdapter> = Symbol('CACHE_ADAPTER');
export const QUEUE_ADAPTER: InjectionToken<QueueProducerAdapter> = Symbol('QUEUE_ADAPTER');
export const MEDIA_QUEUE_ADAPTER: InjectionToken<QueueProducerAdapter> =
  Symbol('MEDIA_QUEUE_ADAPTER');
export const PRIVATE_DELIVERY_QUEUE_ADAPTER: InjectionToken<QueueProducerAdapter> = Symbol(
  'PRIVATE_DELIVERY_QUEUE_ADAPTER',
);
export const TRANSLATION_QUEUE_ADAPTER: InjectionToken<QueueProducerAdapter> = Symbol(
  'TRANSLATION_QUEUE_ADAPTER',
);
export const NOTIFICATION_QUEUE_ADAPTER: InjectionToken<QueueProducerAdapter> = Symbol(
  'NOTIFICATION_QUEUE_ADAPTER',
);
/** pg Pool for the IAM repositories (same connection as the health adapter). */
export const IAM_POOL: InjectionToken<Pool> = Symbol('IAM_POOL');
/** Shared ioredis client: cache adapter + rate-limit store + IAM limiter. */
export const CACHE_CLIENT: InjectionToken<Redis> = Symbol('CACHE_CLIENT');
