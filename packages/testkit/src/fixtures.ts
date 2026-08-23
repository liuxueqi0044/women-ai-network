import { randomBytes, randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, type FoundationTraceRequest, type JobEnvelope } from '@wai/contracts';

/** UUID v4 request id, matching the format accepted by @wai/contracts. */
export function makeRequestId(): string {
  return randomUUID();
}

/** UUID v4 event id. */
export function makeEventId(): string {
  return randomUUID();
}

/** Fresh valid W3C traceparent (version 00, sampled). */
export function makeTraceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

/** A minimal valid Foundation Trace request body. */
export function makeFoundationTraceRequest(
  overrides: Partial<FoundationTraceRequest> = {},
): FoundationTraceRequest {
  return { message: 'integration smoke', ...overrides };
}

/** A valid job envelope; ids default to fresh values and can be pinned. */
export function makeJobEnvelope(overrides: Partial<JobEnvelope> = {}): JobEnvelope {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    event_id: makeEventId(),
    request_id: makeRequestId(),
    traceparent: makeTraceparent(),
    occurred_at: now,
    payload: {},
    ...overrides,
  };
}

/** URL parts for BullMQ/ioredis from a test Valkey container. */
export function valkeyConnectionParts(valkey: { host: string; port: number; password: string }): {
  host: string;
  port: number;
  password: string;
} {
  return { host: valkey.host, port: valkey.port, password: valkey.password };
}
