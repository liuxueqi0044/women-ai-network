import type { IntroductionDecision, IntroductionMode, IntroductionReasonCode } from './enums.js';
import type { IntroductionHistoryResponse } from './schemas.js';

export type IntroductionGateDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'POLICY_DENIED' | 'ACCOUNT_STATE_DENIED' | 'ACTIVE_BLOCK' | 'CONNECTION_EXISTS';
    };
export interface IntroductionPolicyGate {
  check(input: {
    actorAccountId: string;
    subjectAccountId: string;
    mode: IntroductionMode;
    allowExistingMutual?: boolean;
  }): Promise<IntroductionGateDecision>;
}
export interface IntroductionCandidateRecord {
  id: string;
  batchId: string;
  actorAccountId: string;
  subjectAccountId: string;
  mode: IntroductionMode;
  reasons: readonly IntroductionReasonCode[];
  visibleFacts: readonly string[];
  score: number;
  decision: IntroductionDecision | null;
  actorDecisionAt: Date | null;
  subjectDecisionAt: Date | null;
  outcome: 'mutual' | 'none' | null;
  subjectCard?: { displayName: string };
}
export interface IntroductionBatchRecord {
  id: string;
  accountId: string;
  mode: IntroductionMode;
  algorithmVersion: string;
  configVersion: string;
  createdAt: Date;
  refreshAfter: Date;
}
export interface IntroductionRepositoryPort {
  currentBatch(
    accountId: string,
    mode: IntroductionMode,
    now?: Date,
  ): Promise<IntroductionBatchRecord | null>;
  createBatch(input: {
    accountId: string;
    mode: IntroductionMode;
    limit: number;
    now?: Date;
  }): Promise<IntroductionBatchRecord>;
  listCandidates(input: {
    accountId: string;
    batchId: string;
    mode: IntroductionMode;
    limit: number;
    cursor?: string;
  }): Promise<{
    rows: IntroductionCandidateRecord[];
    nextCursor: string | null;
    batch: IntroductionBatchRecord;
  }>;
  findCandidate(
    actorAccountId: string,
    introductionId: string,
  ): Promise<IntroductionCandidateRecord | null>;
  canRecoverMutual(input: {
    actorAccountId: string;
    introductionId: string;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<boolean>;
  decide(input: {
    actorAccountId: string;
    introductionId: string;
    batchId: string;
    decision: IntroductionDecision;
    idempotencyKey: string;
    payloadDigest: string;
    actorProof: string;
  }): Promise<{
    row: IntroductionCandidateRecord;
    outcome: 'mutual' | 'none' | null;
    actorProof: string;
    subjectProof: string | null;
  }>;
  history(input: {
    accountId: string;
    limit: number;
    cursor?: string;
  }): Promise<IntroductionHistoryResponse>;
}
export interface ConnectionMaterializationPort {
  materializeMutualIntroduction(input: {
    introductionId: string;
    actorAccountId: string;
    subjectAccountId: string;
    mode: IntroductionMode;
    actorProof: string;
    subjectProof: string;
    subjectIntroductionId: string;
    actorDecisionDigest: string;
    subjectDecisionDigest: string;
    idempotencyKey: string;
    currentGate: (input: { allowExistingMutual: boolean }) => Promise<boolean>;
  }): Promise<{ outcome: 'mutual'; connectionReference: string }>;
}
export interface IntroductionExplanationPort {
  render(input: {
    mode: IntroductionMode;
    reasons: readonly IntroductionReasonCode[];
    visibleFacts: readonly string[];
  }): Promise<string>;
}
