import { HttpException, Inject, Injectable } from '@nestjs/common';
import { Temporal } from '@js-temporal/polyfill';
import { randomUUID } from 'node:crypto';
import {
  OPEN_ENDED,
  type AgeCredentialView,
  type JurisdictionPolicySelector,
} from '@wai/contracts';
import {
  EligibilityConflictError,
  type AgeCredentialRepository,
  type AgeCredentialRow,
  type AgeEvidenceRepository,
  type JurisdictionDeclarationRepository,
} from '@wai/db';
import {
  ageInYears,
  isWithinValidity,
  localDateAt,
  nextBirthdayInstant,
  parseBirthDate,
} from '../domain/age.js';
import { deriveAgeBand, deriveCohortKey } from '../domain/policy.js';
import {
  BIRTHDAY_CIPHER,
  ELG_CLOCK,
  ELG_REPOSITORIES,
  JURISDICTION_POLICY_SELECTOR,
} from '../eligibility.tokens.js';
import type { BirthdayCipher } from '../infra/eligibility-secret-cipher.js';
import type { ElgClock } from '../infra/elg-clock.js';

/**
 * Session-facing age declaration. The birth date is encrypted (AES-256-GCM,
 * randomized nonce) and keyed-HMAC'd into age_evidence; the derived band and
 * cohort key live on the age credential. The response and all logs only ever
 * carry derived facts — never the birth date.
 */
@Injectable()
export class AgeCredentialService {
  constructor(
    // Explicit @Inject: vitest's esbuild transform cannot emit
    // design:paramtypes, so interface-typed params must declare their token.
    @Inject(ELG_REPOSITORIES)
    private readonly deps: {
      jurisdictionDeclarations: Pick<JurisdictionDeclarationRepository, 'current'>;
      ageEvidence: Pick<AgeEvidenceRepository, 'upsertCurrent'>;
      ageCredentials: AgeCredentialRepository;
    },
    @Inject(JURISDICTION_POLICY_SELECTOR)
    private readonly selector: JurisdictionPolicySelector,
    @Inject(BIRTHDAY_CIPHER)
    private readonly cipher: BirthdayCipher,
    @Inject(ELG_CLOCK)
    private readonly clock: ElgClock,
  ) {}

  async declare(accountId: string, birthDate: string): Promise<AgeCredentialView> {
    const now = this.clock.now();
    const declaration = await this.deps.jurisdictionDeclarations.current(accountId);
    if (declaration === null) {
      throw badRequest('jurisdiction_required');
    }
    if (declaration.reviewState !== 'accepted') {
      throw badRequest('jurisdiction_review_required');
    }
    const selection = await this.selector.select(accountId, now.toISOString());
    if (selection === null) {
      throw badRequest('no_active_jurisdiction_policy');
    }
    const birth = parseBirthDate(birthDate);
    // "Today" is the policy timezone's calendar date at this instant — a birth
    // date can be local-yesterday while it is UTC-tomorrow, and vice versa.
    const localToday = localDateAt(Temporal.Instant.from(now.toISOString()), selection.timezone);
    if (Temporal.PlainDate.compare(birth, localToday) > 0) {
      throw badRequest('birth_date_in_future');
    }
    const ageYears = ageInYears(birth, localToday);
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

    const encrypted = this.cipher.encrypt(birthDate);
    const evidence = await this.asConflict409(() =>
      this.deps.ageEvidence.upsertCurrent({
        id: randomUUID(),
        accountId,
        birthdayDigest: encrypted.digest,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        keyId: encrypted.keyId,
        now,
      }),
    );

    const current = await this.deps.ageCredentials.current(accountId);
    if (
      current !== null &&
      current.sourceEvidenceId === evidence.id &&
      current.policyRevision === selection.revision &&
      current.jurisdictionPolicyId === selection.policy_id &&
      current.jurisdictionKey === selection.jurisdiction_key &&
      current.validFrom.getTime() <= now.getTime() &&
      (typeof current.validUntil === 'number' || current.validUntil.getTime() > now.getTime())
    ) {
      // Same birth date under the same policy revision — idempotent no-op.
      return toCredentialView(current);
    }

    // Open-ended intervals store the number Infinity — the repository maps
    // it to timestamptz 'infinity' (same convention as jurisdiction_policies).
    const birthdayBoundary = nextBirthdayInstant(
      birth,
      Temporal.Instant.from(now.toISOString()),
      selection.timezone,
    ).epochMilliseconds;
    const policyBoundary =
      selection.effective_until === OPEN_ENDED
        ? Number.POSITIVE_INFINITY
        : new Date(selection.effective_until).getTime();
    const validUntilMs = Math.min(birthdayBoundary, policyBoundary);
    const validUntil = Number.isFinite(validUntilMs) ? new Date(validUntilMs) : Infinity;
    if (Number.isFinite(validUntilMs) && validUntilMs <= now.getTime()) {
      throw badRequest('age_credential_validity_window_invalid');
    }
    const credential = await this.asConflict409(() =>
      this.deps.ageCredentials.insertCurrent({
        id: randomUUID(),
        accountId,
        ageBand,
        cohortKey,
        assuranceLevel: 'self_declared',
        issuerType: 'eligibility_self_declaration',
        sourceEvidenceId: evidence.id,
        jurisdictionPolicyId: selection.policy_id,
        jurisdictionKey: selection.jurisdiction_key,
        policyRevision: selection.revision,
        validFrom: now,
        validUntil,
        derivedAt: now,
        derivationVersion: 1,
        now,
      }),
    );
    return toCredentialView(credential);
  }

