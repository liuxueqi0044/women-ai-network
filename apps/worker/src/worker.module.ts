import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { Queue, Worker, type WorkerOptions } from 'bullmq';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import type { Tracer } from '@opentelemetry/api';
import type { AppConfig } from '@wai/config';
import {
  JOB_NAMES,
  QUEUE_NAMES,
  mediaProcessJobSchema,
  messagingWakeupJobSchema,
  notificationWakeJobSchema,
  type TranslationProvider,
} from '@wai/contracts';
import { Pool } from 'pg';
import {
  parsePepper,
  hmacDigest,
  parsePiiKeys,
  PgLetterRepository,
  PgMediaRepository,
  PgPrivateDeliveryRepository,
  PgTranslationRepository,
  PgMessagingRepository,
  PgNotificationDeliveryRepository,
  PgNotificationRepository,
  PgNotificationResourceGate,
} from '@wai/db';
import { createLogger, initOpenTelemetry, type WaiLogger } from '@wai/observability';
import {
  AllowAllMediaContentModerator,
  createS3CompatibleClient,
  DoubaoVisionModerator,
  S3MediaStorage,
} from '@wai/media-infra';
import {
  APP_CONFIG,
  APP_LOGGER,
  APP_TRACER,
  TRACE_PROCESSOR,
  TRACE_RESULT_STORE,
  WORKER_INSTANCE,
  MEDIA_JOB_RUNNER,
  MEDIA_WORKER_INSTANCE,
  PRIVATE_DELIVERY_RUNNER,
  PRIVATE_DELIVERY_WORKER_INSTANCE,
  TRANSLATION_AUTHORIZATION,
  TRANSLATION_PIPELINE,
  TRANSLATION_POOL,
  TRANSLATION_PROVIDERS,
  TRANSLATION_QUEUE,
  TRANSLATION_WORKER_INSTANCE,
  TRANSLATION_RECONCILER,
  MESSAGING_WAKEUP_RUNNER,
  NOTIFICATION_DELIVERY_RUNNER,
  NOTIFICATION_WORKER_INSTANCE,
} from './tokens.js';
import { dispatchJob, logWithEnvelopeContext } from './foundation/dispatch.js';
import { TraceProcessor } from './foundation/trace.processor.js';
import { ValkeyTraceResultStore } from './foundation/valkey-trace-result-store.js';
import type { TraceJobProcessor, TraceResultStore } from './foundation/types.js';
import { DurableMediaJobRunner, MediaPipeline } from './media/pipeline.js';
import { MediaObjectKeys } from './media/keys.js';
import { SharpImageSanitizer } from './media/sharp-sanitizer.js';
import { ClamAvScanner, DeterministicMalwareScanner } from './media/scanner.js';
import { MemoryMediaStorage, UnavailableMediaStorage } from './media/object-storage.js';
import {
  DurablePrivateDeliveryRunner,
  type PrivateDeliveryWorkerRunner,
} from './private-delivery/runner.js';
import { DatabasePrivateDeliveryPolicyGate } from './private-delivery/database-policy-gate.js';
import { TranslationPipeline } from './translation/pipeline.js';
import { processTranslationWakeup } from './translation/wakeup.js';
import { PgTranslationAuthorization } from './translation/authorization.js';
import type { TranslationAuthorizationPort } from './translation/pipeline.js';
import { TranslationWakeReconciler } from './translation/reconciler.js';
import { MessagingWakeupRunner, unavailableMessagingHintDispatcher } from './messaging/runner.js';
import {
  NotificationDeliveryRunner,
  type NotificationWorkerRepository,
} from './notifications/runner.js';

