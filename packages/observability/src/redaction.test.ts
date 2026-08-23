import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE, sanitize, sanitizeText } from './redaction.js';

const SENTINEL_TOKEN = 'fake-review-token';
const SENTINEL_EMAIL = 'review-user@example.invalid';

describe('sanitize — key-based redaction', () => {
  it('redacts exact default keys', () => {
    expect(sanitize({ authorization: 'Bearer abc' })).toEqual({ authorization: REDACTED_VALUE });
    expect(sanitize({ password: 'hunter2' })).toEqual({ password: REDACTED_VALUE });
    expect(sanitize({ token: 'jwt' })).toEqual({ token: REDACTED_VALUE });
    expect(sanitize({ email: 'ada@example.com' })).toEqual({ email: REDACTED_VALUE });
    expect(sanitize({ prompt: 'write me a letter' })).toEqual({ prompt: REDACTED_VALUE });
    expect(sanitize({ message_body: 'secret body' })).toEqual({ message_body: REDACTED_VALUE });
    expect(sanitize({ precise_location: '40.7,-74.0' })).toEqual({
      precise_location: REDACTED_VALUE,
    });
    expect(sanitize({ id_number: '123456' })).toEqual({ id_number: REDACTED_VALUE });
    expect(sanitize({ document: 'passport' })).toEqual({ document: REDACTED_VALUE });
    expect(sanitize({ phone: '+1-555-0100' })).toEqual({ phone: REDACTED_VALUE });
  });

  it('matches keys case-insensitively and across separators', () => {
    const input = {
      Authorization: 'x',
      AUTHORIZATION: 'x',
      'Set-Cookie': 'x',
      setCookie: 'x',
      access_token: 'x',
      accessToken: 'x',
      ACCESS_TOKEN: 'x',
      refresh_token: 'x',
      refreshToken: 'x',
      Email: 'x',
      e_mail: 'x',
      Message_Body: 'x',
      preciseLocation: 'x',
      ID_NUMBER: 'x',
      Secret: 'x',
    };
    const output = sanitize(input) as Record<string, unknown>;
    for (const key of Object.keys(output)) {
      expect(output[key]).toBe(REDACTED_VALUE);
    }
  });

  it('redacts deeply nested objects and arrays', () => {
    const output = sanitize({
      user: { profile: { email: 'a@b.c' } },
      list: [{ token: 't1' }, { meta: { accessToken: 't2' } }],
      req: { headers: { cookie: 'session=1' } },
    }) as {
      user: { profile: { email: string } };
      list: Array<{ token: string } | { meta: { accessToken: string } }>;
      req: { headers: { cookie: string } };
    };
    expect(output.user.profile.email).toBe(REDACTED_VALUE);
    const first = output.list[0];
    expect(first !== undefined && 'token' in first && first.token).toBe(REDACTED_VALUE);
    const second = output.list[1];
    expect(second !== undefined && 'meta' in second && second.meta.accessToken).toBe(
      REDACTED_VALUE,
    );
    expect(output.req.headers.cookie).toBe(REDACTED_VALUE);
  });

  it('redacts HTTP header objects (both lower- and canonical casing)', () => {
    const output = sanitize({
      req: {
        headers: {
          authorization: 'Bearer secret-token',
          cookie: 'sid=abc',
          'set-cookie': 'sid=abc',
          'x-request-id': 'f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c',
          'content-type': 'application/json',
        },
      },
    }) as {
      req: {
        headers: {
          authorization: string;
          cookie: string;
          'set-cookie': string;
          'x-request-id': string;
          'content-type': string;
        };
      };
    };
    expect(output.req.headers.authorization).toBe(REDACTED_VALUE);
    expect(output.req.headers.cookie).toBe(REDACTED_VALUE);
    expect(output.req.headers['set-cookie']).toBe(REDACTED_VALUE);
    expect(output.req.headers['x-request-id']).toBe('f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c');
    expect(output.req.headers['content-type']).toBe('application/json');
  });

  it('redacts Error metadata while preserving sanitized message and stack (opt-in)', () => {
    const error = new Error(`boom for ${SENTINEL_EMAIL} token=${SENTINEL_TOKEN}`);
    (error as unknown as Record<string, unknown>)['token'] = 'leaked-token';
    (error as unknown as Record<string, unknown>)['email'] = 'leak@example.com';
    (error as unknown as Record<string, unknown>)['user_id'] = 'u-123';
    const output = sanitize(error, { includeErrorMessage: true }) as {
      token: string;
      email: string;
      user_id: string;
      message: string;
      stack: string;
      type: string;
    };
    expect(output.token).toBe(REDACTED_VALUE);
    expect(output.email).toBe(REDACTED_VALUE);
    expect(output.user_id).toBe('u-123');
    expect(output.message).not.toContain(SENTINEL_TOKEN);
    expect(output.message).not.toContain(SENTINEL_EMAIL);
    expect(output.message).toContain('boom');
    expect(output.stack).not.toContain(SENTINEL_TOKEN);
    expect(output.stack).not.toContain(SENTINEL_EMAIL);
    expect(typeof output.stack).toBe('string');
    expect(output.type).toBe('Error');
  });

  it('drops Error message/stack by default and keeps only type/name/stable code', () => {
    const error = new Error(`secret ${SENTINEL_EMAIL} token=${SENTINEL_TOKEN}`);
    (error as unknown as Record<string, unknown>)['code'] = 'ECONNREFUSED';
    (error as unknown as Record<string, unknown>)['user_id'] = 'u-123';
    const output = sanitize(error) as Record<string, unknown>;
    expect(output['type']).toBe('Error');
    expect(output['name']).toBe('Error');
    expect(output['code']).toBe('ECONNREFUSED');
    expect(output['user_id']).toBe('u-123');
    expect('message' in output).toBe(false);
    expect('stack' in output).toBe(false);
  });

  it('drops an Error code that is not a stable machine identifier', () => {
    const unsafe = new Error('boom');
    (unsafe as unknown as Record<string, unknown>)['code'] = `user ${SENTINEL_EMAIL} failed`;
    const output = sanitize(unsafe) as Record<string, unknown>;
    expect('code' in output).toBe(false);
  });

  it('handles circular references without hanging', () => {
    const circular: Record<string, unknown> = { name: 'a' };
    circular['self'] = circular;
    const output = sanitize(circular) as { self: string };
    expect(output.self).toBe('[Circular]');
  });

  it('does not mutate the input object', () => {
    const input = { token: 't' };
    sanitize(input);
    expect(input.token).toBe('t');
  });

  it('supports extra caller-supplied deny keys', () => {
    expect(sanitize({ api_key: 'k' }, { extraKeys: ['api_key'] })).toEqual({
      api_key: REDACTED_VALUE,
    });
    expect(sanitize({ name: 'Ada' }, { extraKeys: ['api_key'] })).toEqual({ name: 'Ada' });
  });

  it('leaves unrelated fields untouched', () => {
    expect(sanitize({ user_id: 'u-1', status: 'ok', count: 3, active: true, note: null })).toEqual({
      user_id: 'u-1',
      status: 'ok',
      count: 3,
      active: true,
      note: null,
    });
  });

  it('does not over-redact substrings (phone vs phoneNumber)', () => {
    // Exact-key matching only: `phone` is denied, `phoneNumber` is not a listed key.
    const output = sanitize({ phone: '123', phoneNumber: '123' }) as {
      phone: string;
      phoneNumber: string;
    };
    expect(output.phone).toBe(REDACTED_VALUE);
    expect(output.phoneNumber).toBe('123');
  });
});

