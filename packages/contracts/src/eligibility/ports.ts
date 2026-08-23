import type { AgeBand, AssuranceLevel, ReasonCode, Obligation } from './enums.js';
import type {
  DecisionOutput,
  ModeDecisionInput,
  PartitionDecisionInput,
  PolicyDocument,
} from './opa.js';

/**
 * ELG-01 internal ports (task book §7). Implementations live behind these
 * interfaces: application services never talk to Postgres, OPA or crypto
 * directly. All ports are PII-safe — account IDs never cross into OPA inputs.
 */

/** Policy selected for one account + effective instant (DB-backed, CP2+). */
export interface JurisdictionPolicySelection {
  policy_id: string;
  jurisdiction_key: string;
  revision: number;
  timezone: string;
  effective_from: string;
  effective_until: string;
  /** Immutable content hash of the stored policy document (decision anchor). */
  content_hash: string;
  /** Derived non-PII document ready for the OPA input. */
  document: PolicyDocument;
}

export interface JurisdictionPolicySelector {
  /**
   * Selects the subdivision policy active at `effectiveAt`, falling back to
   * the country policy. Returns null when there is no active approved
   * policy for the account's current declaration.
   */
  select(accountId: string, effectiveAt: string): Promise<JurisdictionPolicySelection | null>;
}

/** Current credential as seen by status responses and decision snapshots. */
export interface AgeCredentialView {
  credential_id: string;
  age_band: AgeBand;
  cohort_key: string;
  assurance_level: AssuranceLevel;
  valid_from: string;
  valid_until: string;
}

/** Session-facing credential lifecycle (public age-declaration endpoint). */
export interface AgeCredentialService {
  /**
   * Declares a birth date, encrypts the evidence and issues (or replaces)
   * the account's current credential. Never returns or logs the birth date.
   */
  declare(accountId: string, birthDate: string): Promise<AgeCredentialView>;
  current(accountId: string): Promise<AgeCredentialView | null>;
}

/**
 * Internal credential issuer. Only this interface may create
 * `externally_attested` credentials — the public HTTP contract cannot claim
 * verification. VER-01 will deliver attested evidence through this port.
 */
export interface AgeCredentialIssuer {
  issue(
    accountId: string,
    evidenceId: string,
    assuranceLevel: AssuranceLevel,
  ): Promise<AgeCredentialView>;

  /** VER-01 only: the DOB is process-memory input and Eligibility owns all persistence. */
  issueExternalAttestation(input: {
    accountId: string;
    evidenceId: string;
    verificationCaseId: string;
    attestationDigest: string;
    birthDate: string;
    assuranceExpiresAt: string;
  }): Promise<AgeCredentialView>;
}

/**
 * Single-subject mode decision. Engine failures (timeout, non-2xx,
 * malformed output) are NOT thrown — the adapter converts them into a
 * fail-closed deny carrying POLICY_ENGINE_UNAVAILABLE / POLICY_OUTPUT_INVALID.
 */
export interface AgeModePolicyDecisionPort {
  decide(input: ModeDecisionInput): Promise<DecisionOutput>;
}

/** Two-party partition decision (internal — for Matching/Chat/Events, never a public query API). */
export interface AgePartitionDecisionPort {
  decide(input: PartitionDecisionInput): Promise<DecisionOutput>;
}

/** Re-exported decision vocabulary for service-layer typing. */
export type {
  AgeBand,
  AssuranceLevel,
  DecisionOutput,
  ModeDecisionInput,
  PartitionDecisionInput,
  PolicyDocument,
  ReasonCode,
  Obligation,
};