  async current(accountId: string): Promise<AgeCredentialView | null> {
    const row = await this.deps.ageCredentials.current(accountId);
    if (row === null || !isWithinValidity(row.validFrom, row.validUntil, this.clock.now())) {
      return null;
    }
    return toCredentialView(row);
  }

  /**
   * VER-01 provider attestation entry point. The provider DOB is accepted only
   * as process-memory input; this method immediately encrypts it and stores
   * the evidence in Eligibility-owned tables. Verification never receives a
   * repository or writes these rows directly.
   */
  async issueExternalAttestation(input: {
    accountId: string;
    evidenceId: string;
    verificationCaseId: string;
    attestationDigest: string;
    birthDate: string;
    assuranceExpiresAt: string;
  }): Promise<AgeCredentialView> {
    const now = this.clock.now();
    const declaration = await this.deps.jurisdictionDeclarations.current(input.accountId);
    if (declaration === null || declaration.reviewState !== 'accepted')
      throw badRequest('jurisdiction_review_required');
    const selection = await this.selector.select(input.accountId, now.toISOString());
    if (selection === null) throw badRequest('no_active_jurisdiction_policy');
    const birth = parseBirthDate(input.birthDate);
    const localToday = localDateAt(Temporal.Instant.from(now.toISOString()), selection.timezone);
    if (Temporal.PlainDate.compare(birth, localToday) > 0) throw badRequest('birth_date_in_future');
    const years = ageInYears(birth, localToday);
    const ageBand = deriveAgeBand(
      years,
      selection.document.minimum_account_age,
      selection.document.age_of_majority,
    );
    const cohortKey = deriveCohortKey(
      years,
      selection.document.minimum_account_age,
      selection.document.age_of_majority,
    );
    const encrypted = this.cipher.encrypt(input.birthDate);
    const evidence = await this.asConflict409(() =>
      this.deps.ageEvidence.upsertCurrent({
        id: input.evidenceId,
        accountId: input.accountId,
        birthdayDigest: encrypted.digest,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        keyId: encrypted.keyId,
        now,
        source: 'verification_provider',
        verificationCaseId: input.verificationCaseId,
        externalAttestationDigest: input.attestationDigest,
      }),
    );
    const birthdayBoundary = nextBirthdayInstant(
      birth,
      Temporal.Instant.from(now.toISOString()),
      selection.timezone,
    ).epochMilliseconds;
    const validUntilMs = Math.min(
      birthdayBoundary,
      new Date(input.assuranceExpiresAt).getTime(),
      selection.effective_until === OPEN_ENDED
        ? Number.POSITIVE_INFINITY
        : new Date(selection.effective_until).getTime(),
    );
    if (!Number.isFinite(validUntilMs) && validUntilMs !== Number.POSITIVE_INFINITY)
      throw badRequest('age_credential_validity_window_invalid');
    if (validUntilMs <= now.getTime()) throw badRequest('age_credential_validity_window_invalid');
    const credential = await this.asConflict409(() =>
      this.deps.ageCredentials.insertCurrent({
        id: randomUUID(),
        accountId: input.accountId,
        ageBand,
        cohortKey,
        assuranceLevel: 'externally_attested',
        issuerType: 'verification_module',
        sourceEvidenceId: evidence.id,
        jurisdictionPolicyId: selection.policy_id,
        jurisdictionKey: selection.jurisdiction_key,
        policyRevision: selection.revision,
        validFrom: now,
        validUntil: Number.isFinite(validUntilMs) ? new Date(validUntilMs) : Infinity,
        derivedAt: now,
        derivationVersion: 1,
        now,
      }),
    );
    return toCredentialView(credential);
  }

  /** Both the evidence write and the credential write can lose the race. */
  private async asConflict409<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof EligibilityConflictError) {
        throw concurrentAgeDeclarationUpdate();
      }
      throw error;
    }
  }
}

function toCredentialView(row: AgeCredentialRow): AgeCredentialView {
  return {
    credential_id: row.id,
    age_band: row.ageBand,
    cohort_key: row.cohortKey,
    assurance_level: row.assuranceLevel,
    valid_from: row.validFrom.toISOString(),
    valid_until: isOpenEnded(row.validUntil) ? OPEN_ENDED : row.validUntil.toISOString(),
  };
}

/** Postgres 'infinity' round-trips as the number Infinity in node-postgres. */
function isOpenEnded(value: Date | number): value is number {
  return typeof value === 'number';
}

function badRequest(message: string): HttpException {
  return new HttpException({ code: 'VALIDATION_ERROR', message }, 400);
}

/** A concurrent declaration that lost the account slot is a 409, not a 500. */
function concurrentAgeDeclarationUpdate(): HttpException {
  return new HttpException(
    { code: 'VALIDATION_ERROR', message: 'concurrent_age_declaration_update' },
    409,
  );
}
