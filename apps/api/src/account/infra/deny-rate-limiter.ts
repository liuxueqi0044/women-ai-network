import type { RateLimiter, RateLimitResult } from '../ports.js';

/**
 * Fail-closed RateLimiter: denies EVERY request. This is the default for
 * configurations without a real Valkey client (unit-test app instances where
 * the cache is faked). It exists so the RateLimiter token always resolves —
 * any test that actually hits an account route without overriding the limiter
 * gets a loud 429 RATE_LIMITED instead of silently unlimited traffic.
 */
export class DenyRateLimiter implements RateLimiter {
  async consume(_key: string, _limit: number, _windowSeconds: number): Promise<RateLimitResult> {
    return { allowed: false, retryAfterSeconds: 1 };
  }
}
