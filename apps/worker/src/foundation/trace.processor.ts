import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { AppConfig } from '@wai/config';
import { jobEnvelopeSchema, type JobEnvelope } from '@wai/contracts';
import {
  createRequestContextStore,
  parseTraceparent,
  runWithRequestContext,
  type WaiLogger,
} from '@wai/observability';
import { APP_CONFIG, APP_LOGGER, TRACE_RESULT_STORE } from '../tokens.js';
import type { TraceJobProcessor, TraceResultRecord, TraceResultStore } from './types.js';

export interface TraceProcessOutcome {
  processed: boolean;
  attempt: number;
}

/**
 * Consumer of the `foundation.trace` smoke job.
 *
 * Idempotency model (FND-01):
 * - The AUTHORITATIVE side effect of this smoke job is the short-term
 *   result record, committed by ONE atomic `SET resultKey JSON NX EX`
 *   write (`commitResult`). The structured `foundation.trace.processed`
 *   log line is an auxiliary observable effect, not durable state.
 * - First commit wins: the winner runs the auxiliary side effect and
 *   returns processed=true. Any later attempt (BullMQ retry, duplicate
 *   enqueue, concurrent execution) observes `already_exists`, logs
 *   `foundation.trace.already_processed` and repeats NOTHING.
 * - Crash windows: before the commit nothing durable exists, so a retry
 *   simply commits successfully. After the commit the work is complete,
 *   and a retry only recognizes it. No "claimed but unfinished" state
 *   can exist.
 *
 * This model is deliberately specific to the smoke job. Future business
 * jobs MUST NOT copy a bare SET NX as an exactly-once scheme: real side
 * effects (database writes, external calls) require unique constraints,
 * transactions/outbox, and downstream idempotency keys. The result record
 * here is the side effect itself, which is why the atomic write suffices.
 */
@Injectable()
export class TraceProcessor implements TraceJobProcessor {
  constructor(
    @Inject(APP_LOGGER) private readonly logger: WaiLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(TRACE_RESULT_STORE) private readonly store: TraceResultStore,
  ) {}

  async process(job: Job<unknown>): Promise<TraceProcessOutcome> {
    // Throws ZodError for malformed envelopes — never silently processed.
    const envelope: JobEnvelope = jobEnvelopeSchema.parse(job.data);
    const attempt = job.attemptsMade + 1;

    return runWithRequestContext(
      createRequestContextStore(envelope.request_id, envelope.traceparent),
      async () => {
        const parsed =
          envelope.traceparent === undefined ? null : parseTraceparent(envelope.traceparent);
        const result: TraceResultRecord = {
          request_id: envelope.request_id,
          ...(parsed === null ? {} : { trace_id: parsed.traceId }),
          processed_at: new Date().toISOString(),
          attempt,
        };

        // Atomic commit = guard + authoritative side effect in one step.
        const outcome = await this.store.commitResult(
          envelope.event_id,
          result,
          this.config.foundationTraceResultTtlSeconds,
        );

        if (outcome === 'already_exists') {
          this.logger.warn(
            {
              event: 'foundation.trace.already_processed',
              event_id: envelope.event_id,
              attempt,
            },
            'event result already committed — completed without repeating the side effect',
          );
          return { processed: false, attempt };
        }

        // Auxiliary observable side effect: a structured log line carrying
        // the propagated request_id/trace_id (merged by the logger from the
        // active context).
        this.logger.info(
          {
            event: 'foundation.trace.processed',
            event_id: envelope.event_id,
            attempt,
            job_id: job.id ?? null,
          },
          'foundation trace processed',
        );

        return { processed: true, attempt };
      },
    );
  }
}
