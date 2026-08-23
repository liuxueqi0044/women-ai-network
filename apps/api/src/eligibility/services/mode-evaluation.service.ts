import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Temporal } from '@js-temporal/polyfill';
import {
  OPEN_ENDED,
  modeDecisionInputSchema,
  modeEvaluationResponseSchema,
  type AgeModePolicyDecisionPort,
  type JurisdictionPolicySelector,
  type ModeEvaluationRequest,
  type ModeEvaluationResponse,
  type ModeDecisionInput,
} from '@wai/contracts';
import {
  canonicalJsonHash,
  type AgeCredentialRepository,
  type AgeCredentialRow,
  type AgeEvidenceRepository,
  type JurisdictionDeclarationRepository,
  type ModeDecisionRepository,
  type ModeDecisionRow,
  type PolicyEventRepository,
} from '@wai/db';
import { ageInYears, isWithinValidity, localDateAt, parseBirthDate } from '../domain/age.js';
import { decisionValidUntil, deriveDecisionId, ENGINE_VERSION } from '../domain/decision.js';
import { deriveAgeBand, deriveCohortKey } from '../domain/policy.js';
import {
  AGE_MODE_POLICY_DECISION_PORT,
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
 * is rejected before any snapshot exists ("must not be a future-replay",
 * dto.ts).
 */
const FUTURE_EFFECTIVE_AT_SKEW_MS = 5 * 60 * 1000;

/**
 * Single-subject mode evaluation (task book §6 POST /mode-evaluations). The
 * pipeline: select the policy active at `effective_at` (subdivision-first,
 * country fallback), recompute the age facts with Temporal in the policy
 * timezone from the DECRYPTED evidence birthday (never logged, never in
 * responses — only age_years/band/cohort reach the OPA input), ask the
 * replaceable decision port, and append the immutable snapshot keyed by the
 * deterministic decision_id. Retries with identical input reuse the stored
 * row — old snapshots are never rewritten by new policy revisions.
 */
@Injectable()
export class ModeEvaluationService {
  constructor(
    @Inject(ELG_REPOSITORIES)
    private readonly deps: {
      jurisdictionDeclarations: Pick<JurisdictionDeclarationRepository, 'current'>;
      ageEvidence: Pick<AgeEvidenceRepository, 'current'>;
      ageCredentials: Pick<AgeCredentialRepository, 'current'>;
      modeDecisions: ModeDecisionRepository;
      policyEvents: Pick<PolicyEventRepository, 'append'>;
    },
    @Inject(JURISDICTION_POLICY_SELECTOR)
    private readonly selector: JurisdictionPolicySelector,
    @Inject(BIRTHDAY_CIPHER)
    private readonly cipher: BirthdayCipher,
    @Inject(ELG_CLOCK)
    private readonly clock: ElgClock,
    @Inject(AGE_MODE_POLICY_DECISION_PORT)
    private readonly decider: AgeModePolicyDecisionPort,
  ) {}

  async evaluate(
    accountId: string,
    request: ModeEvaluationRequest,
  ): Promise<ModeEvaluationResponse> {
    const now = this.clock.now();
    const effectiveAtDefaulted = request.effective_at === undefined;
    // Resolve an omitted effective time from the first durable snapshot. This
    // makes retries with the same idempotency key independent of wall-clock
    // drift (the old implementation hashed a fresh `now` on every retry).
    if (request.effective_at === undefined && request.idempotency_key !== undefined) {
      const existing = await this.deps.modeDecisions.findDefaultedByIdempotencyKey?.(
        accountId,
        request.idempotency_key,
        request.mode,
      );
      if (existing !== null && existing !== undefined) return toResponse(existing);
    }
    const effectiveAt = request.effective_at ?? now.toISOString();
    if (new Date(effectiveAt).getTime() > now.getTime() + FUTURE_EFFECTIVE_AT_SKEW_MS) {
      throw badRequest('effective_at_in_future');
    }

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

    // The credential is a derived snapshot; the authoritative age facts are
    // recomputed from the encrypted evidence at the effective instant.
    const evidence = await this.deps.ageEvidence.current(accountId);
    if (evidence === null) {
      throw new Error('mode evaluation: current credential without current evidence');
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
    const ageBand = deriveAgeBand(
      ageYears,
      selection.document.minimum_account_age,
      selection.document.age_of_majority,
    );
    const cohortKey = deriveCohortKey(
      ageYears,
      selection.document.minimum_account_age,
      selection.document.age_of_majority,
    );

    const input: ModeDecisionInput = {
      policy: selection.document,
      subject: {
        age_years: ageYears,
        age_band: ageBand,
        cohort_key: cohortKey,
        assurance_level: credential.assuranceLevel,
      },
      request: { mode: request.mode, effective_at: effectiveAt },
    };
    // Defense in depth: an input that fails the strict contract is a
    // programming error — fail loudly, never evaluate a half-formed document.
    const parsedInput = modeDecisionInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new Error(`mode evaluation input failed validation: ${parsedInput.error.message}`);
    }

    const inputHash = canonicalJsonHash(input);
    const decisionId = deriveDecisionId({
      account_id: accountId,
      mode: request.mode,
      effective_at: effectiveAt,
      policy_id: selection.policy_id,
      credential_id: credential.id,
      input_hash: inputHash,
      idempotency_key: request.idempotency_key ?? '',
    });

    const output = await this.decider.decide(input);

    const policyUntil =
      selection.effective_until === OPEN_ENDED ? Infinity : new Date(selection.effective_until);
    const snapshot: ModeDecisionRow = {
      decisionId,
      accountId,
      scope: 'age_and_jurisdiction',
      mode: request.mode,
      decision: output.decision,
      ageBand,
      cohortKey,
      assuranceLevel: credential.assuranceLevel,
      reasonCodes: output.reason_codes,
      obligations: output.obligations,
      policyId: selection.policy_id,
      policyRevision: selection.revision,
      policyHash: selection.content_hash,
      credentialId: credential.id,
      credentialHash: credentialHashOf(credential),
      idempotencyKey: request.idempotency_key ?? null,
      effectiveAtDefaulted,
      inputHash,
      evaluatedAt: new Date(effectiveAt),
      validUntil: decisionValidUntil(credential.validUntil, policyUntil),
      engineVersion: ENGINE_VERSION,
      createdAt: now,
    };

    const { row } = await this.deps.modeDecisions.insertIfAbsent(snapshot);

    if (isEngineFailure(output.decision, output.reason_codes)) {
      await this.deps.policyEvents.append({
        eventType: 'evaluation_failure',
        policyId: selection.policy_id,
        jurisdictionKey: selection.jurisdiction_key,
        accountId,
        reason: output.reason_codes.join(','),
        metadata: { mode: request.mode, decision_id: decisionId },
        now,
      });
    }

    return toResponse(row);
  }
}

function isEngineFailure(decision: 'allow' | 'deny', reasonCodes: readonly string[]): boolean {
  return (
    decision === 'deny' &&
    (reasonCodes.includes('POLICY_ENGINE_UNAVAILABLE') ||
      reasonCodes.includes('POLICY_OUTPUT_INVALID'))
  );
}

/** Deterministic content hash of the credential's derived facts. */
function credentialHashOf(row: AgeCredentialRow): string {
  return canonicalJsonHash({
    credential_id: row.id,
    jurisdiction_key: row.jurisdictionKey ?? null,
    age_band: row.ageBand,
    cohort_key: row.cohortKey,
    assurance_level: row.assuranceLevel,
    valid_from: row.validFrom.toISOString(),
    valid_until: isOpenEnded(row.validUntil) ? OPEN_ENDED : row.validUntil.toISOString(),
  });
}

function toResponse(row: ModeDecisionRow): ModeEvaluationResponse {
  return modeEvaluationResponseSchema.parse({
    decision_id: row.decisionId,
    scope: row.scope,
    decision: row.decision,
    mode: row.mode,
    age_band: row.ageBand,
    cohort_key: row.cohortKey,
    assurance_level: row.assuranceLevel,
    reason_codes: row.reasonCodes,
    obligations: row.obligations,
    policy: {
      policy_id: row.policyId,
      revision: row.policyRevision,
      policy_hash: row.policyHash,
    },
    credential: {
      credential_id: row.credentialId,
      assurance_level: row.assuranceLevel,
    },
    evaluated_at: row.evaluatedAt.toISOString(),
    valid_until: isOpenEnded(row.validUntil) ? OPEN_ENDED : row.validUntil.toISOString(),
  });
}

/** Postgres 'infinity' round-trips as the number Infinity in node-postgres. */
function isOpenEnded(value: Date | number): value is number {
  return typeof value === 'number';
}

function badRequest(message: string): HttpException {
  return new HttpException({ code: 'VALIDATION_ERROR', message }, 400);
}
