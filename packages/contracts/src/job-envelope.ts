import { z } from 'zod';
import { eventIdSchema, requestIdSchema, traceparentSchema } from './ids.js';
import { SCHEMA_VERSION } from './queues.js';

/**
 * Standard envelope for every job that flows API → Queue → Worker.
 * `schema_version` reserves the evolution path without a schema registry.
 *
 * The BullMQ job id MUST equal `event_id`: queue-level deduplication plus
 * idempotent consumption guarantees that retries of the same event never
 * produce duplicate side effects.
 */
export const jobEnvelopeSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    event_id: eventIdSchema,
    request_id: requestIdSchema,
    /** W3C traceparent captured when the API accepted the request. Optional for direct enqueues. */
    traceparent: traceparentSchema.optional(),
    occurred_at: z.string().datetime(),
    /** Job-specific payload, validated by the producing/consuming contract. */
    payload: z.unknown(),
  })
  .strict();

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;

/** Parses and returns a job envelope, throwing a ZodError on invalid payloads. */
export function parseJobEnvelope(value: unknown): JobEnvelope {
  return jobEnvelopeSchema.parse(value);
}

/** Safe parser used at the Worker boundary to reject malformed jobs before processing. */
export function tryParseJobEnvelope(value: unknown): JobEnvelope | null {
  const result = jobEnvelopeSchema.safeParse(value);
  return result.success ? result.data : null;
}
