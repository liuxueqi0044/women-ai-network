import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Temporal } from '@js-temporal/polyfill';
import {
  partitionDecisionInputSchema,
  type AgeBand,
  type AgePartitionDecisionPort,
  type AssuranceLevel,
  type CapabilityCode,
  type JurisdictionPolicySelection,
  type JurisdictionPolicySelector,
  type PartitionDecisionInput,
  type ReasonCode,
} from '@wai/contracts';
import {
  canonicalJsonHash,
  type AgeCredentialRepository,
  type AgeCredentialRow,
  type AgeEvidenceRepository,
  type JurisdictionDeclarationRepository,
  type PartitionDecisionRepository,
  type PartitionDecisionRow,
  type PolicyEventRepository,
} from '@wai/db';
import { ageInYears, isWithinValidity, localDateAt, parseBirthDate } from '../domain/age.js';
import { derivePartitionDecisionId, ENGINE_VERSION } from '../domain/decision.js';
import { deriveAgeBand, deriveCohortKey } from '../domain/policy.js';
import {
  AGE_PARTITION_DECISION_PORT,
  BIRTHDAY_CIPHER,
  ELG_CLOCK,
  ELG_REPOSITORIES,
  JURISDICTION_POLICY_SELECTOR,
} from '../eligibility.tokens.js';
import type { BirthdayCipher } from '../infra/eligibility-secret-cipher.js';
import type { ElgClock } from '../infra/elg-clock.js';

/**
 * Clock-skew tolerance for a client-supplied effective_at: evaluating
 * strictly in the future would mint a decision that only holds later, so it
 * is rejected before any snapshot exists (same discipline as mode
 * evaluations, dto.ts).
 */
const FUTURE_EFFECTIVE_AT_SKEW_MS = 5 * 60 * 1000;

export interface PartitionDecisionRequest {
  capability: CapabilityCode;
  /** Defaults to now at the service layer; must not be a future-replay. */
  effective_at?: string;
}

/** Derived two-party result — the internal port's response for downstream consumers. */
export interface PartitionDecisionView {
  decision_id: string;
  decision: 'allow' | 'deny';
  capability: CapabilityCode;
  actor_age_band: AgeBand;
  actor_cohort_key: string;
  subject_age_band: AgeBand;
  subject_cohort_key: string;
  reason_codes: ReasonCode[];
  actor_policy: { policy_id: string; revision: number; policy_hash: string };
  subject_policy: { policy_id: string; revision: number; policy_hash: string };
  input_hash: string;
  evaluated_at: string;
  engine_version: number;
}

interface SideFacts {
  selection: JurisdictionPolicySelection;
  credential: AgeCredentialRow;
  /** Derived, PII-free subject document for the OPA input. */
  subject: {
    age_years: number;
    age_band: AgeBand;
    cohort_key: string;
    assurance_level: AssuranceLevel;
  };
}

/**
 * Two-party partition decisions (task book §7 internal AgePartitionDecisionPort
 * — never a public query API; Matching/Chat/Events consume it downstream).
 *
 * Both parties are loaded symmetrically: declaration → policy selection at
 * the effective instant → credential → decrypted evidence. Each side's age
 * facts are recomputed with Temporal in its OWN policy timezone (the stored
 * credential facts are a derivation snapshot and go stale on a birthday), so
 * a party is never evaluated against another jurisdiction's calendar. The
 * decrypted birthdays exist only transiently in memory — the OPA input,
 * snapshot and response carry derived cohort facts only. Engine failures
 * degrade into a deny snapshot + evaluation_failure event, never an
 * exception and never an accidental allow.
 */
@Injectable()
export class PartitionDecisionService {
  constructor(
    @Inject(ELG_REPOSITORIES)
    private readonly deps: {
      jurisdictionDeclarations: Pick<JurisdictionDeclarationRepository, 'current'>;
      ageEvidence: Pick<AgeEvidenceRepository, 'current'>;
      ageCredentials: Pick<AgeCredentialRepository, 'current'>;
      partitionDecisions: PartitionDecisionRepository;
      policyEvents: Pick<PolicyEventRepository, 'append'>;
    },
    @Inject(JURISDICTION_POLICY_SELECTOR)
    private readonly selector: JurisdictionPolicySelector,
    @Inject(BIRTHDAY_CIPHER)
    private readonly cipher: BirthdayCipher,
    @Inject(ELG_CLOCK)
    private readonly clock: ElgClock,
    @Inject(AGE_PARTITION_DECISION_PORT)
    private readonly decider: AgePartitionDecisionPort,
  ) {}

  async decide(
    actorAccountId: string,
    subjectAccountId: string,
    request: PartitionDecisionRequest,
  ): Promise<PartitionDecisionView> {
    const now = this.clock.now();
    const effectiveAt = request.effective_at ?? now.toISOString();
    if (new Date(effectiveAt).getTime() > now.getTime() + FUTURE_EFFECTIVE_AT_SKEW_MS) {
      throw badRequest('effective_at_in_future');
    }

    const actor = await this.loadSide(actorAccountId, effectiveAt);
    const subject = await this.loadSide(subjectAccountId, effectiveAt);

    const input: PartitionDecisionInput = {
      actor_policy: actor.selection.document,
      subject_policy: subject.selection.document,
      actor: actor.subject,
      subject: subject.subject,
      request: { capability: request.capability, effective_at: effectiveAt },
    };
    // Defense in depth: an input that fails the strict contract is a
    // programming error — fail loudly, never evaluate a half-formed document.
    const parsedInput = partitionDecisionInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new Error(`partition decision input failed validation: ${parsedInput.error.message}`);
    }

