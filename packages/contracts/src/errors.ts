import { z } from 'zod';
import { requestIdSchema } from './ids.js';
import { ACCOUNT_ERROR_CODES } from './account/errors.js';
import { GLOBALIZATION_ERROR_CODES } from './globalization/errors.js';

/**
 * Stable error codes for the global API error envelope.
 * Never expose stack traces, connection strings or internal messages here.
 * IAM-01 account codes merge in from account/errors.js — only add, never
 * rename or remove a published code.
 */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  QUEUE_UNAVAILABLE: 'QUEUE_UNAVAILABLE',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** IAM-01: login/registration accept JSON only (rejected before parsing). */
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  MEDIA_NOT_FOUND: 'MEDIA_NOT_FOUND',
  MEDIA_ACCESS_DENIED: 'MEDIA_ACCESS_DENIED',
  MEDIA_CONFLICT: 'MEDIA_CONFLICT',
  MEDIA_INVALID_UPLOAD: 'MEDIA_INVALID_UPLOAD',
  MEDIA_PROVIDER_UNAVAILABLE: 'MEDIA_PROVIDER_UNAVAILABLE',
  LETTER_CONFLICT: 'LETTER_CONFLICT',
  LETTER_STATE_INVALID: 'LETTER_STATE_INVALID',
  LETTER_POLICY_DENIED: 'LETTER_POLICY_DENIED',
  CIRCLE_CONFLICT: 'CIRCLE_CONFLICT',
  ...ACCOUNT_ERROR_CODES,
  ...GLOBALIZATION_ERROR_CODES,
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const errorCodeSchema = z.enum(Object.values(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

/**
 * Global error envelope returned by the API for every failure.
 * `details` carries machine-readable validation issues (strings only —
 * anything structured must go through an explicit contract first).
 */
export const errorEnvelopeSchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1).max(500),
    details: z.array(z.string().max(1000)).max(50).optional(),
    request_id: requestIdSchema,
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
