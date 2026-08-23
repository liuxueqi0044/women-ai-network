import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { Job } from 'bullmq';
import { JOB_NAMES } from '@wai/contracts';
import { createLogger, type WaiLogger } from '@wai/observability';
import { makeJobEnvelope } from '@wai/testkit';
import { dispatchJob, logWithEnvelopeContext } from './dispatch.js';
import type { TraceJobProcessor } from './types.js';

/** Shape of a parsed JSON log line used by the assertions below. */
interface LogLine {
  request_id?: string;
  trace_id?: string;
  event?: string;
}

class CollectingStream extends Writable {
  lines: LogLine[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = chunk.toString();
    for (const line of text.split('\n').filter((part) => part.length > 0)) {
      this.lines.push(JSON.parse(line) as LogLine);
    }
    callback(null);
  }
}

interface CapturedCall {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  obj: Record<string, unknown>;
}

function capturingLogger(): { logger: WaiLogger; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const logger = {} as WaiLogger;
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    logger[level] = ((obj: Record<string, unknown>): void => {
      calls.push({ level, obj });
    }) as WaiLogger[typeof level];
  }
  logger.child = () => logger;
  return { logger, calls };
}

function makeJob(overrides: Partial<Job<unknown>> = {}): Job<unknown> {
  return {
    id: 'job-1',
    name: JOB_NAMES.foundationTrace,
    data: makeJobEnvelope(),
    attemptsMade: 0,
    ...overrides,
  } as unknown as Job<unknown>;
}

class FakeProcessor implements TraceJobProcessor {
  calls: Array<Job<unknown>> = [];

  async process(job: Job<unknown>): Promise<unknown> {
    this.calls.push(job);
    return { handled: true };
  }
}

describe('dispatchJob', () => {
  it('routes the foundation.trace job name to the processor', async () => {
    const processor = new FakeProcessor();
    const { logger, calls } = capturingLogger();
    const job = makeJob();

    const result = await dispatchJob(job, processor, logger);

    expect(processor.calls).toEqual([job]);
    expect(result).toEqual({ handled: true });
    expect(calls).toHaveLength(0);
  });

  it('warns loudly and skips unknown job names (never silently dropped)', async () => {
    const processor = new FakeProcessor();
    const { logger, calls } = capturingLogger();
    const job = makeJob({ name: 'account.created' });

    const result = await dispatchJob(job, processor, logger);

    expect(processor.calls).toHaveLength(0);
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.level).toBe('warn');
    expect(calls[0]?.obj).toMatchObject({
      event: 'worker.job.unknown_name',
      job_name: 'account.created',
    });
  });

  it('propagates processor failures to BullMQ (no swallowing)', async () => {
    const processor: TraceJobProcessor = {
      process: async () => {
        throw new Error('boom');
      },
    };
    const { logger } = capturingLogger();

    await expect(dispatchJob(makeJob(), processor, logger)).rejects.toThrow('boom');
  });
});

describe('logWithEnvelopeContext', () => {
  it('merges the envelope request_id/trace_id into the log line via the real logger', () => {
    const stream = new CollectingStream();
    const logger = createLogger({
      service: 'test-worker',
      environment: 'test',
      level: 'trace',
      destination: stream,
    });
    const envelope = makeJobEnvelope();

    logWithEnvelopeContext(envelope, () => {
      logger.info({ event: 'worker.job.completed' }, 'job completed');
    });

    expect(stream.lines).toHaveLength(1);
    const line = stream.lines[0] ?? {};
    expect(line.request_id).toBe(envelope.request_id);
    expect(line.trace_id).toBe(envelope.traceparent?.split('-')[1]);
    expect(line.event).toBe('worker.job.completed');
  });

  it('falls back to plain logging for unparseable payloads', () => {
    const { logger, calls } = capturingLogger();
    logWithEnvelopeContext({ garbage: true }, () => {
      logger.info({ event: 'worker.job.completed' }, 'job completed');
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.obj).toMatchObject({ event: 'worker.job.completed' });
  });
});
