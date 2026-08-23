/**
 * ELG-01 application ports (task book §7). Types come from @wai/contracts —
 * services depend on these interfaces only, never on Postgres/OPA/crypto
 * implementations directly.
 */
export type {
  AgeBand,
  AgeCredentialIssuer,
  AgeCredentialService,
  AgeCredentialView,
  AgeModePolicyDecisionPort,
  AgePartitionDecisionPort,
  AssuranceLevel,
  DecisionOutput,
  JurisdictionPolicySelection,
  JurisdictionPolicySelector,
  ModeDecisionInput,
  Obligation,
  PartitionDecisionInput,
  PolicyDocument,
  ReasonCode,
} from '@wai/contracts';
