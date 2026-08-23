import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startTestInfra,
  FakeRateLimiter,
  FixedClock,
  type StartedInfra,
  type TestInfra,
} from '@wai/testkit';
import { ValkeyRateLimiter } from './valkey-rate-limiter.js';

/**
 * The production Valkey limiter must behave EXACTLY like the deterministic
 * fake the services are unit-tested against (same allowed/retryAfterSeconds
 * sequence for the same consume calls). Runs against a real containerized
 * Valkey; the one time-dependent case (window expiry) is covered with a short
 * real window and a brief sleep.
 *
 * One container pair for the whole suite (like the integration tests):
 * Docker Desktop on Windows drops connections under rapid container churn,
 * and the fail-fast client (offline queue disabled) throws while
 * 'connecting'. Each test flushes the keyspace for a clean slate.
 */

let infra: TestInfra;
let started: StartedInfra;
let client: Redis | null = null;
let clock: FixedClock;

beforeAll(async () => {
  started = await startTestInfra();
  infra = started.infra;
});

afterAll(async () => {
  await started.stop();
});

beforeEach(() => {
  clock = new FixedClock(1_000_000);
});

afterEach(async () => {
  client?.disconnect();
  client = null;
});

/**
 * Creates the fail-fast client (offline queue disabled) and waits for it to
 * become ready. Docker Desktop port forwarding on Windows can take hundreds
 * of milliseconds after the container's readiness log; with
 * enableOfflineQueue: false a command issued during 'connecting' throws
 * instead of queuing, so the spec must not issue commands until 'ready'.
 */
async function newClient(): Promise<Redis> {
  const created = new Redis({
    host: infra.valkey.host,
    port: infra.valkey.port,
    password: infra.valkey.password,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // First connect to a container can take seconds on Windows/Docker; the
    // default retryStrategy already retries forever, keep the per-attempt
    // timeout in line with the API's own client options.
    connectTimeout: 5000,
  });
  if (created.status === 'ready') {
    return created;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Valkey client not ready after 15s (status ${created.status})`));
    }, 15_000);
    created.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return created;
}

describe('ValkeyRateLimiter matches FakeRateLimiter on a real Valkey', () => {
  it('allows up to the limit inside the window, then denies with the same retryAfterSeconds', async () => {
    client = await newClient();
    await client.flushdb();
    const valkey = new ValkeyRateLimiter(client);
    const fake = new FakeRateLimiter(clock);

    const key = 'login:email:digest-a';
    const limit = 3;
    const windowSeconds = 60;

    // Same sequence of consumes against both implementations.
    const outcomes: Array<{ allowed: boolean; retryAfterSeconds?: number }> = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push(await valkey.consume(key, limit, windowSeconds));
      outcomes.push(await fake.consume(key, limit, windowSeconds));
    }

    // First three consumes allowed for both; the rest denied with an
    // identical (non-undefined) retryAfterSeconds.
    for (let i = 0; i < 3; i += 1) {
      expect(outcomes[i * 2]).toEqual({ allowed: true });
      expect(outcomes[i * 2 + 1]).toEqual({ allowed: true });
    }
    for (let i = 3; i < 5; i += 1) {
      const denied = outcomes[i * 2];
      expect(denied?.allowed).toBe(false);
      expect(outcomes[i * 2 + 1]).toEqual(denied);
    }
  });

  it('denies with retryAfterSeconds equal to the fake when the limit is exceeded immediately', async () => {
    client = await newClient();
    await client.flushdb();
    const valkey = new ValkeyRateLimiter(client);
    const fake = new FakeRateLimiter(clock);

    const key = 'register:email:digest-b';
    for (let i = 0; i < 2; i += 1) {
      await valkey.consume(key, 1, 300);
      await fake.consume(key, 1, 300);
    }
    // Both deny; the fake reports the full remaining window, Valkey its TTL
    // (equal within the sub-second elapsed here, both round UP to 300).
    const v = await valkey.consume(key, 1, 300);
    const f = await fake.consume(key, 1, 300);
    expect(v.allowed).toBe(false);
    expect(v.retryAfterSeconds).toBe(f.retryAfterSeconds);
    expect(f.retryAfterSeconds).toBe(300);
  });

  it('resets the window after expiry (real short window + sleep)', async () => {
    client = await newClient();
    await client.flushdb();
    const valkey = new ValkeyRateLimiter(client);
    const key = 'login:email:digest-c';
    const windowSeconds = 2;
    const limit = 1;

    expect(await valkey.consume(key, limit, windowSeconds)).toEqual({ allowed: true });
    expect((await valkey.consume(key, limit, windowSeconds)).allowed).toBe(false);

    clock.advanceMs(windowSeconds * 1000 + 100);
    // Real elapsed time must pass for Valkey's TTL — short sleep, then the
    // window has expired and both limiter flavours allow again.
    await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000 + 150));
    const v = await valkey.consume(key, limit, windowSeconds);
    const f = await fakeAfterExpiry();
    expect(v).toEqual({ allowed: true });
    expect(f).toEqual({ allowed: true });

    async function fakeAfterExpiry(): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
      const fake = new FakeRateLimiter(clock);
      await fake.consume(key, limit, windowSeconds); // inside window
      await fake.consume(key, limit, windowSeconds); // inside window (denied)
      // The real limiter's window expired via the real sleep; the fake's
      // clock must advance past the window the same way.
      clock.advanceMs(windowSeconds * 1000 + 100);
      return fake.consume(key, limit, windowSeconds); // fresh window
    }
  }, 30_000);

  it('keeps different keys independent', async () => {
    client = await newClient();
    await client.flushdb();
    const valkey = new ValkeyRateLimiter(client);
    // Exhaust x's window (limit 2): two allowed, third denied.
    expect(await valkey.consume('login:email:digest-x', 2, 60)).toEqual({ allowed: true });
    expect(await valkey.consume('login:email:digest-x', 2, 60)).toEqual({ allowed: true });
    expect((await valkey.consume('login:email:digest-x', 2, 60)).allowed).toBe(false);
    // y's counter is untouched: two allowed despite x being exhausted.
    expect(await valkey.consume('login:email:digest-y', 2, 60)).toEqual({ allowed: true });
    expect(await valkey.consume('login:email:digest-y', 2, 60)).toEqual({ allowed: true });
  });

  it('stores keys under the wai:iam:rl: prefix', async () => {
    client = await newClient();
    await client.flushdb();
    const valkey = new ValkeyRateLimiter(client);
    await valkey.consume('login:email:digest-prefix', 5, 60);
    const keys = await client.keys('*');
    expect(keys).toContain('wai:iam:rl:login:email:digest-prefix');
    expect(keys.some((key) => key.startsWith('wai:iam:rl:'))).toBe(true);
  });
});
