import type {
  AgePartition,
  Audience,
  FactSensitivity,
  FactValueKind,
  MatchingMode,
  ProfileState,
  Relationship,
} from './enums.js';
import type { ProfileView } from './schemas.js';

export interface ProfileFactDefinition {
  factKey: string;
  valueKind: FactValueKind;
  sensitivity: FactSensitivity;
  allowedModes: readonly MatchingMode[];
  defaultAudience: Audience;
  aiOnly: boolean;
}

export interface ProfileFactRecord {
  factKey: string;
  value: string | boolean | number;
  sensitivity: FactSensitivity;
  state: 'proposed' | 'confirmed' | 'withdrawn';
  source: 'user_confirmed' | 'approved_draft';
  confirmedAt: Date;
}

export interface ProfileRecord {
  profileId: string;
  accountId: string;
  displayName: string;
  city?: string;
  countryCode?: string;
  state: ProfileState;
  version: number;
  facts: readonly ProfileFactRecord[];
}

/** PRF-owned, purpose-bound facts for internal matching only. This view never
 * carries profile identity, hidden values, or facts without explicit audience
 * and matching-use consent. */
export interface ProfileMatchingSafeFact {
  factKey: string;
  value: string | boolean | number;
  visible: boolean;
  policyVersion: string;
}
export interface ProfileMatchingSafeCard {
  displayName: string;
}
export interface ProfileMatchingSafeViewPort {
  matchingFacts(input: {
    subjectAccountId: string;
    viewerAccountId: string;
    mode: MatchingMode;
    purpose: 'matching';
  }): Promise<{
    version: string;
    facts: readonly ProfileMatchingSafeFact[];
  }>;
  matchingCard(input: {
    subjectAccountId: string;
    viewerAccountId: string;
    mode: MatchingMode;
    purpose: 'matching';
  }): Promise<ProfileMatchingSafeCard | null>;
}

/** Frozen result returned by a mutation, including on idempotent replay. */
export interface ProfileMutationResult {
  profileId: string;
  version: number;
  state: ProfileState;
}

export interface ProfileRepositoryPort {
  getOrCreate(accountId: string): Promise<ProfileRecord>;
  findByProfileId(profileId: string): Promise<ProfileRecord | null>;
  updateProfile(input: {
    accountId: string;
    expectedVersion: number;
    idempotencyKey: string;
    payloadDigest: string;
    displayName: string;
    city?: string;
    countryCode?: string;
  }): Promise<ProfileMutationResult>;
  putFact(input: {
    accountId: string;
    factKey: string;
    value: string | boolean | number;
    source: 'user_confirmed' | 'approved_draft';
    expectedVersion: number;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<ProfileMutationResult>;
  withdrawFact(input: {
    accountId: string;
    factKey: string;
    expectedVersion: number;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<ProfileMutationResult>;
  setFactUsage(input: {
    accountId: string;
    factKey: string;
    mode: MatchingMode;
    matchingEnabled: boolean;
    expectedVersion: number;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<ProfileMutationResult>;
  setFactAudience(input: {
    accountId: string;
    factKey: string;
    mode: MatchingMode;
    audience: Audience;
    agePartition: AgePartition;
    expectedVersion: number;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<ProfileMutationResult>;
  publish(
    accountId: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<{
    profile: ProfileRecord;
    snapshotId: string;
    contentHash: string;
    publishedAt: Date;
  }>;
  getSnapshot(accountId: string, snapshotId: string): Promise<ProfileView | null>;
  appendSensitiveAudit(input: {
    actorAccountId: string;
    subjectAccountId: string;
    factKey: string;
    purpose: string;
    decision: string;
    policyVersion: string;
  }): Promise<void>;
  getAudience(
    accountId: string,
    factKey: string,
    mode: MatchingMode,
  ): Promise<{
    audience: Audience;
    agePartition: AgePartition;
  } | null>;
  isMatchingEnabled(accountId: string, factKey: string, mode: MatchingMode): Promise<boolean>;
  matchingFacts(input: {
    subjectAccountId: string;
    viewerAccountId: string;
    mode: MatchingMode;
    purpose: 'matching';
  }): Promise<{
    version: string;
    facts: readonly ProfileMatchingSafeFact[];
  }>;
  matchingCard(input: {
    subjectAccountId: string;
    viewerAccountId: string;
    mode: MatchingMode;
    purpose: 'matching';
  }): Promise<ProfileMatchingSafeCard | null>;
}

export interface ProfileVisibilityDecisionPort {
  decide(input: {
    viewerAccountId: string;
    subjectAccountId: string;
    relationship: Relationship;
    mode: MatchingMode;
    viewerAgePartition: AgePartition;
    subjectAgePartition: AgePartition;
    viewerCommunity: 'eligible' | 'limited' | 'denied';
    subjectCommunity: 'eligible' | 'limited' | 'denied';
    ownerBypass?: boolean;
  }): {
    allowProfile: boolean;
    allowFact: (fact: ProfileFactRecord, audience: Audience, agePartition: AgePartition) => boolean;
  };
}

export interface ProfileCommunityAccessPort {
  decide(
    accountId: string,
    capability: string,
  ): Promise<{ decision: 'limited' | 'eligible' | 'denied' }>;
}

export interface ProfileAgePartitionPort {
  self(accountId: string): Promise<{ ageBand: string } | null>;
  decide(
    actorAccountId: string,
    subjectAccountId: string,
    capability: string,
  ): Promise<{
    decision: 'allow' | 'deny';
    actorAgeBand: string;
    subjectAgeBand: string;
  }>;
}

export interface ProfileRelationshipPort {
  decide(
    viewerAccountId: string,
    subjectAccountId: string,
  ): Promise<{ relationship: 'none' | 'member' | 'connection' }>;
}