describe('sanitize — content scanning of strings (free-text defense)', () => {
  it('replaces email addresses inside arbitrary strings', () => {
    expect(sanitize({ note: `contact ${SENTINEL_EMAIL} for support` })).toEqual({
      note: `contact ${REDACTED_VALUE} for support`,
    });
  });

  it('replaces token=value assignments in free text (case-insensitive)', () => {
    expect(
      sanitize({
        note: `request failed with Token=${SENTINEL_TOKEN} and SECRET=hunter2`,
      }),
    ).toEqual({
      note: `request failed with Token=${REDACTED_VALUE} and SECRET=${REDACTED_VALUE}`,
    });
  });

  it('replaces colon-form credentials and authorization schemes without leaking a tail', () => {
    expect(sanitizeText(`token: ${SENTINEL_TOKEN}`)).toBe(`token: ${REDACTED_VALUE}`);
    expect(sanitizeText('authorization: Bearer top-secret-token')).toBe(
      `authorization: ${REDACTED_VALUE} ${REDACTED_VALUE}`,
    );
    expect(sanitizeText('api_key : key-123')).toBe(`api_key : ${REDACTED_VALUE}`);
  });

  it('replaces labelled phone, document, prompt and encoded-email values including spaces', () => {
    expect(
      sanitizeText(
        'phone: +86 138 0013 8000; id_number=11010519491231002X; prompt=private user message',
      ),
    ).toBe(`phone: ${REDACTED_VALUE}; id_number=${REDACTED_VALUE}; prompt=${REDACTED_VALUE}`);
    expect(sanitizeText('email=review-user%40example.invalid&page=2')).toBe(
      `email=${REDACTED_VALUE}&page=2`,
    );
  });

  it('replaces bare common phone and mainland-China identity-number forms', () => {
    expect(sanitizeText('call +86 138 0013 8000 or 415-555-2671')).toBe(
      `call ${REDACTED_VALUE} or ${REDACTED_VALUE}`,
    );
    expect(sanitizeText('mobile 13800138000')).toBe(`mobile ${REDACTED_VALUE}`);
    expect(sanitizeText('identity 11010519491231002X')).toBe(`identity ${REDACTED_VALUE}`);
  });

  it('replaces sensitive query parameters in URL-shaped strings', () => {
    const raw = `/v1/health/live?token=${SENTINEL_TOKEN}&email=${SENTINEL_EMAIL}&page=2`;
    const output = sanitize({ raw_url: raw }) as { raw_url: string };
    expect(output.raw_url).toBe(
      `/v1/health/live?token=${REDACTED_VALUE}&email=${REDACTED_VALUE}&page=2`,
    );
  });

  it('replaces Bearer and Basic authorization values', () => {
    const output = sanitizeText('auth Bearer eyJhbGciOi.abc.def and Basic dXNlcjpwYXNz');
    expect(output).toBe(`auth Bearer ${REDACTED_VALUE} and Basic ${REDACTED_VALUE}`);
  });

  it('replaces JWT-shaped tokens and precise coordinate pairs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(sanitizeText(`jwt ${jwt}`)).toBe(`jwt ${REDACTED_VALUE}`);
    expect(sanitizeText('last seen at 40.7128, -74.0060 yesterday')).toBe(
      `last seen at ${REDACTED_VALUE} yesterday`,
    );
  });

  it('leaves legitimate log data untouched (timestamps, ports, identifiers, prose)', () => {
    const plain =
      '2026-08-16T10:30:00.000Z 127.0.0.1:5433 job f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c ok';
    expect(sanitizeText(plain)).toBe(plain);
    expect(sanitizeText('request completed')).toBe('request completed');
  });

  it('content-scans strings nested inside arrays and objects', () => {
    const output = sanitize({
      list: [`a ${SENTINEL_EMAIL} b`],
      deep: { x: { y: `token=${SENTINEL_TOKEN}` } },
    }) as { list: string[]; deep: { x: { y: string } } };
    expect(output.list[0]).toBe(`a ${REDACTED_VALUE} b`);
    expect(output.deep.x.y).toBe(`token=${REDACTED_VALUE}`);
  });
});
