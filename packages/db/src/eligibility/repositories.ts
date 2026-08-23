import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import {
  ageCredentials,
  ageEvidence,
  jurisdictionDeclarations,
  jurisdictionPolicies,
  modeDecisions,
  partitionDecisions,
  policyEvents,
} from './schema.js';

/**
 * ELG-01 repositories over the `eligibility` schema. Every write that
 * changes "current" state is transactional and guarded by SELECT ... FOR
 * UPDATE: a concurrent request that races the same account slot either
 * serializes behind the lock (idempotent no-op or supersede chain) or hits
 * a 23505 partial-unique violation, which is surfaced as
 * `EligibilityConflictError` (the API maps it to 409). Decision snapshots
 * are append-only with a deterministic decision_id — insertIfAbsent is the
 * idempotency mechanism (retries return the stored row).
 */

/** Two conflicting "current state" writes raced; the loser gets this. */
export class EligibilityConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EligibilityConflictError';
  }
}

/**
 * drizzle's node-postgres driver overrides pg's timestamptz parser, so the
 * SQL value 'infinity' reaches the column mapper as the raw string and
 * becomes an Invalid Date. Every open-ended column read is normalized at
 * the repository boundary to the documented number-Infinity convention —
 * the selector and services never see an Invalid Date.
 */
function mapOpenEnded(value: Date): Date | number {
  return Number.isNaN(value.getTime()) ? Infinity : value;
}

