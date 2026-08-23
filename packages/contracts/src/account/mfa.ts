import { z } from 'zod';
import { idSchema } from '../ids.js';
import { passwordSchema } from './account.js';

/**
 * MFA contracts (IAM-01): TOTP enrollment/confirm, recovery codes,
 * disable. Recovery codes are shown exactly once and only ever stored as
 * keyed digests server-side.
 */

export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'must be a 6-digit TOTP code');

/**
 * 16 characters from an unambiguous alphabet (no 0, 1, I, O), grouped as
 * XXXX-XXXX-XXXX-XXXX. Lowercase input is accepted and normalized to the
 * canonical uppercase form here; the server additionally normalizes before
 * digesting (defense in depth).
 */
export const recoveryCodeSchema = z
  .string()
  .regex(
    /^[2-9A-HJ-NP-Za-hj-np-z]{4}-[2-9A-HJ-NP-Za-hj-np-z]{4}-[2-9A-HJ-NP-Za-hj-np-z]{4}-[2-9A-HJ-NP-Za-hj-np-z]{4}$/,
    'must be a recovery code of the form XXXX-XXXX-XXXX-XXXX',
  )
  .transform((value) => value.toUpperCase());

export const recoveryCodesSchema = z.array(recoveryCodeSchema).length(10);

/** Enrollment requires re-verifying the current password with an AAL1 session. */
export const totpEnrollmentRequestSchema = z
  .object({
    password: passwordSchema,
  })
  .strict();

export type TotpEnrollmentRequest = z.infer<typeof totpEnrollmentRequestSchema>;

/**
 * The otpauth URI embeds the TOTP secret — returned exactly once, only on
 * enrollment start, while the factor is still `pending`.
 */
export const totpEnrollmentResponseSchema = z
  .object({
    factor_id: idSchema,
    otpauth_uri: z.string().startsWith('otpauth://totp/'),
  })
  .strict();

export type TotpEnrollmentResponse = z.infer<typeof totpEnrollmentResponseSchema>;

export const totpEnrollmentConfirmRequestSchema = z
  .object({
    totp_code: totpCodeSchema,
  })
  .strict();

export type TotpEnrollmentConfirmRequest = z.infer<typeof totpEnrollmentConfirmRequestSchema>;

/** First-time confirmation returns the 10 one-time recovery codes. */
export const totpEnrollmentConfirmResponseSchema = z
  .object({
    recovery_codes: recoveryCodesSchema,
  })
  .strict();

export type TotpEnrollmentConfirmResponse = z.infer<typeof totpEnrollmentConfirmResponseSchema>;

export const recoveryRegenerateRequestSchema = z
  .object({
    password: passwordSchema,
  })
  .strict();

export type RecoveryRegenerateRequest = z.infer<typeof recoveryRegenerateRequestSchema>;

export const recoveryRegenerateResponseSchema = z
  .object({
    recovery_codes: recoveryCodesSchema,
  })
  .strict();

export type RecoveryRegenerateResponse = z.infer<typeof recoveryRegenerateResponseSchema>;

/**
 * Disabling MFA requires the current password PLUS a fresh TOTP code or a
 * recovery code — possession of the password alone is not enough.
 */
export const totpDisableRequestSchema = z
  .object({
    password: passwordSchema,
    totp_code: totpCodeSchema.optional(),
    recovery_code: recoveryCodeSchema.optional(),
  })
  .strict()
  .refine((value) => value.totp_code !== undefined || value.recovery_code !== undefined, {
    message: 'totp_code or recovery_code is required',
  });

export type TotpDisableRequest = z.infer<typeof totpDisableRequestSchema>;

export const mfaFactorSummarySchema = z
  .object({
    factor_id: idSchema,
    type: z.literal('totp'),
    state: z.enum(['pending', 'enabled', 'disabled']),
    enabled_at: z.string().datetime().optional(),
  })
  .strict();

export type MfaFactorSummary = z.infer<typeof mfaFactorSummarySchema>;
