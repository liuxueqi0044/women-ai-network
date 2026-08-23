import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import type { TraceResultRecord } from './types.js';
import { ValkeyTraceResultStore } from './valkey-trace-result-store.js';

interface RecordedSetCall {
  key: string;
  value: string;
  args: unknown[];
}

/**
 * Fake of the ioredis client. `status: 'ready'` short-circuits the store's
 * bounded connect wait; every SET is recorded so the atomic write contract
 * (single call, JSON value, EX ttl, NX flag) can be asserted exactly.
 */
class FakeRedis {
  status = 'ready';
  setCalls: RecordedSetCall[] = [];
  setResponses: Array<'OK' | null> = [];
  disconnected = false;

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    this.setCalls.push({ key, value, args });
    // `undefined` (no queued response) means 'OK'; a queued `null` is the
    // real SET NX "key already exists" reply and must survive.
    const next = this.setResponses.shift();
    return next === undefined ? 'OK' : next;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  once(): this {
    return this;
  }

  removeListener(): this {
    return this;
  }
}

function makeResult(overrides: Partial<TraceResultRecord> = {}): TraceResultRecord {
  return {
    request_id: 'req-1',
    processed_at: '2026-08-16T00:00:00.000Z',
    attempt: 1,
    ...overrides,
  };
}

describe('ValkeyTraceResultStore', () => {
  it('commits with ONE atomic SET key JSON NX EX ttl write', async () => {
    const redis = new FakeRedis();
    const store = new ValkeyTraceResultStore(redis as unknown as Redis);
    const result = makeResult({ trace_id: 'trace-1' });

    const outcome = await store.commitResult('evt-1', result, 300);

    expect(outcome).toBe('committed');
    expect(redis.setCalls).toHaveLength(1);
    const call = redis.setCalls[0];
    expect(call?.key).toBe('wai:foundation:trace:result:evt-1');
    expect(call?.value).toBe(JSON.stringify(result));
    expect(call?.args).toEqual(['EX', 300, 'NX']); // atomic guard + write in one op
  });

  it('reports already_exists when the atomic write loses the first-writer race', async () => {
    const redis = new FakeRedis();
    redis.setResponses = [null]; // SET NX returned null: the key already existed
    const store = new ValkeyTraceResultStore(redis as unknown as Redis);

    const outcome = await store.commitResult('evt-1', makeResult(), 300);

    expect(outcome).toBe('already_exists');
  });

  it('propagates a connect failure loudly instead of committing silently', async () => {
    const redis = new FakeRedis();
    redis.status = 'end'; // closed client: the bounded wait rejects immediately
    const store = new ValkeyTraceResultStore(redis as unknown as Redis);

    await expect(store.commitResult('evt-1', makeResult(), 300)).rejects.toThrow(
      /client is closed/,
    );
    expect(redis.setCalls).toHaveLength(0); // nothing was written
  });

  it('closes the underlying client', async () => {
    const redis = new FakeRedis();
    const store = new ValkeyTraceResultStore(redis as unknown as Redis);

    await store.close();

    expect(redis.disconnected).toBe(true);
  });
});
