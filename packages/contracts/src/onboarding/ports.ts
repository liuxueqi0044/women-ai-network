import type {
  OnboardingMode,
  OnboardingPurpose,
  ProposalState,
  ConsentRetention,
} from './enums.js';
import type { OnboardingPreference } from './schemas.js';

export interface OnboardingModeGate {
  decide(accountId: string, mode: OnboardingMode): Promise<boolean>;
}
export interface OnboardingProviderConsent {
  consentId: string;
  accountId: string;
  purpose: OnboardingPurpose;
  provider: string;
  receiptVersion: number;
  retention: ConsentRetention;
  granted: boolean;
  withdrawnAt: Date | null;
}
export interface MinimizedOnboardingPrompt {
  purpose: OnboardingPurpose;
  modes: readonly OnboardingMode[];
  answers: readonly string[];
}
export interface OnboardingExtraction {
  confidence: number;
  provenance: string;
  preferences: readonly OnboardingPreference[];
}
export interface OnboardingProvider {
  readonly name: string;
  extract(prompt: MinimizedOnboardingPrompt): Promise<OnboardingExtraction>;
}
export interface OnboardingSessionRecord {
  sessionId: string;
  accountId: string;
  purpose: OnboardingPurpose;
  modes: readonly OnboardingMode[];
  modesVersion: number;
  datingEnabled: boolean;
  state: 'active' | 'completed' | 'withdrawn';
  version: number;
  answerRevision: number;
}
export interface OnboardingProposalRecord {
  proposalId: string;
  sessionId: string;
  accountId: string;
  purpose: OnboardingPurpose;
  mode: OnboardingMode;
  answerRevision: number;
  modesVersion: number;
  state: ProposalState;
  expiresAt: Date;
  confidence: number;
  provenance: string;
  preferences: readonly OnboardingPreference[];
  proposalVersion: number;
}
export interface OnboardingPreferencesRecord {
  accountId: string;
  purpose: OnboardingPurpose;
  version: number;
  modes: readonly OnboardingMode[];
  modesVersion: number;
  preferences: readonly OnboardingPreference[];
  confirmedAt: Date;
}
export interface OnboardingRepositoryPort {
  createSession(input: {
    accountId: string;
    purpose: OnboardingPurpose;
    modes: readonly OnboardingMode[];
    datingEnabled: boolean;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingSessionRecord>;
  currentSession(
    accountId: string,
    purpose: OnboardingPurpose,
  ): Promise<OnboardingSessionRecord | null>;
  appendAnswer(input: {
    accountId: string;
    sessionId: string;
    purpose: OnboardingPurpose;
    mode: OnboardingMode;
    expectedRevision: number;
    text: string;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingSessionRecord>;
  answerTexts(
    accountId: string,
    sessionId: string,
    purpose: OnboardingPurpose,
    mode?: OnboardingMode,
  ): Promise<string[]>;
  saveProposal(input: {
    accountId: string;
    sessionId: string;
    purpose: OnboardingPurpose;
    mode: OnboardingMode;
    answerRevision: number;
    modesVersion: number;
    extraction: OnboardingExtraction;
    expiresAt: Date;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingProposalRecord>;
  getProposal(accountId: string, proposalId: string): Promise<OnboardingProposalRecord | null>;
  currentPendingProposal(
    accountId: string,
    purpose: OnboardingPurpose,
  ): Promise<OnboardingProposalRecord | null>;
  withAuthorizedProviderDispatch(
    input: {
      accountId: string;
      purpose: OnboardingPurpose;
      provider: string;
      consentId: string;
      receiptVersion: number;
      idempotencyKey: string;
      payloadDigest: string;
      sessionId: string;
      mode: OnboardingMode;
      answerRevision: number;
      modesVersion: number;
      expiresAt: Date;
    },
    dispatch: () => Promise<OnboardingExtraction>,
  ): Promise<OnboardingProposalRecord>;
  confirm(input: {
    accountId: string;
    proposalId: string;
    sessionId: string;
    purpose: OnboardingPurpose;
    expectedVersion: number;
    expectedAnswerRevision: number;
    modesVersion: number;
    preferences: readonly OnboardingPreference[];
    modes: readonly OnboardingMode[];
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingPreferencesRecord>;
  correct(input: {
    accountId: string;
    proposalId: string;
    sessionId: string;
    purpose: OnboardingPurpose;
    expectedVersion: number;
    expectedProposalVersion: number;
    field: string;
    correction: string;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<{ proposalId: string; proposalVersion: number }>;
  currentPreferences(
    accountId: string,
    purpose: OnboardingPurpose,
  ): Promise<OnboardingPreferencesRecord | null>;
  replacePreferences(input: {
    accountId: string;
    purpose: OnboardingPurpose;
    expectedVersion: number;
    modesVersion: number;
    modes: readonly OnboardingMode[];
    mode: OnboardingMode;
    preferences: readonly OnboardingPreference[];
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingPreferencesRecord>;
  saveConsent(input: {
    accountId: string;
    purpose: OnboardingPurpose;
    provider: string;
    receiptVersion: number;
    retention: ConsentRetention;
    granted: boolean;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingProviderConsent>;
  currentConsent(
    accountId: string,
    purpose: OnboardingPurpose,
    provider: string,
  ): Promise<OnboardingProviderConsent | null>;
}