    const inputHash = canonicalJsonHash(input);
    const decisionId = derivePartitionDecisionId({
      actor_account_id: actorAccountId,
      subject_account_id: subjectAccountId,
      capability: request.capability,
      effective_at: effectiveAt,
      actor_policy_id: actor.selection.policy_id,
      subject_policy_id: subject.selection.policy_id,
      actor_credential_id: actor.credential.id,
      subject_credential_id: subject.credential.id,
      input_hash: inputHash,
    });

    const output = await this.decider.decide(input);

    const snapshot: PartitionDecisionRow = {
      decisionId,
      actorAccountId,
      subjectAccountId,
      actorAgeBand: actor.subject.age_band,
      actorCohortKey: actor.subject.cohort_key,
      subjectAgeBand: subject.subject.age_band,
      subjectCohortKey: subject.subject.cohort_key,
      capability: request.capability,
      decision: output.decision,
      reasonCodes: output.reason_codes,
      actorPolicyId: actor.selection.policy_id,
      subjectPolicyId: subject.selection.policy_id,
      actorPolicyRevision: actor.selection.revision,
      subjectPolicyRevision: subject.selection.revision,
      actorPolicyHash: actor.selection.content_hash,
      subjectPolicyHash: subject.selection.content_hash,
      inputHash,
      evaluatedAt: new Date(effectiveAt),
      engineVersion: ENGINE_VERSION,
      createdAt: now,
    };

    const { row } = await this.deps.partitionDecisions.insertIfAbsent(snapshot);

    if (isEngineFailure(output.decision, output.reason_codes)) {
      await this.deps.policyEvents.append({
        eventType: 'evaluation_failure',
        policyId: actor.selection.policy_id,
        jurisdictionKey: actor.selection.jurisdiction_key,
        accountId: actorAccountId,
        reason: output.reason_codes.join(','),
        metadata: { capability: request.capability, decision_id: decisionId },
        now,
      });
    }

    return toView(row);
  }

  private async loadSide(accountId: string, effectiveAt: string): Promise<SideFacts> {
    const declaration = await this.deps.jurisdictionDeclarations.current(accountId);
    if (declaration === null) {
      throw badRequest('jurisdiction_required');
    }
    if (declaration.reviewState !== 'accepted') {
      throw badRequest('jurisdiction_review_required');
    }
    const selection = await this.selector.select(accountId, effectiveAt);
    if (selection === null) {
      throw badRequest('no_active_jurisdiction_policy');
    }
    const credential = await this.deps.ageCredentials.current(accountId);
    if (credential === null) {
      throw badRequest('age_declaration_required');
    }
    const effectiveDate = new Date(effectiveAt);
    if (!isWithinValidity(credential.validFrom, credential.validUntil, effectiveDate)) {
      throw badRequest('age_credential_not_valid_at_effective_at');
    }
    if (
      credential.jurisdictionPolicyId !== selection.policy_id ||
      credential.jurisdictionKey !== selection.jurisdiction_key ||
      credential.policyRevision !== selection.revision
    ) {
      throw badRequest('age_credential_policy_mismatch');
    }
    const evidence = await this.deps.ageEvidence.current(accountId);
    if (evidence === null) {
      throw new Error('partition decision: current credential without current evidence');
    }
    if (credential.sourceEvidenceId !== evidence.id) {
      throw badRequest('age_credential_evidence_mismatch');
    }
    const birthDate = this.cipher.decrypt({
      ciphertext: evidence.birthdayCiphertext,
      nonce: evidence.birthdayNonce,
      keyId: evidence.birthdayKeyId,
    });
    const localDay = localDateAt(Temporal.Instant.from(effectiveAt), selection.timezone);
    let ageYears = ageInYears(parseBirthDate(birthDate), localDay);
    if (ageYears < 0) {
      // Effective instant before the account was born: the subject document
      // cannot carry a negative age (schema floor is 0) — it is below the
      // minimum age either way, so clamp deterministically to the deny path.
      ageYears = 0;
    }
    return {
      selection,
      credential,
      subject: {
        age_years: ageYears,
        age_band: deriveAgeBand(
          ageYears,
          selection.document.minimum_account_age,
          selection.document.age_of_majority,
        ),
        cohort_key: deriveCohortKey(
          ageYears,
          selection.document.minimum_account_age,
          selection.document.age_of_majority,
        ),
        assurance_level: credential.assuranceLevel,
      },
    };
  }
}

function isEngineFailure(decision: 'allow' | 'deny', reasonCodes: readonly string[]): boolean {
  return (
    decision === 'deny' &&
    (reasonCodes.includes('POLICY_ENGINE_UNAVAILABLE') ||
      reasonCodes.includes('POLICY_OUTPUT_INVALID'))
  );
}

function toView(row: PartitionDecisionRow): PartitionDecisionView {
  return {
    decision_id: row.decisionId,
    decision: row.decision,
    capability: row.capability,
    actor_age_band: row.actorAgeBand,
    actor_cohort_key: row.actorCohortKey,
    subject_age_band: row.subjectAgeBand,
    subject_cohort_key: row.subjectCohortKey,
    // Whitelist invariant: the adapter's strict output schema and the DB
    // CHECK both bound the codes — the row cannot carry an unknown one.
    reason_codes: row.reasonCodes as ReasonCode[],
    actor_policy: {
      policy_id: row.actorPolicyId,
      revision: row.actorPolicyRevision,
      policy_hash: row.actorPolicyHash,
    },
    subject_policy: {
      policy_id: row.subjectPolicyId,
      revision: row.subjectPolicyRevision,
      policy_hash: row.subjectPolicyHash,
    },
    input_hash: row.inputHash,
    evaluated_at: row.evaluatedAt.toISOString(),
    engine_version: row.engineVersion,
  };
}

function badRequest(message: string): HttpException {
  return new HttpException({ code: 'VALIDATION_ERROR', message }, 400);
}
