import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Worker } from 'bullmq';
import type { AppConfig } from '@wai/config';
import type { WaiLogger } from '@wai/observability';
import { PgNotificationDeliveryRepository, PgPrivateDeliveryRepository } from '@wai/db';
import { WorkerModule, type WorkerAppOverrides } from './worker.module.js';
import {
  APP_LOGGER,
  TRACE_RESULT_STORE,
  WORKER_INSTANCE,
  MEDIA_WORKER_INSTANCE,
  PRIVATE_DELIVERY_WORKER_INSTANCE,
  TRANSLATION_POOL,
  TRANSLATION_QUEUE,
  TRANSLATION_WORKER_INSTANCE,
  TRANSLATION_RECONCILER,
  NOTIFICATION_WORKER_INSTANCE,
} from './tokens.js';

export interface WorkerAppContext {
  app: INestApplicationContext;
  worker: Worker;
  mediaWorker: Worker;
  privateDeliveryWorker: Worker;
  translationWorker: Worker;
  notificationWorker: Worker;
  translationReconciler: { start(): void; close(): Promise<void> };
  logger: WaiLogger;
  /**
   * Graceful shutdown: stops accepting new jobs, waits for in-flight jobs to
   * finish, then tears down the NestJS context. The BullMQ Worker `close()`
   * resolves only after active jobs complete, so callers can race it with a
   * hard timeout to guarantee exit.
   */
  close(): Promise<void>;
}

/**
 * Boots the NestJS standalone application context with the BullMQ Worker.
 * No HTTP listener — the worker is pure queue consumer (FND-01).
 */
export async function createWorkerApp(
  config: AppConfig,
  overrides: WorkerAppOverrides = {},
): Promise<WorkerAppContext> {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config, overrides), {
    logger: false, // structured logging via @wai/observability only
  });

  const worker = app.get<Worker>(WORKER_INSTANCE);
  const mediaWorker = app.get<Worker>(MEDIA_WORKER_INSTANCE);
  const privateDeliveryWorker = app.get<Worker>(PRIVATE_DELIVERY_WORKER_INSTANCE);
  const translationWorker = app.get<Worker>(TRANSLATION_WORKER_INSTANCE);
  const notificationWorker = app.get<Worker>(NOTIFICATION_WORKER_INSTANCE);
  const translationReconciler = app.get<{ start(): void; close(): Promise<void> }>(
    TRANSLATION_RECONCILER,
  );
  translationReconciler.start();
  const logger = app.get<WaiLogger>(APP_LOGGER);

  return {
    app,
    worker,
    mediaWorker,
    privateDeliveryWorker,
    translationWorker,
    notificationWorker,
    translationReconciler,
    logger,
    close: async () => {
      await worker.close(); // waits for active jobs
      await mediaWorker.close();
      await translationReconciler.close();
      await privateDeliveryWorker.close();
      await translationWorker.close();
      const notificationRuntime = notificationWorker as Worker & {
        notificationQueue?: { close(): Promise<void> };
        notificationTimer?: NodeJS.Timeout;
      };
      if (notificationRuntime.notificationTimer !== undefined)
        clearInterval(notificationRuntime.notificationTimer);
      await notificationWorker.close();
      const notificationQueue = notificationRuntime.notificationQueue;
      if (notificationQueue !== undefined) await notificationQueue.close();
      // The private-delivery reconciler owns a PostgreSQL pool that is not
      // managed by Nest automatically. Close it before test/runtime infra is
      // torn down, otherwise an idle client can receive an unhandled 57P01.
      const privateRepository = app.get<PgPrivateDeliveryRepository>(PgPrivateDeliveryRepository, {
        strict: false,
      });
      if (privateRepository !== undefined) await privateRepository.pool.end();
      const notificationRepository = app.get<PgNotificationDeliveryRepository>(
        PgNotificationDeliveryRepository,
        { strict: false },
      );
      if (notificationRepository !== undefined) await notificationRepository.pool.end();
      const translationQueue = app.get<{ close(): Promise<void> }>(TRANSLATION_QUEUE);
      await translationQueue.close();
      const translationPool = app.get<{ end(): Promise<void> }>(TRANSLATION_POOL);
      await translationPool.end();
      // Release the result store's ioredis connection (app.close() alone
      // would leave the socket open and hang integration tests).
      const store = app.get<{ close(): Promise<unknown> } | undefined>(TRACE_RESULT_STORE, {
        strict: false,
      });
      if (store !== undefined) {
        await store.close();
      }
      await app.close();
    },
  };
}
