import { z } from 'zod';
import { idSchema } from '../ids.js';

/**
 * Account registration (IAM-01).
 *
 * Registration proves nothing about age, gender or membership — it only
 * creates an account that CAN authenticate. Payloads are strictly limited
 * to email + password: age/birthday/gender/identity_document/member_verified
 * fields are rejected by `.strict()`.
 */

export const emailSchema = z
  .string()
  .max(320)
  .refine((value) => z.string().email().safeParse(value).success, 'must be a valid email address');

/**
 * 12–128 Unicode code points. No forced composition rules — Unicode input
 * is allowed (see IAM-01 task book §2.1); length counts code points, not
 * UTF-16 units, so astral characters cannot bypass the minimum.
 */
export const passwordSchema = z.string().refine((value) => {
  const length = [...value].length;
  return length >= 12 && length <= 128;
}, 'password must be between 12 and 128 Unicode code points');

export const accountStateSchema = z.enum(['enabled', 'suspended', 'deletion_pending', 'deleted']);

export const registrationRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export type RegistrationRequest = z.infer<typeof registrationRequestSchema>;

/**
 * Uniform response for BOTH a new account and a duplicate registration:
 * the response carries a freshly generated UUID that is never the real
 * account id of an existing account, so registration cannot be used to
 * enumerate existing accounts.
 */
export const registrationResponseSchema = z
  .object({
    account_id: idSchema,
    state: z.literal('enabled'),
  })
  .strict();

export type RegistrationResponse = z.infer<typeof registrationResponseSchema>;
