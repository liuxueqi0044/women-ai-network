import type { Job } from 'bullmq';

/**
 * Adapter interfaces for the Worker's side effects — business code never
 * touches BullMQ Job details or the Valkey SDK directly.
 */

export interface TraceJobProcessor {
  process(job: Job<unknown>): Promise<unknown>;
}

export interface TraceResultRecord {
  request_id: string;
  trace_id?: string;
  processed_at: string;
  attempt: number;
}

export interface TraceResultStore {
  /**
   * Atomic idempotent commit of the authoritative smoke side effect — the
   * short-term result record. Implemented as a single `SET key JSON NX EX`
   * write: `'committed'` means THIS call created the record (first write),
   * `'already_exists'` means a result was committed before (retry,
   * duplicate or concurrent execution).
   *
   * There is deliberately no separate claim step: a claim written before
   * the side effect leaves a crash window in which a retry would be
   * mistaken for "already processed" and the event permanently skipped.
   * Committing the result atomically makes the guard and the side effect
   * one operation.
   *
   * FND-01 smoke contract only. Future business jobs must NOT treat a
   * plain SET NX as a complete exactly-once scheme — database writes need
   * unique constraints/transactions/outbox plus downstream idempotency
   * keys (see trace.processor.ts).
   */
  commitResult(
    eventId: string,
    result: TraceResultRecord,
    ttlSeconds: number,
  ): Promise<'committed' | 'already_exists'>;
  close(): Promise<void>;
}
