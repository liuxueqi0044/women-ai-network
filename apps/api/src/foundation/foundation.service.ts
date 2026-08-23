import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ERROR_CODES,
  JOB_NAMES,
  SCHEMA_VERSION,
  foundationTraceResponseSchema,
  jobEnvelopeSchema,
  type FoundationTraceRequest,
  type FoundationTraceResponse,
} from '@wai/contracts';
import { getRequestContext } from '@wai/observability';
import { QUEUE_ADAPTER } from '../tokens.js';
import type { QueueProducerAdapter } from '../infra/adapters.js';

/**
 * Foundation Trace — the FND-01 vertical smoke flow.
 * Accepts a request, wraps it in a validated job envelope carrying the
 * current request id + traceparent, and enqueues a `foundation.trace` job
 * whose BullMQ jobId equals the event_id (queue-level deduplication).
 */
@Injectable()
export class FoundationService {
  constructor(@Inject(QUEUE_ADAPTER) private readonly queue: QueueProducerAdapter) {}

  async acceptTrace(request: FoundationTraceRequest): Promise<FoundationTraceResponse> {
    const store = getRequestContext();
    if (store === undefined) {
      throw new Error(
        'request context missing — foundation trace requires an HTTP request context',
      );
    }

    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();

    // Validate before enqueueing: the worker must never receive a malformed envelope.
    const envelope = jobEnvelopeSchema.parse({
      schema_version: SCHEMA_VERSION,
      event_id: eventId,
      request_id: store.requestId,
      ...(store.traceparent === undefined ? {} : { traceparent: store.traceparent }),
      occurred_at: occurredAt,
      payload: request,
    });

    try {
      await this.queue.enqueue(JOB_NAMES.foundationTrace, envelope, {
        jobId: eventId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      });
    } catch {
      throw new ServiceUnavailableException({
        code: ERROR_CODES.QUEUE_UNAVAILABLE,
        message: 'Queue unavailable',
      });
    }

    return foundationTraceResponseSchema.parse({
      status: 'accepted',
      event_id: eventId,
      job_id: eventId,
      request_id: store.requestId,
      accepted_at: occurredAt,
      schema_version: SCHEMA_VERSION,
    });
  }
}
