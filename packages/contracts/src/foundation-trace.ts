import { z } from 'zod';
import { eventIdSchema, requestIdSchema } from './ids.js';
import { SCHEMA_VERSION } from './queues.js';

/**
 * Foundation Trace — the only vertical smoke flow of FND-01.
 * Web calls the API endpoint; the API enqueues a `foundation.trace` job;
 * the Worker consumes it and logs with the same Request ID / trace context.
 * No business data is involved.
 */

/** POST /v1/foundation/trace request body. */
export const foundationTraceRequestSchema = z
  .object({
    /** Free-form echo text for smoke purposes only; never interpreted as business input. */
    message: z.string().min(1).max(500).optional(),
  })
  .strict();

export type FoundationTraceRequest = z.infer<typeof foundationTraceRequestSchema>;

/** POST /v1/foundation/trace response body. */
export const foundationTraceResponseSchema = z
  .object({
    status: z.literal('accepted'),
    event_id: eventIdSchema,
    job_id: eventIdSchema,
    request_id: requestIdSchema,
    accepted_at: z.string().datetime(),
    schema_version: z.literal(SCHEMA_VERSION),
  })
  .strict();

export type FoundationTraceResponse = z.infer<typeof foundationTraceResponseSchema>;
