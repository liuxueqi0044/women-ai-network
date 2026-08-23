import { z } from 'zod';
import { idSchema } from '../ids.js';

/**
 * Device contracts (IAM-01). Devices are opaque server-issued records for
 * session hygiene only — no browser fingerprinting data ever leaves the
 * server. The public summary carries the user-set label plus a coarse
 * browser/OS summary (never the raw User-Agent).
 */

export const deviceLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !/[\r\n]/.test(value), 'label must not contain line breaks');

export const deviceSummarySchema = z
  .object({
    device_id: idSchema,
    label: deviceLabelSchema,
    summary: z.string().min(1).max(64),
    first_seen_at: z.string().datetime(),
    last_seen_at: z.string().datetime(),
    revoked_at: z.string().datetime().optional(),
  })
  .strict();

export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const deviceListResponseSchema = z
  .object({
    devices: z.array(deviceSummarySchema).max(100),
  })
  .strict();

export type DeviceListResponse = z.infer<typeof deviceListResponseSchema>;

export const deviceRenameRequestSchema = z
  .object({
    label: deviceLabelSchema,
  })
  .strict();

export type DeviceRenameRequest = z.infer<typeof deviceRenameRequestSchema>;

export const deviceRenameResponseSchema = deviceSummarySchema;
export type DeviceRenameResponse = z.infer<typeof deviceRenameResponseSchema>;

export const deviceIdParamsSchema = z
  .object({
    device_id: idSchema,
  })
  .strict();

export type DeviceIdParams = z.infer<typeof deviceIdParamsSchema>;
