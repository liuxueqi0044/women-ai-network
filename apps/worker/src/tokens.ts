import type { InjectionToken } from '@nestjs/common';
import type { Tracer } from '@opentelemetry/api';
import type { Worker } from 'bullmq';
import type { Queue } from 'bullmq';
import type { Pool } from 'pg';
import type { AppConfig } from '@wai/config';
import type { WaiLogger } from '@wai/observability';
import type { TraceJobProcessor, TraceResultStore } from './foundation/types.js';
import type { DurableMediaJobRunner } from './media/pipeline.js';
import type { PrivateDeliveryWorkerRunner } from './private-delivery/runner.js';
import type { TranslationPipeline } from './translation/pipeline.js';
import type { TranslationWakeReconciler } from './translation/reconciler.js';

/** NestJS DI tokens for the worker's shared infrastructure. */
export const APP_CONFIG: InjectionToken<AppConfig> = Symbol('APP_CONFIG');
export const APP_LOGGER: InjectionToken<WaiLogger> = Symbol('APP_LOGGER');
export const APP_TRACER: InjectionToken<Tracer> = Symbol('APP_TRACER');
export const TRACE_PROCESSOR: InjectionToken<TraceJobProcessor> = Symbol('TRACE_PROCESSOR');
export const TRACE_RESULT_STORE: InjectionToken<TraceResultStore> = Symbol('TRACE_RESULT_STORE');
export const WORKER_INSTANCE: InjectionToken<Worker> = Symbol('WORKER_INSTANCE');
export const MEDIA_JOB_RUNNER: InjectionToken<DurableMediaJobRunner> = Symbol('MEDIA_JOB_RUNNER');
export const MEDIA_WORKER_INSTANCE: InjectionToken<Worker> = Symbol('MEDIA_WORKER_INSTANCE');
export const PRIVATE_DELIVERY_RUNNER: InjectionToken<PrivateDeliveryWorkerRunner> =
  Symbol('PRIVATE_DELIVERY_RUNNER');
export const PRIVATE_DELIVERY_WORKER_INSTANCE: InjectionToken<Worker> = Symbol(
  'PRIVATE_DELIVERY_WORKER_INSTANCE',
);
export const TRANSLATION_PIPELINE: InjectionToken<TranslationPipeline> =
  Symbol('TRANSLATION_PIPELINE');
export const TRANSLATION_AUTHORIZATION = Symbol('TRANSLATION_AUTHORIZATION');
export const TRANSLATION_PROVIDERS = Symbol('TRANSLATION_PROVIDERS');
export const TRANSLATION_WORKER_INSTANCE: InjectionToken<Worker> = Symbol(
  'TRANSLATION_WORKER_INSTANCE',
);
export const TRANSLATION_QUEUE: InjectionToken<Queue> = Symbol('TRANSLATION_QUEUE');
export const TRANSLATION_POOL: InjectionToken<Pool> = Symbol('TRANSLATION_POOL');
export const TRANSLATION_RECONCILER: InjectionToken<TranslationWakeReconciler> =
  Symbol('TRANSLATION_RECONCILER');
export const MESSAGING_WAKEUP_RUNNER = Symbol('MESSAGING_WAKEUP_RUNNER');
export const NOTIFICATION_DELIVERY_RUNNER = Symbol('NOTIFICATION_DELIVERY_RUNNER');
export const NOTIFICATION_WORKER_INSTANCE: InjectionToken<Worker> = Symbol(
  'NOTIFICATION_WORKER_INSTANCE',
);