function isUniqueViolation(error: unknown): boolean {
  // drizzle wraps pg errors raised inside db.transaction() in a
  // "Failed query" error whose `cause` is the original pg error carrying
  // the SQLSTATE code — walk the cause chain.
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

// ---------------------------------------------------------------------------
// jurisdiction_declarations
// ---------------------------------------------------------------------------

export interface JurisdictionDeclarationRow {
  id: string;
  accountId: string;
  countryCode: string;
  subdivisionCode: string | null;
  source: 'self_declared' | 'reviewed';
  reviewState: 'accepted' | 'conflict_review_required';
  effectiveFrom: Date;
  supersededAt: Date | null;
  version: number;
  createdAt: Date;
}

export interface UpsertJurisdictionDeclarationInput {
  id: string;
  accountId: string;
  countryCode: string;
  subdivisionCode: string | null;
  now: Date;
}

export interface JurisdictionDeclarationRepository {
  /**
   * Idempotent upsert of the current declaration. Same content → returns the
   * current row unchanged. Different content → supersedes the current row and
   * inserts the new one (version + 1). A concurrent race surfaces as
   * `EligibilityConflictError`.
   */
  upsertCurrent(input: UpsertJurisdictionDeclarationInput): Promise<JurisdictionDeclarationRow>;
  current(accountId: string): Promise<JurisdictionDeclarationRow | null>;
  at?(accountId: string, at: Date): Promise<JurisdictionDeclarationRow | null>;
}

export class PgJurisdictionDeclarationRepository implements JurisdictionDeclarationRepository {
  constructor(private readonly db: Db) {}

  async upsertCurrent(
    input: UpsertJurisdictionDeclarationInput,
  ): Promise<JurisdictionDeclarationRow> {
    return this.db.transaction(async (tx) => {
      const current = await this.currentForUpdate(tx, input.accountId);
      if (current === null) {
        try {
          return await this.insert(tx, { ...input, version: 1 });
        } catch (error) {
          // Concurrent first declaration raced the partial unique index.
          if (isUniqueViolation(error)) {
            throw new EligibilityConflictError('concurrent jurisdiction declaration update');
          }
          throw error;
        }
      }
      if (
        current.countryCode === input.countryCode &&
        current.subdivisionCode === input.subdivisionCode
      ) {
        return current;
      }
      await tx
        .update(jurisdictionDeclarations)
        .set({ supersededAt: input.now })
        .where(eq(jurisdictionDeclarations.id, current.id));
      return this.insert(tx, { ...input, version: current.version + 1 });
    });
  }

  async current(accountId: string): Promise<JurisdictionDeclarationRow | null> {
    const rows = await this.db
      .select()
      .from(jurisdictionDeclarations)
      .where(
        and(
          eq(jurisdictionDeclarations.accountId, accountId),
          isNull(jurisdictionDeclarations.supersededAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as JurisdictionDeclarationRow);
  }

  async at(accountId: string, at: Date): Promise<JurisdictionDeclarationRow | null> {
    const rows = await this.db
      .select()
      .from(jurisdictionDeclarations)
      .where(
        and(
          eq(jurisdictionDeclarations.accountId, accountId),
          lte(jurisdictionDeclarations.effectiveFrom, at),
          sql`(${jurisdictionDeclarations.supersededAt} IS NULL OR ${jurisdictionDeclarations.supersededAt} > ${at})`,
        ),
      )
      .orderBy(sql`${jurisdictionDeclarations.effectiveFrom} DESC`)
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as JurisdictionDeclarationRow);
  }

  private async currentForUpdate(
    db: Db,
    accountId: string,
  ): Promise<JurisdictionDeclarationRow | null> {
    const rows = await db
      .select()
      .from(jurisdictionDeclarations)
      .where(
        and(
          eq(jurisdictionDeclarations.accountId, accountId),
          isNull(jurisdictionDeclarations.supersededAt),
        ),
      )
      .for('update')
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as JurisdictionDeclarationRow);
  }

  private async insert(
    tx: Db,
    input: UpsertJurisdictionDeclarationInput & { version: number },
  ): Promise<JurisdictionDeclarationRow> {
    const rows = await tx
      .insert(jurisdictionDeclarations)
      .values({
        id: input.id,
        accountId: input.accountId,
        countryCode: input.countryCode,
        subdivisionCode: input.subdivisionCode,
        source: 'self_declared',
        reviewState: 'accepted',
        effectiveFrom: input.now,
        version: input.version,
        createdAt: input.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error('insert jurisdiction declaration returned no row');
    }
    return row as unknown as JurisdictionDeclarationRow;
  }
}

// ---------------------------------------------------------------------------
// jurisdiction_policies
// ---------------------------------------------------------------------------

export type JurisdictionPolicyStatus = 'draft' | 'approved' | 'retired';

export interface JurisdictionPolicyRow {
  id: string;
  jurisdictionKey: string;
  revision: number;
  status: JurisdictionPolicyStatus;
  content: unknown;
  contentHash: string;
  ruleHash: string;
  locationPrecisionPolicy: 'country_only' | 'country_and_subdivision';
  profilingPolicy: 'derived_facts_only' | 'prohibited';
  retentionPolicy: string;
  legalBasisRefs: string[];
  reviewedBy: string;
  reviewedAt: Date;
  timezone: string;
  effectiveFrom: Date;
  /** `Date` in JS; `Infinity` when the SQL column holds 'infinity'. */
  effectiveUntil: Date | number;
  isSynthetic: boolean;
  retiredAt: Date | null;
  createdAt: Date;
}

export interface NewJurisdictionPolicy {
  id: string;
  jurisdictionKey: string;
  revision: number;
  status: 'draft' | 'approved';
  content: unknown;
  contentHash: string;
  ruleHash: string;
  locationPrecisionPolicy: JurisdictionPolicyRow['locationPrecisionPolicy'];
  profilingPolicy: JurisdictionPolicyRow['profilingPolicy'];
  retentionPolicy: string;
  legalBasisRefs: string[];
  reviewedBy: string;
  reviewedAt: Date;
  timezone: string;
  effectiveFrom: Date;
  /** Open-ended intervals pass the number Infinity (stored as 'infinity'). */
  effectiveUntil: Date | number;
  isSynthetic: boolean;
  now: Date;
}

export interface JurisdictionPolicyRepository {
  insert(input: NewJurisdictionPolicy): Promise<JurisdictionPolicyRow>;
  /** Approved policy whose effective interval contains `at`, or null. */
  findActive(jurisdictionKey: string, at: Date): Promise<JurisdictionPolicyRow | null>;
  findById(id: string): Promise<JurisdictionPolicyRow | null>;
  /** approved → retired (guard trigger enforces the transition). */
  retire(id: string, at: Date): Promise<JurisdictionPolicyRow | null>;
}

export class PgJurisdictionPolicyRepository implements JurisdictionPolicyRepository {
  constructor(private readonly db: Db) {}

  async insert(input: NewJurisdictionPolicy): Promise<JurisdictionPolicyRow> {
    const rows = await this.db.transaction(async (tx) => {
      if (input.status === 'approved') {
        await tx.execute(sql`SELECT set_config('app.eligibility_policy_publish', 'true', true)`);
      }
      return tx
        .insert(jurisdictionPolicies)
        .values({
          id: input.id,
          jurisdictionKey: input.jurisdictionKey,
          revision: input.revision,
          status: input.status,
          content: input.content as object,
          contentHash: input.contentHash,
          ruleHash: input.ruleHash,
          locationPrecisionPolicy: input.locationPrecisionPolicy,
          profilingPolicy: input.profilingPolicy,
          retentionPolicy: input.retentionPolicy,
          legalBasisRefs: input.legalBasisRefs,
          reviewedBy: input.reviewedBy,
          reviewedAt: input.reviewedAt,
          timezone: input.timezone,
          effectiveFrom: input.effectiveFrom,
          // drizzle's timestamp mapper only accepts Date — the literal
          // 'infinity' must ride as a quoted SQL fragment: a bare `infinity`
          // parses as a column reference, not a value (read-back: number Infinity).
          effectiveUntil:
            typeof input.effectiveUntil === 'number' ? sql`'infinity'` : input.effectiveUntil,
          isSynthetic: input.isSynthetic,
          createdAt: input.now,
        })
        .returning();
    });
    const row = rows[0];
    if (row === undefined) {
      throw new Error('insert jurisdiction policy returned no row');
    }
    return normalizePolicyRow(row as unknown as JurisdictionPolicyRow);
  }

  async findActive(jurisdictionKey: string, at: Date): Promise<JurisdictionPolicyRow | null> {
    const rows = await this.db
      .select()
      .from(jurisdictionPolicies)
      .where(
        and(
          eq(jurisdictionPolicies.jurisdictionKey, jurisdictionKey),
          eq(jurisdictionPolicies.status, 'approved'),
          lte(jurisdictionPolicies.effectiveFrom, at),
          gt(jurisdictionPolicies.effectiveUntil, at),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : normalizePolicyRow(row as unknown as JurisdictionPolicyRow);
  }

  async findById(id: string): Promise<JurisdictionPolicyRow | null> {
    const rows = await this.db
      .select()
      .from(jurisdictionPolicies)
      .where(eq(jurisdictionPolicies.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : normalizePolicyRow(row as unknown as JurisdictionPolicyRow);
  }

  async retire(id: string, at: Date): Promise<JurisdictionPolicyRow | null> {
    const rows = await this.db
      .update(jurisdictionPolicies)
      .set({ status: 'retired', retiredAt: at })
      .where(and(eq(jurisdictionPolicies.id, id), eq(jurisdictionPolicies.status, 'approved')))
      .returning();
    const row = rows[0];
    return row === undefined ? null : normalizePolicyRow(row as unknown as JurisdictionPolicyRow);
  }
}

function normalizePolicyRow(row: JurisdictionPolicyRow): JurisdictionPolicyRow {
  row.effectiveUntil = mapOpenEnded(row.effectiveUntil as Date);
  return row;
}

// ---------------------------------------------------------------------------
// age_evidence (encrypted birthday)
// ---------------------------------------------------------------------------

export interface AgeEvidenceRow {
  id: string;
  accountId: string;
  birthdayDigest: string;
  birthdayCiphertext: string;
  birthdayNonce: string;
  birthdayKeyId: string;
  source: 'self_declared' | 'verification_provider';
  verificationCaseId?: string | null;
  externalAttestationDigest?: string | null;
  declaredAt: Date;
  supersededAt: Date | null;
  createdAt: Date;
}

export interface UpsertAgeEvidenceInput {
  id: string;
  accountId: string;
  birthdayDigest: string;
  ciphertext: string;
  nonce: string;
  keyId: string;
  now: Date;
  source?: 'self_declared' | 'verification_provider';
  verificationCaseId?: string;
  externalAttestationDigest?: string;
}

export interface AgeEvidenceRepository {
  /**
   * Idempotent: same birthdayDigest → returns the current row unchanged
   * (no supersede churn). Different digest → supersedes + inserts. A
   * concurrent race surfaces as `EligibilityConflictError`.
   */
  upsertCurrent(input: UpsertAgeEvidenceInput): Promise<AgeEvidenceRow>;
  current(accountId: string): Promise<AgeEvidenceRow | null>;
}

export class PgAgeEvidenceRepository implements AgeEvidenceRepository {
  constructor(private readonly db: Db) {}

  async upsertCurrent(input: UpsertAgeEvidenceInput): Promise<AgeEvidenceRow> {
    return this.db.transaction(async (tx) => {
      const current = await this.currentForUpdate(tx, input.accountId);
      if (current === null) {
        try {
          return await this.insert(tx, input);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new EligibilityConflictError('concurrent age evidence update');
          }
          throw error;
        }
      }
      const sameExternalAttestation =
        current.source === 'verification_provider' &&
        input.source === 'verification_provider' &&
        current.verificationCaseId === input.verificationCaseId &&
        current.externalAttestationDigest === input.externalAttestationDigest;
      const sameSelfDeclaration =
        current.source === 'self_declared' &&
        (input.source === undefined || input.source === 'self_declared') &&
        current.birthdayDigest === input.birthdayDigest;
      if (sameExternalAttestation || sameSelfDeclaration) {
        return current;
      }
      await tx
        .update(ageEvidence)
        .set({ supersededAt: input.now })
        .where(eq(ageEvidence.id, current.id));
      return this.insert(tx, input);
    });
  }

  async current(accountId: string): Promise<AgeEvidenceRow | null> {
    const rows = await this.db
      .select()
      .from(ageEvidence)
      .where(and(eq(ageEvidence.accountId, accountId), isNull(ageEvidence.supersededAt)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as AgeEvidenceRow);
  }

  private async currentForUpdate(db: Db, accountId: string): Promise<AgeEvidenceRow | null> {
    const rows = await db
      .select()
      .from(ageEvidence)
      .where(and(eq(ageEvidence.accountId, accountId), isNull(ageEvidence.supersededAt)))
      .for('update')
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as AgeEvidenceRow);
  }

  private async insert(tx: Db, input: UpsertAgeEvidenceInput): Promise<AgeEvidenceRow> {
    const rows = await tx
      .insert(ageEvidence)
      .values({
        id: input.id,
        accountId: input.accountId,
        birthdayDigest: input.birthdayDigest,
        birthdayCiphertext: input.ciphertext,
        birthdayNonce: input.nonce,
        birthdayKeyId: input.keyId,
        source: input.source ?? 'self_declared',
        verificationCaseId: input.verificationCaseId ?? null,
        externalAttestationDigest: input.externalAttestationDigest ?? null,
        declaredAt: input.now,
        createdAt: input.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error('insert age evidence returned no row');
    }
    return row as unknown as AgeEvidenceRow;
  }
}

// ---------------------------------------------------------------------------
// age_credentials
// ---------------------------------------------------------------------------

export interface AgeCredentialRow {
  id: string;
  accountId: string;
  ageBand: 'unknown' | 'below_minimum' | 'youth' | 'adult';
  cohortKey: string;
  assuranceLevel: 'self_declared' | 'externally_attested';
  issuerType: 'eligibility_self_declaration' | 'verification_module';
  sourceEvidenceId: string;
  jurisdictionPolicyId: string;
  jurisdictionKey?: string | null;
  policyRevision: number;
  validFrom: Date;
  /** `Date` in JS; `Infinity` when the SQL column holds 'infinity'. */
  validUntil: Date | number;
  supersededAt: Date | null;
  derivedAt: Date;
  derivationVersion: number;
  createdAt: Date;
}

export interface NewAgeCredential {
  id: string;
  accountId: string;
  ageBand: AgeCredentialRow['ageBand'];
  cohortKey: string;
  assuranceLevel: AgeCredentialRow['assuranceLevel'];
  issuerType: AgeCredentialRow['issuerType'];
  sourceEvidenceId: string;
  jurisdictionPolicyId: string;
  jurisdictionKey?: string | null;
  policyRevision: number;
  validFrom: Date;
  /** Open-ended policies pass the number Infinity (stored as 'infinity'). */
  validUntil: Date | number;
  derivedAt: Date;
  derivationVersion: number;
  now: Date;
}

export interface AgeCredentialRepository {
  /** Supersedes the current credential (if any) and inserts the new one. */
  insertCurrent(input: NewAgeCredential): Promise<AgeCredentialRow>;
  current(accountId: string): Promise<AgeCredentialRow | null>;
  findById(id: string): Promise<AgeCredentialRow | null>;
}

export class PgAgeCredentialRepository implements AgeCredentialRepository {
  constructor(private readonly db: Db) {}

  async insertCurrent(input: NewAgeCredential): Promise<AgeCredentialRow> {
    return this.db.transaction(async (tx) => {
      const current = await this.currentForUpdate(tx, input.accountId);
      if (current !== null) {
        await tx
          .update(ageCredentials)
          .set({ supersededAt: input.now })
          .where(eq(ageCredentials.id, current.id));
      }
      try {
        const rows = await tx
          .insert(ageCredentials)
          .values({
            id: input.id,
            accountId: input.accountId,
            ageBand: input.ageBand,
            cohortKey: input.cohortKey,
            assuranceLevel: input.assuranceLevel,
            issuerType: input.issuerType,
            sourceEvidenceId: input.sourceEvidenceId,
            jurisdictionPolicyId: input.jurisdictionPolicyId,
            jurisdictionKey: input.jurisdictionKey ?? null,
            policyRevision: input.policyRevision,
            validFrom: input.validFrom,
            // drizzle's timestamp mapper only accepts Date — the literal
            // 'infinity' must ride as a quoted SQL fragment: a bare `infinity`
            // parses as a column reference, not a value (read-back: number Infinity).
            validUntil: typeof input.validUntil === 'number' ? sql`'infinity'` : input.validUntil,
            derivedAt: input.derivedAt,
            derivationVersion: input.derivationVersion,
            createdAt: input.now,
          })
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new Error('insert age credential returned no row');
        }
        return normalizeCredentialRow(row as unknown as AgeCredentialRow);
      } catch (error) {
        // Concurrent first credential raced the partial unique index.
        if (isUniqueViolation(error)) {
          throw new EligibilityConflictError('concurrent age credential update');
        }
        throw error;
      }
    });
  }

  async current(accountId: string): Promise<AgeCredentialRow | null> {
    const rows = await this.db
      .select()
      .from(ageCredentials)
      .where(and(eq(ageCredentials.accountId, accountId), isNull(ageCredentials.supersededAt)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : normalizeCredentialRow(row as unknown as AgeCredentialRow);
  }

  async findById(id: string): Promise<AgeCredentialRow | null> {
    const rows = await this.db
      .select()
      .from(ageCredentials)
      .where(eq(ageCredentials.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : normalizeCredentialRow(row as unknown as AgeCredentialRow);
  }

  private async currentForUpdate(db: Db, accountId: string): Promise<AgeCredentialRow | null> {
    const rows = await db
      .select()
      .from(ageCredentials)
      .where(and(eq(ageCredentials.accountId, accountId), isNull(ageCredentials.supersededAt)))
      .for('update')
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : normalizeCredentialRow(row as unknown as AgeCredentialRow);
  }
}

function normalizeCredentialRow(row: AgeCredentialRow): AgeCredentialRow {
  row.validUntil = mapOpenEnded(row.validUntil as Date);
  return row;
}

// ---------------------------------------------------------------------------
// mode_decisions / partition_decisions (append-only, idempotent by key)
// ---------------------------------------------------------------------------

export interface ModeDecisionRow {
  decisionId: string;
  accountId: string;
  scope: 'age_and_jurisdiction';
  mode: 'friends' | 'activities' | 'professional' | 'circles' | 'events' | 'dating';
  decision: 'allow' | 'deny';
  ageBand: AgeCredentialRow['ageBand'];
  cohortKey: string;
  assuranceLevel: AgeCredentialRow['assuranceLevel'];
  reasonCodes: string[];
  obligations: string[];
  policyId: string;
  policyRevision: number;
  policyHash: string;
  credentialId: string;
  credentialHash: string;
  inputHash: string;
  idempotencyKey?: string | null;
  effectiveAtDefaulted?: boolean;
  evaluatedAt: Date;
  /** `Date` in JS; `Infinity` when the SQL column holds 'infinity'. */
  validUntil: Date | number;
  engineVersion: number;
  createdAt: Date;
}

export type NewModeDecision = ModeDecisionRow;

export interface PartitionDecisionRow {
  decisionId: string;
  actorAccountId: string;
  subjectAccountId: string;
  actorAgeBand: AgeCredentialRow['ageBand'];
  actorCohortKey: string;
  subjectAgeBand: AgeCredentialRow['ageBand'];
  subjectCohortKey: string;
  capability:
    | 'discover'
    | 'introduce'
    | 'direct_message'
    | 'circles'
    | 'event_visibility'
    | 'dating';
  decision: 'allow' | 'deny';
  reasonCodes: string[];
  actorPolicyId: string;
  subjectPolicyId: string;
  actorPolicyRevision: number;
  subjectPolicyRevision: number;
  actorPolicyHash: string;
  subjectPolicyHash: string;
  inputHash: string;
  evaluatedAt: Date;
  engineVersion: number;
  createdAt: Date;
}

export type NewPartitionDecision = PartitionDecisionRow;

export interface ModeDecisionRepository {
  /**
   * Idempotent append: inserts unless the decision_id already exists, in
   * which case the stored row is returned (retries never duplicate).
   */
  insertIfAbsent(row: NewModeDecision): Promise<{ row: ModeDecisionRow; inserted: boolean }>;
  findByDecisionId(decisionId: string): Promise<ModeDecisionRow | null>;
  findDefaultedByIdempotencyKey?(
    accountId: string,
    idempotencyKey: string,
    mode: ModeDecisionRow['mode'],
  ): Promise<ModeDecisionRow | null>;
}

export interface PartitionDecisionRepository {
  insertIfAbsent(
    row: NewPartitionDecision,
  ): Promise<{ row: PartitionDecisionRow; inserted: boolean }>;
  findByDecisionId(decisionId: string): Promise<PartitionDecisionRow | null>;
}

export class PgModeDecisionRepository implements ModeDecisionRepository {
  constructor(private readonly db: Db) {}

  async insertIfAbsent(row: NewModeDecision): Promise<{ row: ModeDecisionRow; inserted: boolean }> {
    const rows = await this.db
      .insert(modeDecisions)
      .values({
        decisionId: row.decisionId,
        accountId: row.accountId,
        scope: row.scope,
        mode: row.mode,
        decision: row.decision,
        ageBand: row.ageBand,
        cohortKey: row.cohortKey,
        assuranceLevel: row.assuranceLevel,
        reasonCodes: row.reasonCodes,
        obligations: row.obligations,
        policyId: row.policyId,
        policyRevision: row.policyRevision,
        policyHash: row.policyHash,
        credentialId: row.credentialId,
        credentialHash: row.credentialHash,
        inputHash: row.inputHash,
        idempotencyKey: row.idempotencyKey ?? null,
        effectiveAtDefaulted: row.effectiveAtDefaulted ?? false,
        evaluatedAt: row.evaluatedAt,
        // drizzle's timestamp mapper only accepts Date — the literal
        // 'infinity' must ride as a quoted SQL fragment (same convention as
        // the policy and credential open-ended columns; read-back: number Infinity).
        validUntil: typeof row.validUntil === 'number' ? sql`'infinity'` : row.validUntil,
        engineVersion: row.engineVersion,
        createdAt: row.createdAt,
      })
      .onConflictDoNothing()
      .returning();
    const inserted = rows[0];
    if (inserted !== undefined) {
      return {
        row: normalizeModeDecisionRow(inserted as unknown as ModeDecisionRow),
        inserted: true,
      };
    }
    let existing = await this.findByDecisionId(row.decisionId);
    if (
      existing === null &&
      row.effectiveAtDefaulted === true &&
      row.idempotencyKey !== null &&
      row.idempotencyKey !== undefined
    ) {
      existing = await this.findDefaultedByIdempotencyKey(
        row.accountId,
        row.idempotencyKey,
        row.mode,
      );
    }
    if (existing === null) {
      throw new Error('mode decision insert raced without a conflicting row');
    }
    return { row: existing, inserted: false };
  }

  async findByDecisionId(decisionId: string): Promise<ModeDecisionRow | null> {
    const rows = await this.db
      .select()
      .from(modeDecisions)
      .where(eq(modeDecisions.decisionId, decisionId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : normalizeModeDecisionRow(row as unknown as ModeDecisionRow);
  }

  async findDefaultedByIdempotencyKey(
    accountId: string,
    idempotencyKey: string,
    mode: ModeDecisionRow['mode'],
  ): Promise<ModeDecisionRow | null> {
    const rows = await this.db
      .select()
      .from(modeDecisions)
      .where(
        and(
          eq(modeDecisions.accountId, accountId),
          eq(modeDecisions.idempotencyKey, idempotencyKey),
          eq(modeDecisions.mode, mode),
          eq(modeDecisions.effectiveAtDefaulted, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : normalizeModeDecisionRow(row as unknown as ModeDecisionRow);
  }
}

function normalizeModeDecisionRow(row: ModeDecisionRow): ModeDecisionRow {
  row.validUntil = mapOpenEnded(row.validUntil as Date);
  return row;
}

export class PgPartitionDecisionRepository implements PartitionDecisionRepository {
  constructor(private readonly db: Db) {}

  async insertIfAbsent(
    row: NewPartitionDecision,
  ): Promise<{ row: PartitionDecisionRow; inserted: boolean }> {
    const rows = await this.db
      .insert(partitionDecisions)
      .values({
        decisionId: row.decisionId,
        actorAccountId: row.actorAccountId,
        subjectAccountId: row.subjectAccountId,
        actorAgeBand: row.actorAgeBand,
        actorCohortKey: row.actorCohortKey,
        subjectAgeBand: row.subjectAgeBand,
        subjectCohortKey: row.subjectCohortKey,
        capability: row.capability,
        decision: row.decision,
        reasonCodes: row.reasonCodes,
        actorPolicyId: row.actorPolicyId,
        subjectPolicyId: row.subjectPolicyId,
        actorPolicyRevision: row.actorPolicyRevision,
        subjectPolicyRevision: row.subjectPolicyRevision,
        actorPolicyHash: row.actorPolicyHash,
        subjectPolicyHash: row.subjectPolicyHash,
        inputHash: row.inputHash,
        evaluatedAt: row.evaluatedAt,
        engineVersion: row.engineVersion,
        createdAt: row.createdAt,
      })
      .onConflictDoNothing()
      .returning();
    const inserted = rows[0];
    if (inserted !== undefined) {
      return { row: inserted as unknown as PartitionDecisionRow, inserted: true };
    }
    const existing = await this.findByDecisionId(row.decisionId);
    if (existing === null) {
      throw new Error('partition decision insert raced without a conflicting row');
    }
    return { row: existing, inserted: false };
  }

  async findByDecisionId(decisionId: string): Promise<PartitionDecisionRow | null> {
    const rows = await this.db
      .select()
      .from(partitionDecisions)
      .where(eq(partitionDecisions.decisionId, decisionId))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as PartitionDecisionRow);
  }
}

// ---------------------------------------------------------------------------
// policy_events (append-only audit/ops trail)
// ---------------------------------------------------------------------------

export type PolicyEventType =
  | 'policy_published'
  | 'policy_retired'
  | 'declaration_conflict'
  | 'credential_issued'
  | 'credential_superseded'
  | 'evaluation_failure'
  | 'policy_validation_failure';

export interface PolicyEventInput {
  eventType: PolicyEventType;
  policyId?: string;
  jurisdictionKey?: string;
  accountId?: string;
  reason?: string;
  metadata: Record<string, unknown>;
  now: Date;
}

export interface PolicyEventRepository {
  append(input: PolicyEventInput): Promise<void>;
}

export class PgPolicyEventRepository implements PolicyEventRepository {
  constructor(private readonly db: Db) {}

  async append(input: PolicyEventInput): Promise<void> {
    await this.db.insert(policyEvents).values({
      eventType: input.eventType,
      policyId: input.policyId,
      jurisdictionKey: input.jurisdictionKey,
      accountId: input.accountId,
      reason: input.reason,
      metadata: input.metadata,
      createdAt: input.now,
    });
  }
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

export interface EligibilityRepositories {
  jurisdictionDeclarations: JurisdictionDeclarationRepository;
  jurisdictionPolicies: JurisdictionPolicyRepository;
  ageEvidence: AgeEvidenceRepository;
  ageCredentials: AgeCredentialRepository;
  modeDecisions: ModeDecisionRepository;
  partitionDecisions: PartitionDecisionRepository;
  policyEvents: PolicyEventRepository;
}

export function createEligibilityRepositories(db: Db): EligibilityRepositories {
  return {
    jurisdictionDeclarations: new PgJurisdictionDeclarationRepository(db),
    jurisdictionPolicies: new PgJurisdictionPolicyRepository(db),
    ageEvidence: new PgAgeEvidenceRepository(db),
    ageCredentials: new PgAgeCredentialRepository(db),
    modeDecisions: new PgModeDecisionRepository(db),
    partitionDecisions: new PgPartitionDecisionRepository(db),
    policyEvents: new PgPolicyEventRepository(db),
  };
}
