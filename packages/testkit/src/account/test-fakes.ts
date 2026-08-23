import { createHash, randomUUID } from 'node:crypto';
import { TOTP } from 'otpauth';

/**
 * Deterministic fakes for the IAM-01 ports (Clock / RandomSource /
 * RateLimiter / AuthProvider mock). Services are unit-tested against these;
 * the compliance suite additionally runs the REAL provider through the same
 * contract (see apps/api/src/account/auth-provider/compliance.spec.ts).
 */

export class FixedClock {
  private currentMs: number;

  constructor(initialMs: number) {
    this.currentMs = initialMs;
  }

  now(): number {
    return this.currentMs;
  }

  advanceMs(ms: number): void {
    this.currentMs += ms;
  }
}

export class DeterministicRandomSource {
  private counter = 0;

  bytes(length: number): Buffer {
    // Deterministic pseudo-random stream: sha256(counter || seed) truncated.
    const seed = `wai-test-random-${this.counter}`;
    this.counter += 1;
    const digest = createHash('sha256').update(seed).digest();
    const out = Buffer.alloc(length);
    for (let offset = 0; offset < length; offset += digest.length) {
      digest.copy(out, offset, 0, Math.min(digest.length, length - offset));
    }
    return out;
  }

  uuid(): string {
    return randomUUID();
  }
}

/** In-memory fixed-window rate limiter keyed by string — deterministic. */
export class FakeRateLimiter {
  private readonly hits = new Map<string, { count: number; windowStartMs: number }>();
  private clock: FixedClock;

  constructor(clock: FixedClock) {
    this.clock = clock;
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
    const windowMs = windowSeconds * 1000;
    const now = this.clock.now();
    const current = this.hits.get(key);
    if (current === undefined || now - current.windowStartMs >= windowMs) {
      this.hits.set(key, { count: 1, windowStartMs: now });
      return { allowed: true };
    }
    const next = { count: current.count + 1, windowStartMs: current.windowStartMs };
    this.hits.set(key, next);
    if (next.count <= limit) {
      return { allowed: true };
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((current.windowStartMs + windowMs - now) / 1000),
    );
    return { allowed: false, retryAfterSeconds };
  }

  reset(): void {
    this.hits.clear();
  }
}

/**
 * Deterministic mock AuthProvider: instant salted password hash/verify, TOTP
 * codes derived with the LOCKED otpauth library (same reference implementation
 * as the compliance suite), a fixed pool of 20-byte base32 secrets cycled so
 * successive calls differ. Passes the identical compliance suite as the real
 * provider. `mock-hash:v1:<salt>:<hex>` carries its salt inline so hashes
 * remain self-verifying while staying deterministic.
 */
export class MockAuthProvider {
  readonly name = 'mock';

  private saltCounter = 0;
  private secretCounter = 0;

  // Two valid base32 20-byte secrets, cycled deterministically so that two
  // successive calls always yield different secrets (compliance: "rejects
  // codes produced under a different secret").
  private static readonly SECRETS = [
    'BRAZ2D5Z64JRSXD6IBW4BRZZO2CR5P3O',
    'K2JCDMGCHFS23AMHRK7FK2CCXDL2GYEX',
  ];

  async hashPassword(password: string): Promise<string> {
    this.saltCounter += 1;
    return `mock-hash:v1:${this.saltCounter}:${createHash('sha256')
      .update(`${this.saltCounter}\0${password}`)
      .digest('hex')}`;
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    const match = /^mock-hash:v1:(\d+):([0-9a-f]{64})$/.exec(hash);
    if (match === null) {
      return false;
    }
    const [, salt, hex] = match;
    return createHash('sha256').update(`${salt}\0${password}`).digest('hex') === hex;
  }

  async dummyVerify(_password: string): Promise<void> {
    // Instant by design — the real provider pays the Argon2 cost here.
  }

  generateTotpSecret(): string {
    this.secretCounter += 1;
    return MockAuthProvider.SECRETS[this.secretCounter % MockAuthProvider.SECRETS.length] as string;
  }

  createTotpUri(secret: string, accountId: string, email: string): string {
    const totp = new TOTP({
      issuer: 'Women AI Network',
      label: email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    return `${totp.toString()}#account=${accountId}`;
  }

  verifyTotp(secret: string, code: string, atSeconds: number): boolean {
    const expected = new TOTP({ secret, period: 30, digits: 6, algorithm: 'SHA1' });
    const atMs = atSeconds * 1000;
    const window: Array<{ timestamp: number }> = [
      { timestamp: atMs - 30_000 },
      { timestamp: atMs },
      { timestamp: atMs + 30_000 },
    ];
    return window.some((t) => expected.generate(t) === code);
  }
}
