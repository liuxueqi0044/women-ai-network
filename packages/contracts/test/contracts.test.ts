import { describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  errorEnvelopeSchema,
  foundationTraceRequestSchema,
  foundationTraceResponseSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  parseJobEnvelope,
  requestIdSchema,
  traceparentSchema,
  tryParseJobEnvelope,
} from '../src/index.js';
import { worldCursorSchema, worldDiscoveryQuerySchema } from '../src/world-discovery/index.js';

const REQUEST_ID = 'f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c';
const EVENT_ID = 'a1b2c3d4-6b2a-4e12-9a1c-2d3e4f5a6b7d';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('WLD-01 contracts', () => {
  it('rejects wildcard and oversized searches', () => {
    expect(worldDiscoveryQuerySchema.safeParse({ q: 'a*b' }).success).toBe(false);
    expect(worldDiscoveryQuerySchema.safeParse({ q: 'x'.repeat(121) }).success).toBe(false);
  });
  it('accepts only closed country/topic filters', () => {
    expect(worldDiscoveryQuerySchema.safeParse({ country: 'USA' }).success).toBe(false);
    expect(worldDiscoveryQuerySchema.safeParse({ topic: 'invalid' }).success).toBe(false);
  });
  it('normalizes an empty search and rejects malformed strict cursor boundaries', () => {
    expect(worldDiscoveryQuerySchema.parse({ q: '' }).q).toBeUndefined();
    expect(
      worldDiscoveryQuerySchema.safeParse({ cursor: 'payload.with.extra.segments' }).success,
    ).toBe(false);
    expect(
      worldDiscoveryQuerySchema.safeParse({ cursor: `${'a'.repeat(2049)}.${'b'.repeat(64)}` })
        .success,
    ).toBe(false);
    const base = {
      version: 1 as const,
      algorithm: 'fresh-diverse-v1' as const,
      viewer: '00000000-0000-4000-8000-000000000001',
      filters: { country: null, locale: null, topic: null, q: null, limit: 20 },
      as_of: '2026-08-15T12:00:00.000Z',
      expires_at: '2026-08-15T12:10:00.000Z',
      boundary: {
        publication_id: '00000000-0000-4000-8000-000000000002',
        published_at: '2026-08-15T12:00:00.000Z',
      },
    };
    expect(worldCursorSchema.safeParse(base).success).toBe(true);
    expect(
      worldCursorSchema.safeParse({
        ...base,
        boundary: { ...base.boundary, bookmark_at: base.as_of },
      }).success,
    ).toBe(false);
    expect(worldCursorSchema.safeParse({ ...base, unexpected: true }).success).toBe(false);
  });
});

describe('ids', () => {
  it('accepts lowercase UUID v4 request ids', () => {
    expect(requestIdSchema.parse(REQUEST_ID)).toBe(REQUEST_ID);
  });

  it('rejects non-v4 UUIDs', () => {
    expect(() => requestIdSchema.parse('f0b4f0b4-6b2a-1e12-9a1c-2d3e4f5a6b7c')).toThrow();
  });

  it('rejects uppercase and non-canonical forms', () => {
    expect(() => requestIdSchema.parse(REQUEST_ID.toUpperCase())).toThrow();
    expect(() => requestIdSchema.parse('not-a-uuid')).toThrow();
    expect(() => requestIdSchema.parse('')).toThrow();
  });

  it('accepts a valid W3C traceparent and rejects malformed ones', () => {
    expect(traceparentSchema.parse(TRACEPARENT)).toBe(TRACEPARENT);
    expect(() =>
      traceparentSchema.parse('00-zz4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'),
    ).toThrow();
    expect(() => traceparentSchema.parse('x-request-id')).toThrow();
    expect(() => traceparentSchema.parse('')).toThrow();
  });
});

