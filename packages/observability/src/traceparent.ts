import { randomBytes } from 'node:crypto';

/**
 * W3C `traceparent` helpers. The traceparent string is the single source of
 * truth for cross-process trace propagation in FND-01 (Web → API → Queue →
 * Worker), independent of whether the OpenTelemetry SDK is enabled.
 *
 * Format: {version 2hex}-{traceId 32hex}-{spanId 16hex}-{flags 2hex}
 */

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  spanId: string;
  flags: string;
}

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function parseTraceparent(value: string | undefined): ParsedTraceparent | null {
  if (value === undefined) {
    return null;
  }
  const match = TRACEPARENT_REGEX.exec(value.toLowerCase());
  if (match === null) {
    return null;
  }
  const [, version, traceId, spanId, flags] = match;
  if (version !== '00') {
    return null;
  }
  if (traceId === undefined || spanId === undefined || flags === undefined) {
    return null;
  }
  if (/^0{32}$/.test(traceId) || /^0{16}$/.test(spanId)) {
    return null; // all-zero ids are invalid per the W3C spec
  }
  return { version, traceId, spanId, flags };
}

/** Creates a fresh, valid traceparent with sampled flag 01. */
export function createTraceparent(): string {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return `00-${traceId}-${spanId}-01`;
}
