import type { CapabilityCode } from '../eligibility/enums.js';
import type { SafetySurface } from '../safety/index.js';
import type { ConnectionMode, ConnectionState } from './enums.js';
import type { ConnectionListQuery, ConnectionResponse } from './schemas.js';

export type InteractionGateCapability = CapabilityCode;
export type InteractionGateDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'COMMUNITY_ACCESS_DENIED'
        | 'PARTITION_DENIED'
        | 'ACTIVE_BLOCK'
        | 'POLICY_UNAVAILABLE';
    };

export interface InteractionGatePort {
  check(input: {
    actorAccountId: string;
    subjectAccountId: string;
    capability: InteractionGateCapability;
    mode: ConnectionMode;
    surface: SafetySurface;
    requireConnection?: boolean;
    connectionId?: string;
    acceptedEpoch?: number;
  }): Promise<InteractionGateDecision>;
}

export interface ConnectionRow {
  id: string;
  requesterAccountId: string;
  recipientAccountId: string;
  mode: ConnectionMode;
  state: ConnectionState;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt?: Date;
  disconnectedAt?: Date;
}

export interface ConnectionRepositoryPort {
  replayCreateRequest(input: {
    actorAccountId: string;
    recipientAccountId: string;
    mode: ConnectionMode;
    idempotencyKey: string;
  }): Promise<ConnectionRow | null>;
  createRequest(input: {
    actorAccountId: string;
    recipientAccountId: string;
    mode: ConnectionMode;
    idempotencyKey: string;
  }): Promise<ConnectionRow>;
  replayTransition(input: {
    connectionId: string;
    actorAccountId: string;
    action: 'accept' | 'decline' | 'cancel' | 'disconnect';
    idempotencyKey: string;
  }): Promise<ConnectionRow | null>;
  getForActor(connectionId: string, actorAccountId: string): Promise<ConnectionRow | null>;
  listForActor(
    actorAccountId: string,
    query?: ConnectionListQuery,
  ): Promise<{ rows: ConnectionRow[]; nextCursor: string | null }>;
  transition(input: {
    connectionId: string;
    actorAccountId: string;
    action: 'accept' | 'decline' | 'cancel' | 'disconnect';
    idempotencyKey: string;
  }): Promise<ConnectionRow>;
}

export interface ProfileRelationshipGraphPort {
  relationship(
    viewerAccountId: string,
    subjectAccountId: string,
  ): Promise<{ relationship: 'none' | 'connection' }>;
  /** Exact connection identity used by connection-bound InteractionGate checks. */
  getForActor(connectionId: string, actorAccountId: string): Promise<ConnectionRow | null>;
}

export type { ConnectionMode, ConnectionState, ConnectionResponse };