export interface WorkerAppOverrides {
  /** Test hooks — replace real processor/store/logger/tracer with fakes. */
  tracer?: Tracer;
  logger?: WaiLogger;
  processor?: TraceJobProcessor;
  resultStore?: TraceResultStore;
  /** Test hook — override BullMQ Worker options (e.g. retry attempts). */
  workerOptions?: WorkerOptions;
  mediaRunner?: DurableMediaJobRunner;
  privateDeliveryRunner?: PrivateDeliveryWorkerRunner;
  translationAuthorization?: TranslationAuthorizationPort;
  translationProviders?: ReadonlyMap<string, TranslationProvider>;
  translationWorkerOptions?: WorkerOptions;
}

/** Builds the ioredis/BullMQ connection options from validated config. */
export function buildValkeyConnection(config: AppConfig): {
  host: string;
  port: number;
  db: number;
  password?: string;
  tls?: object;
} {
  const connection: {
    host: string;
    port: number;
    db: number;
    password?: string;
    tls?: object;
  } = {
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

/** PostgreSQL-backed CIR handoff state machine, shared by runtime and real-PG tests. */
export async function reconcileCircleNotificationHandoffs(pool: Pool, notificationKey: Buffer) {
  const notifications = new PgNotificationRepository(pool, notificationKey);
  const gate = new PgNotificationResourceGate(pool);
  const client = await pool.connect();
  const claimed: Array<{
    id: string;
    invitation_id: string;
    recipient_account_id: string;
    role: 'member' | 'moderator';
    lease_token: string;
    lease_fence: number;
  }> = [];
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE circles.notification_handoff SET state='failed',last_error='LEASE_EXHAUSTED',updated_at=now() WHERE state='leased' AND updated_at<now()-interval '5 minutes' AND attempts>=max_attempts",
    );
    const rows = await client.query(
      "SELECT id,invitation_id,recipient_account_id,role FROM circles.notification_handoff WHERE ((state IN ('pending','retrying') AND available_at<=now()) OR (state='leased' AND updated_at<now()-interval '5 minutes')) AND attempts<max_attempts ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 25",
    );
    for (const row of rows.rows) {
      const leaseToken = randomUUID();
      const updated = await client.query(
        "UPDATE circles.notification_handoff SET state='leased',attempts=attempts+1,lease_token=$2,lease_fence=lease_fence+1,updated_at=now() WHERE id=$1 RETURNING id,invitation_id,recipient_account_id,role,lease_token,lease_fence",
        [row.id, leaseToken],
      );
      if (updated.rows[0]) claimed.push(updated.rows[0]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const handoff of claimed) {
    try {
      const authority = await gate.check({
        actorAccountId: handoff.recipient_account_id,
        recipientAccountId: handoff.recipient_account_id,
        resourceKind: 'circle',
        resourceId: handoff.invitation_id,
        eventKey: 'circle.invitation',
      });
      if (!authority.allowed) {
        await pool.query(
          "UPDATE circles.notification_handoff SET state=$4,available_at=CASE WHEN $4='retrying' THEN now()+interval '1 minute' ELSE available_at END,last_error=$5,updated_at=now() WHERE id=$1 AND lease_token=$2 AND lease_fence=$3 AND state='leased'",
          [
            handoff.id,
            handoff.lease_token,
            handoff.lease_fence,
            authority.retryable ? 'retrying' : 'suppressed',
            authority.retryable ? 'GATE_UNAVAILABLE' : 'GATE_DENIED',
          ],
        );
        continue;
      }
      const request = {
        recipient_account_id: handoff.recipient_account_id,
        resource_kind: 'circle' as const,
        resource_id: handoff.invitation_id,
        event: {
          event_key: 'circle.invitation' as const,
          event_version: 1 as const,
          parameters: { role: handoff.role },
        },
        idempotency_key: `circle:invitation:${handoff.invitation_id}`,
      };
      await notifications.ingest({
        request,
        requestDigest: hmacDigest(notificationKey, 'notification:ingest', JSON.stringify(request)),
        now: new Date(),
      });
      await pool.query(
        "UPDATE circles.notification_handoff SET state='sent',updated_at=now() WHERE id=$1 AND lease_token=$2 AND lease_fence=$3 AND state='leased'",
        [handoff.id, handoff.lease_token, handoff.lease_fence],
      );
    } catch {
      await pool.query(
        "UPDATE circles.notification_handoff SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'retrying' END,available_at=now()+interval '1 minute',last_error='HANDOFF_FAILURE',updated_at=now() WHERE id=$1 AND lease_token=$2 AND lease_fence=$3 AND state='leased'",
        [handoff.id, handoff.lease_token, handoff.lease_fence],
      );
    }
  }
}

@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig, overrides: WorkerAppOverrides = {}): DynamicModule {
    const allowIncompleteMedia = overrides.mediaRunner !== undefined;
    if (
      config.isProduction &&
      config.media.enabled &&
      !allowIncompleteMedia &&
      (config.media.storageAdapter !== 'real' ||
        config.media.scannerAdapter !== 'real' ||
        config.media.sanitizerAdapter !== 'real' ||
        config.media.contentModerationAdapter !== 'doubao')
    )
      throw new Error('production_media_fake_adapter_refused');
    if (
      config.isProduction &&
      config.media.enabled &&
      !allowIncompleteMedia &&
      (config.media.storage === undefined || config.media.contentModeration === undefined)
    )
      throw new Error('production_media_provider_configuration_incomplete');
    if (
      config.isProduction &&
      config.media.enabled &&
      !allowIncompleteMedia &&
      (config.media.storage?.useSsl !== true ||
        !config.media.contentModeration?.apiBaseUrl.startsWith('https://'))
    )
      throw new Error('production_media_provider_tls_required');
    const tracer =
      overrides.tracer ??
      initOpenTelemetry({
        serviceName: 'wai-worker',
        enabled: config.otel.enabled,
        exporter: config.otel.exporter,
        ...(config.otel.otlpEndpoint === undefined
          ? {}
          : { otlpEndpoint: config.otel.otlpEndpoint }),
      });
    const logger =
      overrides.logger ??
      createLogger({
        service: 'wai-worker',
        environment: config.nodeEnv,
        level: config.logLevel,
        ...(config.logPretty ? { pretty: true } : {}),
      });

    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: APP_LOGGER, useValue: logger },
      { provide: APP_TRACER, useValue: tracer },
      {
        provide: PgMediaRepository,
        useFactory: () =>
          new PgMediaRepository(
            new Pool({
              connectionString: config.databaseUrl,
              connectionTimeoutMillis: 5000,
              max: 3,
            }),
          ),
      },
      {
        provide: MEDIA_JOB_RUNNER,
        useFactory: (repository: PgMediaRepository): DurableMediaJobRunner => {
          if (overrides.mediaRunner !== undefined) return overrides.mediaRunner;
          const secret = new TextEncoder().encode(config.iam.secretPepper);
          const storageConfig = config.media.enabled ? config.media.storage : undefined;
          const storage =
            config.media.enabled && config.media.storageAdapter === 'fake'
              ? new MemoryMediaStorage()
              : storageConfig === undefined
                ? new UnavailableMediaStorage()
                : new S3MediaStorage(
                    {
                      quarantine: createS3CompatibleClient({
                        endPoint: storageConfig.endpointHost,
                        port: storageConfig.endpointPort,
                        useSSL: storageConfig.useSsl,
                        ...(storageConfig.region === undefined
                          ? {}
                          : { region: storageConfig.region }),
                        accessKey: storageConfig.quarantineAccessKey,
                        secretKey: storageConfig.quarantineSecretKey,
                      }),
                      clean: createS3CompatibleClient({
                        endPoint: storageConfig.endpointHost,
                        port: storageConfig.endpointPort,
                        useSSL: storageConfig.useSsl,
                        ...(storageConfig.region === undefined
                          ? {}
                          : { region: storageConfig.region }),
                        accessKey: storageConfig.cleanAccessKey,
                        secretKey: storageConfig.cleanSecretKey,
                      }),
                    },
                    {
                      quarantineBucket: storageConfig.quarantineBucket,
                      cleanBucket: storageConfig.cleanBucket,
                    },
                  );
          const scanner =
            config.media.scannerAdapter === 'fake'
              ? new DeterministicMalwareScanner()
              : new ClamAvScanner(config.media.scanner.host, config.media.scanner.port);
          const moderationConfig = config.media.contentModeration;
          const contentModerator =
            config.media.contentModerationAdapter === 'fake' || moderationConfig === undefined
              ? new AllowAllMediaContentModerator()
              : new DoubaoVisionModerator({
                  apiBaseUrl: moderationConfig.apiBaseUrl,
                  apiKey: moderationConfig.apiKey,
                  model: moderationConfig.model,
                });
          return new DurableMediaJobRunner(
            repository,
            new MediaPipeline(
              repository,
              storage,
              scanner,
              contentModerator,
              new SharpImageSanitizer(),
              new MediaObjectKeys(secret),
              moderationConfig === undefined
                ? {}
                : { moderationTimeoutMs: moderationConfig.timeoutMs },
            ),
          );
        },
        inject: [PgMediaRepository],
      },
      {
        provide: TRACE_RESULT_STORE,
        useValue:
          overrides.resultStore ??
          new ValkeyTraceResultStore(
            new Redis({
              ...buildValkeyConnection(config),
              enableOfflineQueue: false,
              maxRetriesPerRequest: 1,
              // First connect to a container can take seconds on
              // Windows/Docker; 2s was too tight for the store's first claim.
              connectTimeout: 5000,
            }),
          ),
      },
      {
        provide: TRACE_PROCESSOR,
        // The override must actually REPLACE the processor — a declared test
        // hook that is ignored would silently run the real processor in
        // tests (integration tests caught exactly that).
        ...(overrides.processor === undefined
          ? { useClass: TraceProcessor }
          : { useValue: overrides.processor }),
      },
      {
        provide: WORKER_INSTANCE,
        useFactory: (processor: TraceJobProcessor): Worker => {
          const worker = new Worker(
            QUEUE_NAMES.foundation,
            (job) => dispatchJob(job, processor, logger),
            {
              connection: buildValkeyConnection(config),
              concurrency: 1,
              ...overrides.workerOptions,
            },
          );
          // Worker-level lifecycle events: completed/failed are logged with
          // the envelope's request context when the payload is parseable.
          // Failures are logged at error level — never silently swallowed.
          worker.on('completed', (job) => {
            logWithEnvelopeContext(job.data, () => {
              logger.info(
                { event: 'worker.job.completed', job_name: job.name, job_id: job.id ?? null },
                'job completed',
              );
            });
          });
          worker.on('failed', (job, error) => {
            logWithEnvelopeContext(job?.data, () => {
              logger.error(
                {
                  event: 'worker.job.failed',
                  job_name: job?.name ?? null,
                  job_id: job?.id ?? null,
                  // Pass the value itself — the shared logger Error policy
                  // decides what is safe to emit (production: type/name/
                  // stable code only). Never hand-build {message, stack}
                  // objects, which would bypass that policy.
                  error: error instanceof Error ? error : String(error),
                },
                'job failed',
              );
            });
          });

          return worker;
        },
        inject: [TRACE_PROCESSOR],
      },
      {
        provide: MEDIA_WORKER_INSTANCE,
        useFactory: (runner: DurableMediaJobRunner): Worker =>
          new Worker(
            QUEUE_NAMES.media,
            async (job) =>
              processMediaWakeup(runner, `worker-${process.pid}`, {
                name: job.name,
                data: job.data,
              }),
            {
              connection: buildValkeyConnection(config),
              concurrency: 1,
              limiter: { max: 1, duration: 100 },
            },
          ),
        inject: [MEDIA_JOB_RUNNER],
      },
      {
        provide: PRIVATE_DELIVERY_RUNNER,
        useFactory: (repository: PgPrivateDeliveryRepository): PrivateDeliveryWorkerRunner => {
          if (overrides.privateDeliveryRunner !== undefined) return overrides.privateDeliveryRunner;
          const keys = parsePiiKeys(config.iam.piiKeysJson);
          const key = keys.get(config.iam.piiKeyId);
          if (!key) throw new Error('private_delivery_key_unavailable');
          return new DurablePrivateDeliveryRunner(
            repository,
            new DatabasePrivateDeliveryPolicyGate(repository.pool),
          );
        },
        inject: [PgPrivateDeliveryRepository],
      },
      {
        provide: MESSAGING_WAKEUP_RUNNER,
        useFactory: (repository: PgPrivateDeliveryRepository): MessagingWakeupRunner => {
          const keys = parsePiiKeys(config.iam.piiKeysJson);
          const key = keys.get(config.iam.piiKeyId);
          if (!key) throw new Error('messaging_key_unavailable');
          return new MessagingWakeupRunner(
            new PgMessagingRepository(repository.pool, {
              keyId: config.iam.piiKeyId,
              key,
              keys,
              hmacKey: parsePepper(config.iam.secretPepper),
            }),
            `messaging-${process.pid}`,
            unavailableMessagingHintDispatcher,
          );
        },
        inject: [PgPrivateDeliveryRepository],
      },
      {
        provide: PgPrivateDeliveryRepository,
        useFactory: () => {
          const keys = parsePiiKeys(config.iam.piiKeysJson);
          const key = keys.get(config.iam.piiKeyId);
          if (!key) throw new Error('private_delivery_key_unavailable');
          return new PgPrivateDeliveryRepository(
            new Pool({
              connectionString: config.databaseUrl,
              connectionTimeoutMillis: 5000,
              max: 3,
            }),
            {
              keyId: config.iam.piiKeyId,
              key,
              keys,
              hmacKey: parsePepper(config.iam.secretPepper),
            },
          );
        },
      },
      {
        provide: PgNotificationDeliveryRepository,
        useFactory: () =>
          new PgNotificationDeliveryRepository(
            new Pool({
              connectionString: config.databaseUrl,
              connectionTimeoutMillis: 5000,
              max: 3,
            }),
          ),
      },
      {
        provide: NOTIFICATION_DELIVERY_RUNNER,
        useFactory: (repository: PgNotificationDeliveryRepository): NotificationDeliveryRunner => {
          const gate = new PgNotificationResourceGate(repository.pool);
          return new NotificationDeliveryRunner(
            repository as unknown as NotificationWorkerRepository,
            gate,
            new Map(),
          );
        },
        inject: [PgNotificationDeliveryRepository],
      },
      {
        provide: NOTIFICATION_WORKER_INSTANCE,
        useFactory: (
          runner: NotificationDeliveryRunner,
          repository: PgNotificationDeliveryRepository,
        ): Worker => {
          const connection = buildValkeyConnection(config);
          const queue = new Queue(QUEUE_NAMES.notifications, { connection });
          const notificationKey = parsePepper(config.iam.secretPepper);
          const reconcileCircles = () =>
            reconcileCircleNotificationHandoffs(repository.pool, notificationKey);
          const reconcile = async () => {
            const ids = await repository.reconcileDueIntentIds(100);
            await Promise.all(
              ids.map((intentId) =>
                queue.add(
                  JOB_NAMES.notificationWakeup,
                  { intent_id: intentId },
                  {
                    jobId: `notification-reconcile:${intentId}:${Math.floor(Date.now() / 60_000)}`,
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 1000 },
                  },
                ),
              ),
            );
            await reconcileCircles();
          };
          const timer = setInterval(() => void reconcile().catch(() => undefined), 5000);
          timer.unref();
          void reconcile().catch(() => undefined);
          const worker = new Worker(
            QUEUE_NAMES.notifications,
            async (job) => {
              notificationWakeJobSchema.parse(job.data);
              return runner.process(
                { name: job.name, data: job.data },
                `notifications-${process.pid}`,
              );
            },
            { connection, concurrency: 1, ...overrides.workerOptions },
          );
          const runtime = worker as Worker & {
            notificationQueue?: Queue;
            notificationTimer?: NodeJS.Timeout;
          };
          // Lifecycle ownership stays with worker-app so shutdown can await
          // timer -> worker -> queue -> PG pool in a deterministic order.
          runtime.notificationQueue = queue;
          runtime.notificationTimer = timer;
          return worker;
        },
        inject: [NOTIFICATION_DELIVERY_RUNNER, PgNotificationDeliveryRepository],
      },
      {
        provide: PRIVATE_DELIVERY_WORKER_INSTANCE,
        useFactory: (
          runner: PrivateDeliveryWorkerRunner,
          repository: PgPrivateDeliveryRepository,
          messagingRunner: MessagingWakeupRunner,
        ): Worker => {
          const connection = buildValkeyConnection(config);
          const wakeQueue = new Queue(QUEUE_NAMES.privateDelivery, { connection });
          const sweep = async () => {
            await messagingRunner.runOnce(50);
            const ids = await repository.reconcileDueWakeups(50);
            await Promise.all(
              ids.map((deliveryId) =>
                wakeQueue.add(
                  JOB_NAMES.privateDeliveryWakeup,
                  { delivery_id: deliveryId },
                  {
                    jobId: `pvl-reconcile:${deliveryId}:${randomUUID()}`,
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 1000 },
                  },
                ),
              ),
            );
          };
          const timer = setInterval(() => void sweep().catch(() => undefined), 5000);
          timer.unref();
          void sweep().catch(() => undefined);
          const worker = new Worker(
            QUEUE_NAMES.privateDelivery,
            async (job) => {
              if (job.name === JOB_NAMES.messagingWakeup) {
                messagingWakeupJobSchema.parse(job.data);
                return messagingRunner.runOnce();
              }
              const result = await runner.process(`private-delivery-${process.pid}`, {
                name: job.name,
                data: job.data,
              });
              if (result === 'retrying') throw new Error('private_delivery_retry');
              return result;
            },
            { connection, concurrency: 1, ...overrides.workerOptions },
          );
          worker.on('closed', () => {
            clearInterval(timer);
            void wakeQueue.close();
            void messagingRunner.close();
          });
          return worker;
        },
        inject: [PRIVATE_DELIVERY_RUNNER, PgPrivateDeliveryRepository, MESSAGING_WAKEUP_RUNNER],
      },
      {
        provide: TRANSLATION_POOL,
        useFactory: () =>
          new Pool({
            connectionString: config.databaseUrl,
            connectionTimeoutMillis: 5000,
            max: 3,
          }),
      },
      {
        provide: PgTranslationRepository,
        useFactory: (pool: Pool): PgTranslationRepository => {
          const keys = parsePiiKeys(config.iam.piiKeysJson);
          const key = keys.get(config.iam.piiKeyId);
          if (key === undefined) throw new Error('translation_key_unavailable');
          return new PgTranslationRepository(pool, {
            keyId: config.iam.piiKeyId,
            key,
            keys,
            hmacKey: parsePepper(config.iam.secretPepper),
          });
        },
        inject: [TRANSLATION_POOL],
      },
      {
        provide: TRANSLATION_AUTHORIZATION,
        useFactory: (pool: Pool): TranslationAuthorizationPort => {
          if (overrides.translationAuthorization !== undefined)
            return overrides.translationAuthorization;
          const keys = parsePiiKeys(config.iam.piiKeysJson);
          const key = keys.get(config.iam.piiKeyId);
          if (key === undefined) throw new Error('translation_key_unavailable');
          return new PgTranslationAuthorization(
            pool,
            new PgLetterRepository(pool, {
              keyId: config.iam.piiKeyId,
              key,
              keys,
              hmacKey: parsePepper(config.iam.secretPepper),
            }),
          );
        },
        inject: [TRANSLATION_POOL],
      },
      {
        provide: TRANSLATION_PROVIDERS,
        useValue: overrides.translationProviders ?? new Map<string, TranslationProvider>(),
      },
      {
        provide: TRANSLATION_PIPELINE,
        useFactory: (
          repository: PgTranslationRepository,
          authorization: TranslationAuthorizationPort,
          providers: ReadonlyMap<string, TranslationProvider>,
        ): TranslationPipeline =>
          new TranslationPipeline(
            repository,
            authorization,
            providers,
            `translation-${process.pid}`,
          ),
        inject: [PgTranslationRepository, TRANSLATION_AUTHORIZATION, TRANSLATION_PROVIDERS],
      },
      {
        provide: TRANSLATION_QUEUE,
        useFactory: () =>
          new Queue(QUEUE_NAMES.translation, {
            connection: buildValkeyConnection(config),
          }),
      },
      {
        provide: TRANSLATION_WORKER_INSTANCE,
        useFactory: (
          pipeline: TranslationPipeline,
          repository: PgTranslationRepository,
          queue: Queue,
        ): Worker => {
          const worker = new Worker(
            QUEUE_NAMES.translation,
            async (job) => {
              const outcome = await processTranslationWakeup(pipeline, {
                name: job.name,
                data: job.data,
              });
              if (outcome === 'retry_wait') {
                const taskId = String((job.data as { task_id: string }).task_id);
                const task = await repository.findTask(taskId);
                if (task !== null && task.nextRetryAt !== null) {
                  await queue.add(
                    JOB_NAMES.translationProcess,
                    { task_id: task.id },
                    {
                      jobId: `${task.id}:retry:${task.attempts}`,
                      delay: Math.max(0, task.nextRetryAt.getTime() - Date.now()),
                      removeOnComplete: { count: 1000 },
                      removeOnFail: { count: 5000 },
                    },
                  );
                  await repository.markWakeupEnqueued({
                    taskId: task.id,
                    attempt: task.attempts,
                    enqueuedAt: new Date(),
                  });
                }
              }
              return outcome;
            },
            {
              connection: buildValkeyConnection(config),
              concurrency: 1,
              ...overrides.translationWorkerOptions,
            },
          );
          worker.on('completed', (job) =>
            logger.info(
              { event: 'translation.worker.completed', job_id: job.id ?? null },
              'translation job completed',
            ),
          );
          worker.on('failed', (job, error) =>
            logger.error(
              {
                event: 'translation.worker.failed',
                job_id: job?.id ?? null,
                error: error instanceof Error ? error : String(error),
              },
              'translation job failed',
            ),
          );
          return worker;
        },
        inject: [TRANSLATION_PIPELINE, PgTranslationRepository, TRANSLATION_QUEUE],
      },
      {
        provide: TRANSLATION_RECONCILER,
        useFactory: (
          repository: PgTranslationRepository,
          queue: Queue,
        ): TranslationWakeReconciler => new TranslationWakeReconciler(repository, queue),
        inject: [PgTranslationRepository, TRANSLATION_QUEUE],
      },
    ];

    return {
      module: WorkerModule,
      providers,
    };
  }
}

/** BullMQ processor: the message is only a wake-up; PostgreSQL remains authoritative. */
export async function processMediaWakeup(
  runner: Pick<DurableMediaJobRunner, 'runOnce'>,
  workerId: string,
  job?: { name: string; data: unknown },
): Promise<'clean' | 'rejected' | 'idle'> {
  if (job !== undefined) {
    if (job.name !== JOB_NAMES.mediaProcess) throw new Error('media_invalid_job');
    mediaProcessJobSchema.parse(job.data);
  }
  const result = await runner.runOnce(workerId);
  if (result === 'retryable') throw new Error('media_retryable');
  return result;
}