describe('health DTOs', () => {
  it('accepts a live response and rejects unknown keys', () => {
    expect(
      healthLiveResponseSchema.parse({ status: 'alive', timestamp: '2026-08-15T12:00:00.000Z' }),
    ).toBeTruthy();
    expect(() =>
      healthLiveResponseSchema.parse({
        status: 'alive',
        timestamp: '2026-08-15T12:00:00.000Z',
        host: 'db',
      }),
    ).toThrow();
  });

  it('rejects a non-literal status on live', () => {
    expect(() =>
      healthLiveResponseSchema.parse({ status: 'ok', timestamp: '2026-08-15T12:00:00.000Z' }),
    ).toThrow();
  });

  it('accepts ready with all checks up', () => {
    const parsed = healthReadyResponseSchema.parse({
      status: 'ready',
      checks: { postgres: 'up', valkey: 'up', queue: 'up' },
      timestamp: '2026-08-15T12:00:00.000Z',
    });
    expect(parsed.status).toBe('ready');
  });

  it('rejects checks with unknown dependency names or unknown states', () => {
    expect(() =>
      healthReadyResponseSchema.parse({
        status: 'ready',
        checks: { postgres: 'up', valkey: 'up', queue: 'up', redis: 'up' },
        timestamp: '2026-08-15T12:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      healthReadyResponseSchema.parse({
        status: 'ready',
        checks: { postgres: 'up', valkey: 'weird', queue: 'up' },
        timestamp: '2026-08-15T12:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects missing checks', () => {
    expect(() =>
      healthReadyResponseSchema.parse({
        status: 'ready',
        checks: { postgres: 'up' },
        timestamp: '2026-08-15T12:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('error envelope', () => {
  it('accepts a minimal envelope and an envelope with details', () => {
    expect(
      errorEnvelopeSchema.parse({
        code: 'NOT_FOUND',
        message: 'Not found',
        request_id: REQUEST_ID,
      }),
    ).toBeTruthy();
    expect(
      errorEnvelopeSchema.parse({
        code: 'VALIDATION_ERROR',
        message: 'Invalid payload',
        details: ['message: too long'],
        request_id: REQUEST_ID,
      }),
    ).toBeTruthy();
  });

  it('rejects missing request_id — every error must be traceable', () => {
    expect(() => errorEnvelopeSchema.parse({ code: 'NOT_FOUND', message: 'x' })).toThrow();
  });

  it('rejects unknown error codes and unknown keys', () => {
    expect(() =>
      errorEnvelopeSchema.parse({ code: 'TEAPOT', message: 'x', request_id: REQUEST_ID }),
    ).toThrow();
    expect(() =>
      errorEnvelopeSchema.parse({
        code: 'NOT_FOUND',
        message: 'x',
        request_id: REQUEST_ID,
        stack: 'y',
      }),
    ).toThrow();
  });

  it('rejects non-string details entries', () => {
    expect(() =>
      errorEnvelopeSchema.parse({
        code: 'BAD_REQUEST',
        message: 'x',
        details: [{ path: 'a' }],
        request_id: REQUEST_ID,
      }),
    ).toThrow();
  });
});

describe('foundation trace request/response', () => {
  it('accepts an empty body (strict) and a body with a message', () => {
    expect(foundationTraceRequestSchema.parse({})).toEqual({});
    expect(foundationTraceRequestSchema.parse({ message: 'smoke' })).toEqual({ message: 'smoke' });
  });

  it('rejects unknown keys, non-string and over-long messages', () => {
    expect(() => foundationTraceRequestSchema.parse({ msg: 'x' })).toThrow();
    expect(() => foundationTraceRequestSchema.parse({ message: 42 })).toThrow();
    expect(() => foundationTraceRequestSchema.parse({ message: 'a'.repeat(501) })).toThrow();
    expect(() => foundationTraceRequestSchema.parse({ message: '' })).toThrow();
  });

  it('accepts a well-formed response', () => {
    const parsed = foundationTraceResponseSchema.parse({
      status: 'accepted',
      event_id: EVENT_ID,
      job_id: EVENT_ID,
      request_id: REQUEST_ID,
      accepted_at: '2026-08-15T12:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    });
    expect(parsed.job_id).toBe(parsed.event_id);
  });

  it('rejects a response with a mismatched schema version', () => {
    expect(() =>
      foundationTraceResponseSchema.parse({
        status: 'accepted',
        event_id: EVENT_ID,
        job_id: EVENT_ID,
        request_id: REQUEST_ID,
        accepted_at: '2026-08-15T12:00:00.000Z',
        schema_version: '0.0.1',
      }),
    ).toThrow();
  });
});

describe('job envelope', () => {
  const validEnvelope = {
    schema_version: SCHEMA_VERSION,
    event_id: EVENT_ID,
    request_id: REQUEST_ID,
    traceparent: TRACEPARENT,
    occurred_at: '2026-08-15T12:00:00.000Z',
    payload: {},
  };

  it('accepts a valid envelope and round-trips through parseJobEnvelope', () => {
    const parsed = parseJobEnvelope(validEnvelope);
    expect(parsed.event_id).toBe(EVENT_ID);
    expect(parsed.traceparent).toBe(TRACEPARENT);
  });

  it('accepts an envelope without traceparent (direct enqueue path)', () => {
    const { traceparent: _omit, ...withoutTraceparent } = validEnvelope;
    expect(parseJobEnvelope(withoutTraceparent).traceparent).toBeUndefined();
  });

  it('rejects invalid payloads instead of silently accepting them', () => {
    expect(() => parseJobEnvelope({ ...validEnvelope, request_id: 'garbage' })).toThrow();
    expect(() => parseJobEnvelope({ ...validEnvelope, traceparent: 'not-w3c' })).toThrow();
    expect(() => parseJobEnvelope({ ...validEnvelope, schema_version: '9.9.9' })).toThrow();
    expect(() => parseJobEnvelope({ ...validEnvelope, extra_field: true })).toThrow();
    expect(() => parseJobEnvelope(undefined)).toThrow();
    expect(() => parseJobEnvelope(null)).toThrow();
    expect(() => parseJobEnvelope('{}')).toThrow();
  });

  it('tryParseJobEnvelope returns null instead of throwing', () => {
    expect(tryParseJobEnvelope(validEnvelope)?.event_id).toBe(EVENT_ID);
    expect(tryParseJobEnvelope({ nope: true })).toBeNull();
    expect(tryParseJobEnvelope(undefined)).toBeNull();
  });

  it('rejects non-ISO occurred_at values', () => {
    expect(() => parseJobEnvelope({ ...validEnvelope, occurred_at: 'yesterday' })).toThrow();
  });
});
