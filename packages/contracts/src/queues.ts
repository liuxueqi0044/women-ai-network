import { z } from 'zod';
import { idSchema } from './ids.js';

/**
 * Centralized queue and job names. All apps MUST use these constants —
 * literal queue names in app code are a contract violation.
 */
export const QUEUE_NAMES = {
  /** Single FND-01 queue; business queues arrive with later modules. */
  foundation: 'foundation',
  media: 'media',
  privateDelivery: 'private-delivery',
  translation: 'translation',
  notifications: 'notifications',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_NAMES = {
  /** Smoke job with no business meaning. */
  foundationTrace: 'foundation.trace',
  mediaProcess: 'media.process',
  privateDeliveryWakeup: 'private-delivery.wakeup',
  translationProcess: 'translation.process',
  messagingWakeup: 'messaging.wakeup',
  notificationWakeup: 'notifications.wakeup',
} as const;

export const translationProcessJobSchema = z.object({ task_id: idSchema }).strict();
export const messagingWakeupJobSchema = z
  .object({ conversation_id: idSchema, message_id: idSchema })
  .strict();
export const notificationWakeupJobSchema = z.object({ intent_id: idSchema }).strict();

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * Current schema version for all FND-01 contracts. Bump deliberately when a
 * contract changes incompatibly; consumers validate envelopes against it.
 */
export const SCHEMA_VERSION = '1.0.0' as const;
