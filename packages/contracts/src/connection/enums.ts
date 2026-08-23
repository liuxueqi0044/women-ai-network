import { z } from 'zod';

export const connectionModeSchema = z.enum([
  'friends',
  'activities',
  'professional',
  'circles',
  'events',
  'dating',
]);
export type ConnectionMode = z.infer<typeof connectionModeSchema>;

export const connectionStateSchema = z.enum([
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'disconnected',
  'invalidated',
]);
export type ConnectionState = z.infer<typeof connectionStateSchema>;

export const connectionErrorCodeSchema = z.enum([
  'CONNECTION_NOT_FOUND',
  'CONNECTION_TERMINAL',
  'CONNECTION_INVALIDATED',
  'CONNECTION_ACTION_FORBIDDEN',
  'IDEMPOTENCY_CONFLICT',
  'INTERACTION_DENIED',
  'SELF_CONNECTION_FORBIDDEN',
]);
export type ConnectionErrorCode = z.infer<typeof connectionErrorCodeSchema>;

export function canTransitionConnection(from: ConnectionState, to: ConnectionState): boolean {
  if (from === to) return true;
  const allowed: Record<ConnectionState, readonly ConnectionState[]> = {
    pending: ['accepted', 'declined', 'cancelled'],
    accepted: ['disconnected', 'invalidated'],
    declined: [],
    cancelled: [],
    disconnected: [],
    invalidated: [],
  };
  return allowed[from].includes(to);
}
