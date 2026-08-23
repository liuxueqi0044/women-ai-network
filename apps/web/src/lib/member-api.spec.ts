import { describe, expect, it, vi } from 'vitest';
import {
  MemberApiError,
  describeMemberApiError,
  makeIdempotencyKey,
  memberApi,
} from './member-api.js';

describe('member API client', () => {
  it('uses the versioned base, credentials, JSON body and caller headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      memberApi<{ ok: boolean }>('/profile/me', 'PUT', {
        body: { display_name: 'Amina' },
        headers: { 'idempotency-key': 'test-key', 'if-match': '"2"' },
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/profile\/me$/),
      expect.objectContaining({ method: 'PUT', credentials: 'include' }),
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(init.headers).get('idempotency-key')).toBe('test-key');
    expect(JSON.parse(String(init.body))).toEqual({ display_name: 'Amina' });
  });

  it('does not send a JSON content type or body for an empty DELETE', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(memberApi<null>('/account/session', 'DELETE', { fetchImpl })).resolves.toBeNull();
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it('keeps stable HTTP status and domain error code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'VERSION_CONFLICT', message: 'stale write' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(memberApi('/profile/me', 'GET', { fetchImpl })).rejects.toEqual(
      new MemberApiError(409, 'VERSION_CONFLICT', 'stale write'),
    );
  });

  it('creates a high-entropy key without storing it in browser state', () => {
    expect(makeIdempotencyKey().length).toBeGreaterThanOrEqual(64);
    expect(makeIdempotencyKey()).not.toBe(makeIdempotencyKey());
  });

  it('turns a disconnected API into a useful product message', () => {
    expect(describeMemberApiError(new TypeError('Failed to fetch'))).toContain(
      'temporarily unavailable',
    );
  });
});
