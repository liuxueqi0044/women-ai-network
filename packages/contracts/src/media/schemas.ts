import { z } from 'zod';
import { idSchema } from '../ids.js';
import {
  mediaPurposeSchema,
  mediaSafeErrorSchema,
  mediaStateSchema,
  mediaTypeSchema,
  mediaVariantSchema,
} from './enums.js';

const idempotencyKeySchema = z.string().trim().min(8).max(200);
const declaredSizeSchema = z
  .number()
  .int()
  .nonnegative()
  .max(25 * 1024 * 1024);

export const mediaUploadIntentSchema = z
  .object({
    purpose: mediaPurposeSchema,
    declared_size: declaredSizeSchema,
    declared_content_type: z.string().trim().min(1).max(100).optional(),
    idempotency_key: idempotencyKeySchema,
  })
  .strict();
export type MediaUploadIntentInput = z.infer<typeof mediaUploadIntentSchema>;

export const mediaCompleteSchema = z
  .object({
    idempotency_key: idempotencyKeySchema,
  })
  .strict();
export type MediaCompleteInput = z.infer<typeof mediaCompleteSchema>;

export const mediaAccessRequestSchema = z
  .object({
    asset_id: idSchema,
    purpose: mediaPurposeSchema,
  })
  .strict();
export type MediaAccessRequest = z.infer<typeof mediaAccessRequestSchema>;

export const mediaDeleteRequestSchema = z
  .object({
    asset_id: idSchema,
    idempotency_key: idempotencyKeySchema,
  })
  .strict();

export const mediaStatusSchema = z
  .object({
    asset_id: idSchema,
    state: mediaStateSchema,
    detected_type: mediaTypeSchema.nullable(),
    rendition: z
      .object({
        variant: mediaVariantSchema,
        type: mediaTypeSchema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        bytes: z.number().int().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const mediaErrorSchema = z
  .object({
    code: mediaSafeErrorSchema,
  })
  .strict();

export const mediaUploadIntentResponseSchema = z
  .object({
    asset_id: idSchema,
    expires_at: z.string().datetime({ offset: true }),
    upload_target: z.string().url(),
  })
  .strict();

export const mediaAccessResponseSchema = z
  .object({
    capability: z.string().min(32).max(2048),
    expires_at: z.string().datetime({ offset: true }),
    content_type: mediaTypeSchema,
    bytes: z.number().int().positive(),
  })
  .strict();

export const mediaDeliveryResponseSchema = mediaAccessResponseSchema
  .extend({
    delivery_target: z.string().url(),
  })
  .strict();

export const mediaRedeemRequestSchema = z
  .object({
    token: z.string().min(32).max(2048),
    purpose: mediaPurposeSchema,
  })
  .strict();

/** BullMQ wake-up payload; it contains references only, never media bytes. */
export const mediaProcessJobSchema = z
  .object({
    job_id: idSchema,
    asset_id: idSchema,
  })
  .strict();
export type MediaProcessJob = z.infer<typeof mediaProcessJobSchema>;
