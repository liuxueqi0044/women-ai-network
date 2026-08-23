import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { loadEnv, type AppConfig } from '@wai/config';
import {
  makeJobEnvelope,
  makeRequestId,
  makeTraceparent,
  startTestInfra,
  valkeyConnectionParts,
  type StartedInfra,
} from '@wai/testkit';
import { JOB_NAMES, QUEUE_NAMES } from '@wai/contracts';
import { MigrationRunner, createPool } from '@wai/db';
import { sanitizeText } from '@wai/observability';
import { closeApiApp, createApiApp } from '../../apps/api/src/app.js';
import { createWorkerApp, type WorkerAppContext } from '../../apps/worker/src/worker-app.js';
import { TraceProcessor } from '../../apps/worker/src/foundation/trace.processor.js';
import { ValkeyTraceResultStore } from '../../apps/worker/src/foundation/valkey-trace-result-store.js';
import type { TraceJobProcessor } from '../../apps/worker/src/foundation/types.js';
import { postFoundationTrace } from '../../apps/web/src/lib/api-client.js';
import { awaitRedisReady, capturingLogger, valkeyUrl, waitFor } from './helpers.js';

/**
 * Vertical smoke for the whole FND-01 foundation:
 * Web client → real HTTP API → BullMQ queue → BullMQ worker, with ONE
 * Request ID / trace context carried end to end — plus retry idempotency
 * and graceful shutdown against real Postgres/Valkey containers.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
declare const WAI_MIGRATIONS_DIR: string;

let started: StartedInfra;
let config: AppConfig;
let migrationPool: ReturnType<typeof createPool>;

beforeAll(async () => {
  started = await startTestInfra();
  migrationPool = createPool(started.infra.databaseUrl);
  await new MigrationRunner(migrationPool, WAI_MIGRATIONS_DIR).up();
  config = loadEnv({
    NODE_ENV: 'test',
    LOG_PRETTY: 'false',
    LOG_LEVEL: 'warn',
    DATABASE_URL: started.infra.databaseUrl,
    VALKEY_URL: valkeyUrl(started.infra),
    FOUNDATION_TRACE_RESULT_TTL_SECONDS: '300',
  });
}, 180_000);

afterAll(async () => {
  await migrationPool?.end();
  await started.stop();
});

function httpPort(api: Awaited<ReturnType<typeof createApiApp>>): number {
  const server = api.getHttpServer() as Server;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('API did not bind to a TCP port');
  }
  return address.port;
}

describe('vertical smoke: Web → API → Queue → Worker', () => {
  it('carries the same Request ID and trace id through every hop', async () => {
    const captured = capturingLogger('wai-worker');
    const api = await createApiApp(config);
    await api.listen(0, '127.0.0.1');
    // Web clients accept the same versioned base contract as
    // NEXT_PUBLIC_API_BASE_URL; the API origin alone is intentionally invalid.
    const baseUrl = `http://127.0.0.1:${httpPort(api)}/v1`;
    const worker: WorkerAppContext = await createWorkerApp(config, { logger: captured.logger });

    const requestId = makeRequestId();
    const traceparent = makeTraceparent();
    const traceId = traceparent.split('-')[1] ?? '';

    try {
      // Hop 1 — WEB: the exact client module the Next.js app uses.
      const result = await postFoundationTrace({
        message: 'integration vertical smoke',
        requestId,
        traceparent,
        baseUrl,
      });
      expect(result.status).toBe(201);
      expect(result.body.status).toBe('accepted');
      expect(result.body.request_id).toBe(requestId); // API echoed the sent id
      expect(result.body.job_id).toBe(result.body.event_id); // jobId = eventId (dedup)

      // Hop 2 — QUEUE: the persisted envelope carries the same ids.
      const queue = new Queue(QUEUE_NAMES.foundation, {
        connection: valkeyConnectionParts(started.infra.valkey),
      });
      try {
        const job = await queue.getJob(result.body.event_id);
        expect(job).not.toBeNull();
        expect(job?.data).toEqual({
          schema_version: '1.0.0',
          event_id: result.body.event_id,
          request_id: requestId,
          traceparent,
          occurred_at: expect.any(String),
          payload: { message: 'integration vertical smoke' },
        });
      } finally {
        await queue.close();
      }

      // Hop 3 — WORKER: the processed log line merges the same ids via RequestContext.
      const processed = await waitFor('worker foundation.trace.processed log line', async () => {
        const line = captured.stream.lineByEvent('foundation.trace.processed');
        return line === undefined ? undefined : line;
      });
      // The log line is the value the SANITIZING pipeline rendered: a random
      // UUID/hex id can contain a phone-like run (e.g. ...f13726495203) that
      // the content backstop masks — compare against the sanitized form. Raw
      // equality is asserted on the API response above (Hop 1).
      expect(processed.event_id).toBe(result.body.event_id);
      expect(processed.request_id).toBe(sanitizeText(requestId));
      expect(processed.trace_id).toBe(sanitizeText(traceId));
      expect(processed.attempt).toBe(1);

      // The short-term result record (idempotency claim + verification aid).
      const redis = new Redis({
        ...valkeyConnectionParts(started.infra.valkey),
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
      try {
        await awaitRedisReady(redis);
        const raw = await redis.get(`wai:foundation:trace:result:${result.body.event_id}`);
        expect(raw).not.toBeNull();
        const record = JSON.parse(raw ?? 'null') as {
          request_id: string;
          trace_id: string;
          attempt: number;
        };
        expect(record.request_id).toBe(requestId);
        expect(record.trace_id).toBe(traceId);
        expect(record.attempt).toBe(1);
      } finally {
        redis.disconnect();
      }
    } finally {
      await worker.close();
      await closeApiApp(api);
    }
  }, 60_000);

  it('generates and echoes a Request ID when the client sends none', async () => {
    const api = await createApiApp(config);
    await api.listen(0, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${httpPort(api)}`;

    try {
      const response = await fetch(`${baseUrl}/v1/foundation/trace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'generated id smoke' }),
      });
      expect(response.status).toBe(201);
      const headerId = response.headers.get('x-request-id');
      expect(headerId).toMatch(UUID_V4);
      const body = (await response.json()) as { request_id: string };
      expect(body.request_id).toBe(headerId);

      const invalid = await fetch(`${baseUrl}/v1/foundation/trace`, {
        method: 'POST',
        headers: { 'x-request-id': 'not-a-uuid', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(invalid.status).toBe(400);
      const invalidBody = (await invalid.json()) as { code: string; request_id: string };
      expect(invalidBody.code).toBe('BAD_REQUEST');
      expect(invalidBody.request_id).toMatch(UUID_V4); // still carries a valid id
    } finally {
      await closeApiApp(api);
    }
  }, 30_000);

  it('reports all real dependencies up through the readiness endpoint', async () => {
    const api = await createApiApp(config);
    try {
      const fastify = api.getHttpAdapter().getInstance() as {
        inject: (opts: { method: string; url: string }) => Promise<{
          statusCode: number;
          json: () => Record<string, unknown>;
        }>;
      };
      const response = await fastify.inject({ method: 'GET', url: '/v1/health/ready' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        status: string;
        checks: { postgres: string; valkey: string; queue: string };
      };
      // Checks first: if something is down, the per-check breakdown is the
      // useful failure message (the aggregate status only says 'degraded').
      expect(body.checks).toEqual({ postgres: 'up', valkey: 'up', queue: 'up' });
      expect(body.status).toBe('ready');
    } finally {
      await closeApiApp(api);
    }
  }, 30_000);

  it('never repeats a side effect when the same event is retried (idempotency)', async () => {
    const captured = capturingLogger('wai-worker');
    const store = new Redis({
      ...valkeyConnectionParts(started.infra.valkey),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    await awaitRedisReady(store);

    const envelope = makeJobEnvelope();
    // Flaky processor: the real one commits the atomic result record on the
    // FIRST attempt, then we throw — BullMQ retries the job, and the
    // committed result must turn the retry into a recognition-only skip
    // instead of a second side effect. Throwing per job (not once globally)
    // matters: earlier tests enqueue jobs with no worker running, and this
    // worker legitimately picks those up first — the assertions below must
    // (and do) filter by THIS envelope's event id.
    const invocations = new Map<string, number>();
    const real = new TraceProcessor(captured.logger, config, new ValkeyTraceResultStore(store));
    const flaky: TraceJobProcessor = {
      process: async (job) => {
        const jobId = job.id ?? 'unknown';
        const attempt = (invocations.get(jobId) ?? 0) + 1;
        invocations.set(jobId, attempt);
        const outcome = await real.process(job);
        if (attempt === 1) {
          throw new Error('injected first-attempt failure');
        }
        return outcome;
      },
    };

    const worker: WorkerAppContext = await createWorkerApp(config, {
      logger: captured.logger,
      processor: flaky,
    });
    const queue = new Queue(QUEUE_NAMES.foundation, {
      connection: valkeyConnectionParts(started.infra.valkey),
    });

    try {
      await queue.add(JOB_NAMES.foundationTrace, envelope, {
        jobId: envelope.event_id,
        attempts: 2,
        backoff: { type: 'fixed', delay: 100 },
      });

      await waitFor('job to finish after retry', async () => {
        const job = await queue.getJob(envelope.event_id);
        return job?.finishedOn === undefined ? undefined : job;
      });

      // The deterministic retry fact: the processor ran twice for THIS job
      // (initial attempt + exactly one BullMQ retry). The job-level
      // `attemptsMade` field is NOT asserted — BullMQ 5.x increments it on
      // the finishing move too (HINCRBY in moveToFinished), so it reports
      // the number of executions, not the number of retries.
      expect(invocations.get(envelope.event_id)).toBe(2);

      const ownLines = () =>
        captured.stream.lines.filter((line) => line.event_id === envelope.event_id);

      await waitFor('already_processed log line for this event', async () => {
        const line = ownLines().find((l) => l.event === 'foundation.trace.already_processed');
        return line === undefined ? undefined : line;
      });

      // Exactly ONE processed side effect and ONE recognition-only skip for
      // THIS event — the retry added nothing.
      const processed = ownLines().filter((line) => line.event === 'foundation.trace.processed');
      expect(processed).toHaveLength(1);
      expect(processed[0]?.request_id).toBe(sanitizeText(envelope.request_id));
      expect(processed[0]?.trace_id).toBe(sanitizeText(envelope.traceparent?.split('-')[1] ?? ''));
      expect(processed[0]?.attempt).toBe(1);
      expect(
        ownLines().filter((line) => line.event === 'foundation.trace.already_processed'),
      ).toHaveLength(1);
    } finally {
      await queue.close();
      await worker.close();
      store.disconnect();
    }
  }, 60_000);

  it('recovers from a crash BEFORE the result commit: the retry commits once', async () => {
    const captured = capturingLogger('wai-worker');
    const store = new Redis({
      ...valkeyConnectionParts(started.infra.valkey),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    await awaitRedisReady(store);

    const envelope = makeJobEnvelope();
    // Crash BEFORE any durable state exists: attempt 1 throws without ever
    // touching the store. The pre-R1 design had a claim key written before
    // the side effect — such a claim would have made this retry a
    // permanent skip. With the atomic commit there is nothing to clear:
    // the retry must commit successfully.
    const invocations = new Map<string, number>();
    const real = new TraceProcessor(captured.logger, config, new ValkeyTraceResultStore(store));
    const flaky: TraceJobProcessor = {
      process: async (job) => {
        const jobId = job.id ?? 'unknown';
        const attempt = (invocations.get(jobId) ?? 0) + 1;
        invocations.set(jobId, attempt);
        if (attempt === 1) {
          throw new Error('injected pre-commit failure');
        }
        return real.process(job);
      },
    };

    const worker: WorkerAppContext = await createWorkerApp(config, {
      logger: captured.logger,
      processor: flaky,
    });
    const queue = new Queue(QUEUE_NAMES.foundation, {
      connection: valkeyConnectionParts(started.infra.valkey),
    });

    try {
      await queue.add(JOB_NAMES.foundationTrace, envelope, {
        jobId: envelope.event_id,
        attempts: 2,
        backoff: { type: 'fixed', delay: 100 },
      });

      await waitFor('job to finish after retry', async () => {
        const job = await queue.getJob(envelope.event_id);
        return job?.finishedOn === undefined ? undefined : job;
      });
      expect(invocations.get(envelope.event_id)).toBe(2);

      const ownLines = () =>
        captured.stream.lines.filter((line) => line.event_id === envelope.event_id);

      await waitFor('processed log line for this event', async () => {
        const line = ownLines().find((l) => l.event === 'foundation.trace.processed');
        return line === undefined ? undefined : line;
      });

      // Exactly ONE processed side effect, committed by the RETRY (attempt 2).
      // No skip line: the failed first attempt left nothing to recognize.
      const processed = ownLines().filter((line) => line.event === 'foundation.trace.processed');
      expect(processed).toHaveLength(1);
      expect(processed[0]?.attempt).toBe(2);
      expect(
        ownLines().filter((line) => line.event === 'foundation.trace.already_processed'),
      ).toHaveLength(0);

      const raw = await store.get(`wai:foundation:trace:result:${envelope.event_id}`);
      expect(raw).not.toBeNull();
      const record = JSON.parse(raw ?? 'null') as { request_id: string; attempt: number };
      expect(record.request_id).toBe(envelope.request_id);
      expect(record.attempt).toBe(2);
    } finally {
      await queue.close();
      await worker.close();
      store.disconnect();
    }
  }, 60_000);

  it('closes gracefully, waiting for in-flight jobs instead of dropping them', async () => {
    let startedProcessing = false;
    let finishedProcessing = false;
    const slowProcessor: TraceJobProcessor = {
      process: async () => {
        startedProcessing = true;
        await new Promise((resolve) => setTimeout(resolve, 700));
        finishedProcessing = true;
        return { processed: true };
      },
    };

    const worker: WorkerAppContext = await createWorkerApp(config, { processor: slowProcessor });
    const queue = new Queue(QUEUE_NAMES.foundation, {
      connection: valkeyConnectionParts(started.infra.valkey),
    });
    const envelope = makeJobEnvelope();
    let closedOnce = false;

    try {
      await queue.add(JOB_NAMES.foundationTrace, envelope, {
        jobId: envelope.event_id,
        attempts: 1,
      });
      await waitFor('in-flight job to start', async () => (startedProcessing ? true : undefined));

      // Shutdown while the job is still running: close() must WAIT for it.
      const result = await Promise.race([
        worker.close().then(() => {
          closedOnce = true;
          return 'closed' as const;
        }),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
      ]);
      expect(result).toBe('closed');
      expect(finishedProcessing).toBe(true); // the job was allowed to finish
      const job = await queue.getJob(envelope.event_id);
      expect(job?.finishedOn).toBeDefined();
    } finally {
      await queue.close();
      if (!closedOnce) {
        await worker.close().catch(() => undefined);
      }
    }
  }, 60_000);

  it('restarts the worker with the translation reconciler and closes every owned resource', async () => {
    const first = await createWorkerApp(config);
    expect(first.translationReconciler).toBeDefined();
    await first.close();

    const second = await createWorkerApp(config);
    expect(second.translationReconciler).toBeDefined();
    await second.close();
  }, 60_000);
});
