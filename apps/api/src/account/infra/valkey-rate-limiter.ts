import type { Redis } from 'ioredis';
import type { RateLimiter, RateLimitResult } from '../ports.js';

/**
 * Production RateLimiter port implementation backed by Valkey.
 *
 * Fixed-window accounting in ONE atomic Lua script (INCR + EXPIRE on first
 * hit + TTL read) — no read-modify-write race between concurrent requests.
 * Keys carry the `wai:iam:rl:` prefix so the shared Valkey is never polluted
 * by other subsystems.
 *
 * The window is measured by Valkey's own TTL (server time), so the port stays
 * pure: services pass limit/window, the store decides. The deterministic fake
 * (packages/testkit) mirrors this contract 1:1 and is exercised against this
 * implementation in the spec.
 */

const INCR_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

const KEY_PREFIX = 'wai:iam:rl:';

export class ValkeyRateLimiter implements RateLimiter {
  constructor(private readonly client: Redis) {
    this.client.defineCommand('waiIamRateLimit', {
      numberOfKeys: 1,
      lua: INCR_SCRIPT,
    });
  }

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const fullKey = `${KEY_PREFIX}${key}`;
    const result = (await (this.client as unknown as WaiRateLimitClient).waiIamRateLimit(
      fullKey,
      windowSeconds,
    )) as [number, number];
    const [current, ttlSeconds] = result;
    if (current <= limit) {
      return { allowed: true };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, ttlSeconds) };
  }
}

interface WaiRateLimitClient {
  waiIamRateLimit(key: string, windowSeconds: number): Promise<unknown>;
}
