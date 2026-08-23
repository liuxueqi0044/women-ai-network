import { z } from 'zod';
import { idSchema } from '../ids.js';
import type { ConnectionMode } from '../connection/enums.js';
import type { LetterContent, LetterRevisionSnapshot } from '../letters/index.js';
import type { InteractionGatePort } from '../connection/ports.js';

export const privateDeliveryPurposeSchema = z.enum(['private_letter_delivery']);
export type PrivateDeliveryPurpose = z.infer<typeof privateDeliveryPurposeSchema>;

export const privateDeliveryCreateRequestSchema = z
  .object({
    recipient_id: idSchema,
    letter_id: idSchema,
    revision: z.number().int().positive(),
    purpose: privateDeliveryPurposeSchema,
    consent: z.object({ explicit: z.literal(true) }).strict(),
  })
  .strict();
export type PrivateDeliveryCreateRequest = z.infer<typeof privateDeliveryCreateRequestSchema>;

export const privateDeliveryWakeupSchema = z.object({ delivery_id: idSchema }).strict();
export type PrivateDeliveryWakeup = z.infer<typeof privateDeliveryWakeupSchema>;

export const privateDeliveryEvidenceRequestSchema = z
  .object({
    category: z.enum([
      'harassment',
      'threats',
      'sexual_content',
      'hate_or_discrimination',
      'scam_or_fraud',
      'privacy_violation',
      'report',
      'other',
    ]),
  })
  .strict();
export type PrivateDeliveryEvidenceRequest = z.infer<typeof privateDeliveryEvidenceRequestSchema>;

export const privateDeliverySurfaceSchema = z.enum(['inbox', 'sent']);
export type PrivateDeliverySurface = z.infer<typeof privateDeliverySurfaceSchema>;

export const privateDeliveryListQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,512}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export interface PrivateDeliveryConnectionPort {
  currentAccepted(
    senderAccountId: string,
    recipientAccountId: string,
  ): Promise<{
    connectionId: string;
    acceptedEpoch: number;
    mode: ConnectionMode;
  } | null>;
  isCurrentAccepted(input: {
    connectionId: string;
    acceptedEpoch: number;
    senderAccountId: string;
    recipientAccountId: string;
  }): Promise<{ mode: ConnectionMode } | null>;
}

export interface PrivateDeliveryWakeupPort {
  enqueue(deliveryId: string): Promise<void>;
}

export interface PrivateDeliveryRateLimitPort {
  check(input: {
    senderAccountId: string;
    recipientAccountId: string;
    letterId: string;
  }): Promise<void>;
}

export interface PrivateDeliveryPolicyPort {
  check(input: {
    actorAccountId: string;
    subjectAccountId: string;
    mode: ConnectionMode;
    surface: 'chat' | 'notification';
    requireConnection: true;
    connectionId?: string;
    acceptedEpoch?: number;
  }): Promise<Awaited<ReturnType<InteractionGatePort['check']>>>;
}

export interface PrivateDeliverySnapshot {
  letterId: string;
  revisionId: string;
  revision: number;
  sourceHash: string;
  content: LetterContent;
}

export interface PrivateDeliveryCreateResult {
  deliveryId: string;
  senderAccountId: string;
  recipientAccountId: string;
  state: 'queued' | 'leased' | 'delivered' | 'cancelled' | 'failed';
  revision: number;
  createdAt: string;
}

export interface PrivateDeliveryLease {
  deliveryId: string;
  leaseToken: string;
  senderAccountId: string;
  recipientAccountId: string;
  connectionId: string;
  connectionEpoch: number;
  mode: ConnectionMode;
}

export interface PrivateDeliveryRepositoryPort {
  replayCreate(input: {
    senderAccountId: string;
    idempotencyKey: string;
    payload: unknown;
  }): Promise<PrivateDeliveryCreateResult | null>;
  createQueued(input: {
    senderAccountId: string;
    recipientAccountId: string;
    connectionId: string;
    connectionEpoch: number;
    mode: ConnectionMode;
    purpose: PrivateDeliveryPurpose;
    snapshot: PrivateDeliverySnapshot;
    idempotencyKey: string;
  }): Promise<PrivateDeliveryCreateResult>;
  claim(input: {
    workerId: string;
    leaseMs: number;
    deliveryId?: string;
  }): Promise<PrivateDeliveryLease | null>;
  complete(input: {
    deliveryId: string;
    leaseToken: string;
  }): Promise<'delivered' | 'cancelled' | 'stale'>;
  cancel(input: {
    deliveryId: string;
    leaseToken: string;
    reason: string;
  }): Promise<'cancelled' | 'stale'>;
  retry(input: {
    deliveryId: string;
    leaseToken: string;
    reason: string;
    retryAfterMs: number;
  }): Promise<'retrying' | 'failed' | 'stale'>;
  shouldWake(deliveryId: string): Promise<boolean>;
  /** Atomically advances due PostgreSQL wake intents and returns exact IDs to enqueue. */
  reconcileDueWakeups(limit: number): Promise<string[]>;
  dispatchOutbox(input: {
    deliveryId: string;
    recipientAccountId: string;
    allowed: boolean;
    retryable?: boolean;
  }): Promise<'dispatched' | 'cancelled' | 'retrying' | 'stale'>;
  getDeliveryContext(deliveryId: string): Promise<{
    deliveryId: string;
    senderAccountId: string;
    recipientAccountId: string;
    connectionId: string;
    connectionEpoch: number;
    mode: ConnectionMode;
    state: PrivateDeliveryCreateResult['state'];
  } | null>;
  getForRecipient(recipientAccountId: string, deliveryId: string): Promise<unknown | null>;
  getForSender(senderAccountId: string, deliveryId: string): Promise<unknown | null>;
  list(input: {
    actorAccountId: string;
    surface: PrivateDeliverySurface;
    cursor?: string;
    limit: number;
  }): Promise<{ items: unknown[]; nextCursor: string | null }>;
  markRead(recipientAccountId: string, deliveryId: string): Promise<void>;
  hide(recipientAccountId: string, deliveryId: string): Promise<void>;
  captureEvidence(input: {
    deliveryId: string;
    actorAccountId: string;
    category: string;
  }): Promise<void>;
  withdraw(input: { senderAccountId: string; deliveryId: string }): Promise<void>;
}

export interface PrivateDeliveryLetterPort {
  readOwnedRevision(
    ownerId: string,
    letterId: string,
    revision: number,
  ): Promise<LetterRevisionSnapshot | null>;
}

export type { ConnectionMode };
