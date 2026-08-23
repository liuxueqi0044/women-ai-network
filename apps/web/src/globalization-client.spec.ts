import { describe, expect, it, vi } from 'vitest';
import {
  putGlobalizationPreferences,
  getGlobalizationPreferences,
} from './globalization-client.js';

const preference = {
  account_id: '00000000-0000-4000-8000-000000000001',
  ui_locale: 'fr' as const,
  content_locales: ['fr'],
  time_zone: 'Europe/Paris',
  hour_cycle: 'h24' as const,
  week_start: 0,
  version: 4,
  updated_at: '2026-01-01T00:00:00.000Z',
};
const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('authoritative globalization HTTP client', () => {
  it('hydrates via session GET and sends If-Match, Origin and a strong idempotency key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, preference));
    await expect(getGlobalizationPreferences(fetchImpl)).resolves.toMatchObject({ version: 4 });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/v1/globalization/preferences'),
      expect.objectContaining({ credentials: 'include' }),
    );
    const putFetch = vi.fn().mockResolvedValue(response(200, preference));
    await putGlobalizationPreferences(
      {
        ui_locale: 'fr',
        content_locales: ['fr', 'fr'],
        time_zone: 'Europe/Paris',
        hour_cycle: 'h24',
        week_start: 0,
      },
      3,
      { fetchImpl: putFetch, origin: 'https://web.example', idempotencyKey: 'k'.repeat(32) },
    );
    const init = putFetch.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('if-match')).toBe('"3"');
    expect(new Headers(init.headers).get('origin')).toBe('https://web.example');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('k'.repeat(32));
    expect(JSON.parse(String(init.body)).content_locales).toEqual(['fr']);
  });
  it('preserves stable HTTP error status and code for replay/conflict', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(409, {
        code: 'VERSION_CONFLICT',
        message: 'stale',
        request_id: 'f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c',
      }),
    );
    await expect(
      putGlobalizationPreferences(
        {
          ui_locale: 'en',
          content_locales: [],
          time_zone: 'UTC',
          hour_cycle: 'h23',
          week_start: 1,
        },
        1,
        { fetchImpl, idempotencyKey: 'x'.repeat(16) },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
    });
  });
  it('keeps invalid content locales as a client validation error before network', async () => {
    const fetchImpl = vi.fn();
    await expect(
      putGlobalizationPreferences(
        {
          ui_locale: 'en',
          content_locales: ['not a locale'],
          time_zone: 'UTC',
          hour_cycle: 'h23',
          week_start: 1,
        },
        0,
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
