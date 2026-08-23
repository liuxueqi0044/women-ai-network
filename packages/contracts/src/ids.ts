import { z } from 'zod';

/**
 * Request / event identifiers shared across Web, API and Worker.
 * RFC 4122 UUID v4, lowercase, canonical string form.
 */
export const idSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'must be a lowercase UUID v4',
  );

export const requestIdSchema = idSchema;
export const eventIdSchema = idSchema;

/**
 * W3C trace context `traceparent` header value:
 *   version(2hex) - traceId(32hex, non-zero) - spanId(16hex) - flags(2hex)
 */
export const traceparentSchema = z
  .string()
  .regex(
    /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    'must be a W3C traceparent header value',
  );

export type RequestId = z.infer<typeof requestIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type Traceparent = z.infer<typeof traceparentSchema>;
