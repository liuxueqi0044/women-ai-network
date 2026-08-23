import type { Pool } from 'pg';
import type { Queue } from 'bullmq';

/**
 * Infrastructure adapter interfaces. Business code depends on these —
 * never on vendor SDKs directly — so PostgreSQL/Valkey/BullMQ can be
 * swapped or faked in tests without touching controllers or services.
 */

export interface DatabaseAdapter {
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class PgDatabaseAdapter implements DatabaseAdapter {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export interface CacheAdapter {
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Minimal surface the cache adapter uses from an ioredis client — declared
 * structurally so the adapter can be unit-tested with a fake and swapped
 * without pulling the whole SDK type in.
 */
export interface ValkeyClientLike {
  readonly status: string;
  once(event: string, listener: (error?: unknown) => void): unknown;
  removeListener(event: string, listener: (error?: unknown) => void): unknown;
  ping(): Promise<string>;
  disconnect(): void;
}

export class ValkeyCacheAdapter implements CacheAdapter {
  constructor(private readonly client: ValkeyClientLike) {}

  async ping(): Promise<boolean> {
    // Clients created with enableOfflineQueue: false REJECT commands issued
    // while the socket is still connecting — the first connect to a container
    // can take seconds on Windows/Docker, so a readiness check landing in that
    // window must wait for 'ready' instead of reporting 'down' (the connect
    // succeeds; it just has not finished yet).
    await this.waitUntilReady(5000);
    const response = await this.client.ping();
    return response === 'PONG';
  }

  async close(): Promise<void> {
    this.client.disconnect();
  }

  /** Bounded wait for the client to reach 'ready' (or fail loudly). */
  private waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.client.status === 'ready') {
      return Promise.resolve();
    }
    if (this.client.status === 'end') {
      return Promise.reject(new Error('cache client is closed'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client.removeListener('ready', onReady);
        this.client.removeListener('error', onError);
        reject(new Error(`cache client did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      const onReady = (): void => {
        clearTimeout(timer);
        this.client.removeListener('error', onError);
        resolve();
      };
      const onError = (error?: unknown): void => {
        clearTimeout(timer);
        this.client.removeListener('ready', onReady);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      this.client.once('ready', onReady);
      this.client.once('error', onError);
    });
  }
}

export interface QueueEnqueueOptions {
  jobId: string;
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
}

export interface QueueProducerAdapter {
  /** Adds a job; resolves when the job is accepted by the queue. */
  enqueue(name: string, data: unknown, options: QueueEnqueueOptions): Promise<void>;
  /** Availability check for readiness (round-trip against the queue). */
  check(): Promise<boolean>;
  close(): Promise<void>;
}

export class BullmqQueueAdapter implements QueueProducerAdapter {
  constructor(private readonly queue: Queue) {}

  async enqueue(name: string, data: unknown, options: QueueEnqueueOptions): Promise<void> {
    await this.queue.add(name, data, {
      jobId: options.jobId,
      attempts: options.attempts,
      backoff: { type: options.backoff.type, delay: options.backoff.delay },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });
  }

  async check(): Promise<boolean> {
    await this.queue.getJobCounts();
    return true;
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
