import type Redis from 'ioredis';
import type { TraceResultRecord, TraceResultStore } from './types.js';

/**
 * Valkey-backed result store.
 *
 * `commitResult` is the authoritative smoke side effect: ONE atomic
 * `SET key JSON NX EX ttl` write. The first writer commits the result;
 * every later attempt (retry, duplicate, concurrent execution) observes
 * `already_exists` and must only recognize the completed work — never
 * repeat it. There is no separate claim key, so no "claimed but not yet
 * processed" state can exist (a crash before the write leaves nothing
 * behind; a crash after it is a clean duplicate).
 */
export class ValkeyTraceResultStore implements TraceResultStore {
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    prefix = 'wai:foundation:trace',
  ) {
    this.prefix = prefix;
  }

  async commitResult(
    eventId: string,
    result: TraceResultRecord,
    ttlSeconds: number,
  ): Promise<'committed' | 'already_exists'> {
    // Clients created with enableOfflineQueue: false REJECT commands issued
    // while the socket is still connecting — the first connect to a container
    // can take seconds on Windows/Docker, so wait (bounded) for 'ready'
    // before the first commit instead of failing the job on a connect that
    // simply has not finished yet.
    await this.waitUntilReady(5000);
    const response = await this.redis.set(
      this.resultKey(eventId),
      JSON.stringify(result),
      'EX',
      ttlSeconds,
      'NX',
    );
    return response === 'OK' ? 'committed' : 'already_exists';
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }

  /** Bounded wait for the client to reach 'ready' (or fail loudly). */
  private waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.redis.status === 'ready') {
      return Promise.resolve();
    }
    if (this.redis.status === 'end') {
      return Promise.reject(new Error('trace result store client is closed'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.redis.removeListener('ready', onReady);
        this.redis.removeListener('error', onError);
        reject(new Error(`trace result store client did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      const onReady = (): void => {
        clearTimeout(timer);
        this.redis.removeListener('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        clearTimeout(timer);
        this.redis.removeListener('ready', onReady);
        reject(error);
      };
      this.redis.once('ready', onReady);
      this.redis.once('error', onError);
    });
  }

  private resultKey(eventId: string): string {
    return `${this.prefix}:result:${eventId}`;
  }
}
