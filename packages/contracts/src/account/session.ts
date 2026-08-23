import { z } from 'zod';
import { idSchema } from '../ids.js';
import { emailSchema, passwordSchema } from './account.js';
import { recoveryCodeSchema } from './mfa.js';

/**
 * Session contracts (IAM-01).
 *
 * Session tokens NEVER appear in any request/response body — they travel
 * exclusively in the HttpOnly cookie. Every response here only exposes
 * stable ids, auth level, expiry times and the session state enum.
 */

export const authLevelSchema = z.enum(['aal1', 'aal2']);

export const sessionStateSchema = z.enum(['active', 'rotated', 'revoked', 'compromised']);

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * MFA completion: exactly one of totp_code / recovery_code must be present.
 * Codes are case-normalized by the server before comparison.
 */
export const mfaLoginRequestSchema = z
  .object({
    totp_code: z
      .string()
      .regex(/^\d{6}$/, 'must be a 6-digit TOTP code')
      .optional(),
    recovery_code: recoveryCodeSchema.optional(),
  })
  .strict()
  .refine((value) => value.totp_code !== undefined || value.recovery_code !== undefined, {
    message: 'totp_code or recovery_code is required',
  });

export type MfaLoginRequest = z.infer<typeof mfaLoginRequestSchema>;

const isoDateTimeSchema = z.string().datetime();

/**
 * Public session summary. `device_id` is omitted (not null) when the
 * session has no device — with exactOptionalPropertyTypes the wire format
 * and the TS type stay in sync.
 */
export const sessionSummarySchema = z
  .object({
    session_id: idSchema,
    account_id: idSchema,
    auth_level: authLevelSchema,
    state: sessionStateSchema,
    created_at: isoDateTimeSchema,
    last_seen_at: isoDateTimeSchema,
    idle_expires_at: isoDateTimeSchema,
    absolute_expires_at: isoDateTimeSchema,
    device_id: idSchema.optional(),
  })
  .strict();

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

/** Issued on login / rotate / mfa completion — the new session summary. */
export const sessionResponseSchema = sessionSummarySchema;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const sessionListResponseSchema = z
  .object({
    sessions: z.array(sessionSummarySchema).max(100),
  })
  .strict();

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const sessionIdParamsSchema = z
  .object({
    session_id: idSchema,
  })
  .strict();

export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
