import { describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { loadEnv } from '@wai/config';
import { makeJobEnvelope } from '@wai/testkit';
import type { JobEnvelope } from '@wai/contracts';
import type { WaiLogger } from '@wai/observability';
import { TraceProcessor } from './trace.processor.js';
import type { TraceResultRecord, TraceResultStore } from './types.js';

interface CapturedLog {
  obj: Record<string, unknown>;
  msg: string | undefined;
}

function capturingLogger(): { logger: WaiLogger; lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  const logger = {} as WaiLogger;
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    logger[level] = ((obj: Record<string, unknown>, msg?: string): void => {
      lines.push({ obj, msg });
    }) as WaiLogger[typeof level];
  }
  logger.child = () => logger;
  return { logger, lines };
}

/**
 * Commit-semantics fake of the real store (single atomic SET NX write):
 * - first commit of an event id wins and stores the record;
 * - later commits return 'already_exists';
 * - `failFirstCommit` simulates a crash BEFORE the authoritative write —
 *   a retry with the same store state must still be able to commit.
 */
class FakeResultStore implements TraceResultStore {
  committed = new Map<string, TraceResultRecord>();
  commitCalls = 0;

  constructor(private readonly failFirstCommit = false) {}

  async commitResult(
    eventId: string,
    result: TraceResultRecord,
  ): Promise<'committed' | 'already_exists'> {
    this.commitCalls += 1;
    if (this.failFirstCommit && this.commitCalls === 1) {
      throw new Error('injected commit failure (crash before the result write)');
    }
    if (this.committed.has(eventId)) {
      return 'already_exists';
    }
    this.committed.set(eventId, result);
    return 'committed';
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

function makeJob(overrides: Partial<Job<unknown>> = {}): Job<unknown> {
  return {
    id: 'job-1',
    name: 'foundation.trace',
    data: makeJobEnvelope(),
    attemptsMade: 0,
    ...overrides,
  } as unknown as Job<unknown>;
}

const config = loadEnv({ NODE_ENV: 'test', LOG_PRETTY: 'false' });

describe('TraceProcessor', () => {
  it('commits the result atomically and reports the single processed side effect', async () => {
    const { logger, lines } = capturingLogger();
    const store = new FakeResultStore();
    const envelope = makeJobEnvelope();
    const processor = new TraceProcessor(logger, config, store);

    const outcome = await processor.process(makeJob({ data: envelope }));

    expect(outcome).toEqual({ processed: true, attempt: 1 });
    expect(store.committed.has(envelope.event_id)).toBe(true);
    expect(store.committed.get(envelope.event_id)?.request_id).toBe(envelope.request_id);
    expect(store.committed.get(envelope.event_id)?.trace_id).toBe(
      envelope.traceparent!.split('-')[1],
    );
    expect(store.committed.get(envelope.event_id)?.attempt).toBe(1);
    expect(lines.map((l) => l.obj['event'])).toEqual(['foundation.trace.processed']);
    expect(lines[0]?.obj).toMatchObject({
      event_id: envelope.event_id,
      attempt: 1,
      job_id: 'job-1',
    });
  });

  it('propagates the attempt counter from BullMQ retries', async () => {
    const { logger } = capturingLogger();
    const store = new FakeResultStore();
    const envelope = makeJobEnvelope();
    const processor = new TraceProcessor(logger, config, store);

    const outcome = await processor.process(makeJob({ attemptsMade: 2, data: envelope }));

    expect(outcome).toEqual({ processed: true, attempt: 3 });
    expect(store.committed.get(envelope.event_id)?.attempt).toBe(3);
  });

  it('throws on malformed envelopes instead of silently dropping them', async () => {
    const { logger } = capturingLogger();
    const store = new FakeResultStore();
    const processor = new TraceProcessor(logger, config, store);

    await expect(processor.process(makeJob({ data: { not: 'an envelope' } }))).rejects.toThrow();
    expect(store.commitCalls).toBe(0); // validation happens before any side effect
  });

  it('only recognizes completion when the result was already committed (retry idempotency)', async () => {
    const { logger, lines } = capturingLogger();
    const store = new FakeResultStore();
    const envelope = makeJobEnvelope();
    const preExisting: TraceResultRecord = {
      request_id: envelope.request_id,
      ...(envelope.traceparent === undefined
        ? {}
        : { trace_id: envelope.traceparent.split('-')[1] }),
      processed_at: new Date().toISOString(),
      attempt: 1,
    };
    store.committed.set(envelope.event_id, preExisting);
    const processor = new TraceProcessor(logger, config, store);

    const outcome = await processor.process(makeJob({ data: envelope }));

    expect(outcome).toEqual({ processed: false, attempt: 1 });
    expect(store.committed.size).toBe(1); // no second authoritative result
    expect(lines.map((l) => l.obj['event'])).toEqual(['foundation.trace.already_processed']);
    expect(lines[0]?.obj).toMatchObject({ event_id: envelope.event_id, attempt: 1 });
  });

  it('recovers after a crash BEFORE the commit: the retry commits successfully', async () => {
    const { logger, lines } = capturingLogger();
    // First commit throws (nothing durable was written); the retry against
    // the SAME store state must be able to commit and finish the event.
    const store = new FakeResultStore(true);
    const envelope = makeJobEnvelope();
    const processor = new TraceProcessor(logger, config, store);

    await expect(processor.process(makeJob({ data: envelope }))).rejects.toThrow(
      /injected commit failure/,
    );
    expect(store.committed.size).toBe(0); // the crash left nothing behind

    const outcome = await processor.process(makeJob({ data: envelope, attemptsMade: 1 }));
    expect(outcome).toEqual({ processed: true, attempt: 2 });
    expect(store.committed.size).toBe(1);
    expect(lines.filter((l) => l.obj['event'] === 'foundation.trace.processed')).toHaveLength(1);
  });

  it('does not repeat the side effect when a crash follows a successful commit', async () => {
    const { logger, lines } = capturingLogger();
    const store = new FakeResultStore();
    const envelope = makeJobEnvelope();
    const processor = new TraceProcessor(logger, config, store);

    // Attempt 1 commits, then "crashes" (the caller would throw to BullMQ
    // after this point). Attempt 2 is the retry.
    expect(await processor.process(makeJob({ data: envelope }))).toEqual({
      processed: true,
      attempt: 1,
    });
    expect(await processor.process(makeJob({ data: envelope, attemptsMade: 1 }))).toEqual({
      processed: false,
      attempt: 2,
    });

    expect(store.committed.size).toBe(1); // the authoritative result stays single
    expect(store.committed.get(envelope.event_id)?.attempt).toBe(1); // first commit won
    expect(lines.filter((l) => l.obj['event'] === 'foundation.trace.processed')).toHaveLength(1);
    expect(
      lines.filter((l) => l.obj['event'] === 'foundation.trace.already_processed'),
    ).toHaveLength(1);
  });

  it('resolves concurrent execution of the same event id to exactly one result', async () => {
    const { logger, lines } = capturingLogger();
    const store = new FakeResultStore();
    const envelope = makeJobEnvelope();
    const processor = new TraceProcessor(logger, config, store);

    const outcomes = await Promise.all([
      processor.process(makeJob({ data: envelope, id: 'job-a' })),
      processor.process(makeJob({ data: envelope, id: 'job-b' })),
    ]);

    expect(outcomes.map((o) => o.processed).sort()).toEqual([false, true]);
    expect(store.committed.size).toBe(1); // exactly ONE authoritative result
    expect(lines.filter((l) => l.obj['event'] === 'foundation.trace.processed')).toHaveLength(1);
    expect(
      lines.filter((l) => l.obj['event'] === 'foundation.trace.already_processed'),
    ).toHaveLength(1);
  });

  it('passes the configured result TTL to the store', async () => {
    const { logger } = capturingLogger();
    const ttls: number[] = [];
    const store: TraceResultStore = {
      commitResult: async (_eventId: string, _result: TraceResultRecord, ttlSeconds: number) => {
        ttls.push(ttlSeconds);
        return 'committed';
      },
      close: async () => {
        // capture only
      },
    };
    const processor = new TraceProcessor(logger, config, store);

    await processor.process(makeJob());

    expect(ttls).toEqual([config.foundationTraceResultTtlSeconds]);
  });

  it('runs with a traceparent-free envelope (generated-only request id)', async () => {
    const { logger } = capturingLogger();
    const store = new FakeResultStore();
    // Strip the traceparent key entirely (exactOptionalPropertyTypes forbids
    // setting it to undefined) to model an API request that carried none.
    const { traceparent: _stripped, ...rest } = makeJobEnvelope();
    const envelope: JobEnvelope = rest;
    const processor = new TraceProcessor(logger, config, store);

    const outcome = await processor.process(makeJob({ data: envelope }));

    expect(outcome.processed).toBe(true);
    expect(store.committed.get(envelope.event_id)?.trace_id).toBeUndefined();
  });
});
