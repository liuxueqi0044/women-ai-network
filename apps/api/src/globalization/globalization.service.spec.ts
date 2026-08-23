import { describe, expect, it, vi } from 'vitest';
import { GlobalizationService } from './globalization.service.js';
import {
  GlobalizationIdempotencyConflictError,
  GlobalizationTimeZoneError,
  GlobalizationVersionConflictError,
} from '@wai/db';

const config = { iam: { secretPepper: 'c'.repeat(64) } } as never;
const value = {
  account_id: '00000000-0000-4000-8000-000000000001',
  ui_locale: 'en',
  content_locales: ['en'],
  time_zone: 'UTC',
  hour_cycle: 'h23',
  week_start: 1,
  version: 1,
  updated_at: '2026-01-01T00:00:00.000Z',
} as const;

describe('GlobalizationService', () => {
  it('binds replacement to the account and returns a parsed contract', async () => {
    const repo = { replace: vi.fn().mockResolvedValue({ value, replayed: false }), read: vi.fn() };
    const service = new GlobalizationService(repo, config, {
      consume: vi.fn().mockResolvedValue({ allowed: true }),
    });
    await expect(
      service.replace(
        value.account_id,
        {
          ui_locale: 'en',
          content_locales: ['en'],
          time_zone: 'UTC',
          hour_cycle: 'h23',
          week_start: 1,
        },
        0,
        'k'.repeat(16),
      ),
    ).resolves.toMatchObject({ version: 1 });
    expect(repo.replace).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: value.account_id, expectedVersion: 0 }),
    );
  });
  it('preserves stable conflict semantics for replay and stale versions', async () => {
    const limiter = { consume: vi.fn().mockResolvedValue({ allowed: true }) };
    const service = new GlobalizationService(
      {
        replace: vi.fn().mockRejectedValue(new GlobalizationIdempotencyConflictError()),
        read: vi.fn(),
      },
      config,
      limiter,
    );
    await expect(
      service.replace(
        value.account_id,
        {
          ui_locale: 'en',
          content_locales: [],
          time_zone: 'UTC',
          hour_cycle: 'h23',
          week_start: 1,
        },
        0,
        'k'.repeat(16),
      ),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
    const stale = new GlobalizationService(
      {
        replace: vi.fn().mockRejectedValue(new GlobalizationVersionConflictError()),
        read: vi.fn(),
      },
      config,
      limiter,
    );
    await expect(
      stale.replace(
        value.account_id,
        {
          ui_locale: 'en',
          content_locales: [],
          time_zone: 'UTC',
          hour_cycle: 'h23',
          week_start: 1,
        },
        0,
        'k'.repeat(16),
      ),
    ).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
  });
  it('maps database timezone rejection to the published client code', async () => {
    const service = new GlobalizationService(
      { replace: vi.fn().mockRejectedValue(new GlobalizationTimeZoneError()), read: vi.fn() },
      config,
      { consume: vi.fn().mockResolvedValue({ allowed: true }) },
    );
    await expect(
      service.replace(
        value.account_id,
        {
          ui_locale: 'en',
          content_locales: [],
          time_zone: 'Mars/Nope',
          hour_cycle: 'h23',
          week_start: 1,
        },
        0,
        'k'.repeat(16),
      ),
    ).rejects.toMatchObject({ response: { code: 'INVALID_TIME_ZONE' } });
  });
  it('uses the shared mutation limiter without limiting reads', async () => {
    const limiter = {
      consume: vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 9 }),
    };
    const service = new GlobalizationService(
      { replace: vi.fn(), read: vi.fn().mockResolvedValue(value) },
      config,
      limiter,
    );
    await expect(
      service.replace(
        value.account_id,
        {
          ui_locale: 'en',
          content_locales: [],
          time_zone: 'UTC',
          hour_cycle: 'h23',
          week_start: 1,
        },
        0,
        'k'.repeat(16),
      ),
    ).rejects.toMatchObject({ status: 429, response: { code: 'RATE_LIMITED' } });
    await expect(service.read(value.account_id)).resolves.toMatchObject({ version: 1 });
    expect(limiter.consume).toHaveBeenCalledTimes(1);
  });
});
