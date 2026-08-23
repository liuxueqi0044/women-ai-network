import { Writable } from 'node:stream';
import type Redis from 'ioredis';
import { createLogger, type WaiLogger } from '@wai/observability';
import type { TestInfra } from '@wai/testkit';

/** Shape of a parsed JSON log line used by the smoke assertions. */
export interface WorkerLogLine {
  event?: string;
  event_id?: string;
  request_id?: string;
  trace_id?: string;
  attempt?: number;
}

/** Captures structured JSON log lines emitted by the real logger. */
export class CollectingStream extends Writable {
  lines: WorkerLogLine[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = chunk.toString();
    for (const line of text.split('\n').filter((part) => part.length > 0)) {
      this.lines.push(JSON.parse(line) as WorkerLogLine);
    }
    callback(null);
  }

  /** Latest line with the given `event` field, or undefined. */
  lineByEvent(event: string): WorkerLogLine | undefined {
    return this.lines.find((line) => line.event === event);
  }
}

export function capturingLogger(service: string): { logger: WaiLogger; stream: CollectingStream } {
  const stream = new CollectingStream();
  const logger = createLogger({
    service,
    environment: 'test',
    level: 'trace',
    destination: stream,
  });
  return { logger, stream };
}

/** Polls until `fn` yields a non-null value, then fails loudly. */
export async function waitFor<T>(
  description: string,
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== null && last !== undefined) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
}

export function valkeyUrl(infra: TestInfra): string {
  return `redis://:${infra.valkey.password}@${infra.valkey.host}:${infra.valkey.port}`;
}

/**
 * Waits for an ioredis client to reach 'ready'. Clients created with
 * `enableOfflineQueue: false` reject commands issued while still connecting,
 * and the first TCP connect to a container can take seconds on Windows/Docker.
 */
export async function awaitRedisReady(client: Redis, timeoutMs = 10_000): Promise<void> {
  if (client.status === 'ready') {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out waiting for the redis client to connect')),
      timeoutMs,
    );
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
