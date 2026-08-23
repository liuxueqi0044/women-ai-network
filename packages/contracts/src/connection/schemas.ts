import { z } from 'zod';
import { idSchema } from '../ids.js';
import { connectionModeSchema, connectionStateSchema } from './enums.js';

export const connectionRequestSchema = z
  .object({ recipient_account_id: idSchema, mode: connectionModeSchema })
  .strict();
export type ConnectionRequest = z.infer<typeof connectionRequestSchema>;

export const connectionActionRequestSchema = z.object({}).strict();

const iso = z.string().datetime({ offset: true });
export const connectionResponseSchema = z
  .object({
    id: idSchema,
    requester_account_id: idSchema,
    recipient_account_id: idSchema,
    mode: connectionModeSchema,
    state: connectionStateSchema,
    version: z.number().int().nonnegative(),
    created_at: iso,
    updated_at: iso,
    accepted_at: iso.optional(),
    disconnected_at: iso.optional(),
  })
  .strict();
export type ConnectionResponse = z.infer<typeof connectionResponseSchema>;

export const connectionListResponseSchema = z
  .object({
    connections: z.array(connectionResponseSchema).max(100),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type ConnectionListResponse = z.infer<typeof connectionListResponseSchema>;

export const connectionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .min(1)
      .max(512)
      .optional(),
  })
  .strict();
export type ConnectionListQuery = z.infer<typeof connectionListQuerySchema>;
