import type { Job } from 'bullmq';
import { JOB_NAMES } from '@wai/contracts';
import { tryParseJobEnvelope, type JobEnvelope } from '@wai/contracts';
import {
  createRequestContextStore,
  runWithRequestContext,
  type WaiLogger,
} from '@wai/observability';
import type { TraceJobProcessor } from './types.js';

/**
 * BullMQ callback used by the Worker: routes known job names to their
 * processor and skips (with a loud warning) anything unexpected.
 * Unknown job names are never silently dropped.
 */
export async function dispatchJob(
  job: Job<unknown>,
  processor: TraceJobProcessor,
  logger: WaiLogger,
): Promise<unknown> {
  if (job.name !== JOB_NAMES.foundationTrace) {
    logger.warn(
      {
        event: 'worker.job.unknown_name',
        job_name: job.name,
        job_id: job.id ?? null,
      },
      'unknown job name — no processor registered, skipping',
    );
    return undefined;
  }
  return processor.process(job);
}

/** Runs `log` with the envelope's request context when the data is parseable. */
export function logWithEnvelopeContext(data: unknown, log: () => void): void {
  const envelope: JobEnvelope | null = tryParseJobEnvelope(data);
  if (envelope === null) {
    log();
    return;
  }
  runWithRequestContext(createRequestContextStore(envelope.request_id, envelope.traceparent), log);
}
