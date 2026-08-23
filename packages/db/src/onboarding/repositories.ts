import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { aesGcmDecrypt, aesGcmEncrypt } from '../crypto.js';
import { canonicalJsonHash } from '../eligibility/hashing.js';
import {
  onboardingPreferenceSchema,
  onboardingProposalResponseSchema,
  onboardingPreferencesResponseSchema,
  onboardingConsentResponseSchema,
  onboardingSessionResponseSchema,
  onboardingCorrectionResponseSchema,
} from '@wai/contracts';
import type {
  ConsentRetention,
  OnboardingExtraction,
  OnboardingMode,
  OnboardingPreferencesRecord,
  OnboardingPreference,
  OnboardingProposalRecord,
  OnboardingPurpose,
  OnboardingRepositoryPort,
  OnboardingSessionRecord,
  OnboardingProviderConsent,
} from '@wai/contracts';

export class OnboardingConcurrencyError extends Error {
  constructor() {
    super('onboarding version conflict');
    this.name = 'OnboardingConcurrencyError';
  }
}
export class OnboardingIdempotencyConflictError extends Error {
  constructor() {
    super('onboarding idempotency payload conflict');
    this.name = 'OnboardingIdempotencyConflictError';
  }
}
export class OnboardingProposalExpiredError extends Error {
  constructor() {
    super('onboarding proposal expired');
    this.name = 'OnboardingProposalExpiredError';
  }
}

type Keyring = ReadonlyMap<string, Buffer>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type SessionRow = {
  id: string;
  account_id: string;
  purpose: OnboardingPurpose;
  modes: string[];
  modes_version: number;
  dating_enabled: boolean;
  state: OnboardingSessionRecord['state'];
  version: number;
  answer_revision: number;
};
type ProposalRow = {
  id: string;
  session_id: string;
  account_id: string;
  purpose: OnboardingPurpose;
  mode: OnboardingMode;
  answer_revision: number;
  modes_version: number;
  proposal_version: number;
  state: OnboardingProposalRecord['state'];
  expires_at: Date;
  confidence: string;
  provenance: string;
  payload_ciphertext: string;
  payload_nonce: string;
  payload_key_id: string;
  payload_hash: string;
};
type IdempotencyRow = {
  payload_digest: string;
  result_ciphertext: string;
  result_nonce: string;
  result_key_id: string;
};

export class PgOnboardingRepository implements OnboardingRepositoryPort {
  constructor(
    private readonly db: Db,
    private readonly keys: Keyring,
    private readonly keyId: string,
  ) {}
  private key(id = this.keyId): Buffer {
    const key = this.keys.get(id);
    if (!key) throw new Error('onboarding_pii_key_unavailable');
    return key;
  }
  async createSession(input: {
    accountId: string;
    purpose: OnboardingPurpose;
    modes: readonly OnboardingMode[];
    datingEnabled: boolean;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingSessionRecord> {
    return this.db.transaction(async (tx) => {
      await this.lockEnabledAccount(tx, input.accountId);
      await this.lockIdempotency(tx, input.accountId, input.idempotencyKey);
      const replay = await this.replay<OnboardingSessionRecord>(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
      );
      if (replay) return deserializeSession(replay);
      const now = new Date();
      const rows = await tx.execute<SessionRow>(
        sql`INSERT INTO onboarding.interview_sessions(id,account_id,purpose,modes,modes_version,dating_enabled,state,version,answer_revision,created_at,updated_at) VALUES (${randomUUID()},${input.accountId},${input.purpose},${textArray(input.modes)},1,${input.datingEnabled},'active',0,0,${now},${now}) ON CONFLICT (account_id,purpose) WHERE state='active' DO UPDATE SET updated_at=onboarding.interview_sessions.updated_at RETURNING id,account_id,purpose,modes,modes_version,dating_enabled,state,version,answer_revision`,
      );
      const result = toSession(rows.rows[0]);
      await this.storeIdempotency(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
        serializeSession(result),
      );
      return result;
    });
  }
  async currentSession(
    accountId: string,
    purpose: OnboardingPurpose,
  ): Promise<OnboardingSessionRecord | null> {
    const r = await this.db.execute<SessionRow>(
      sql`SELECT id,account_id,purpose,modes,modes_version,dating_enabled,state,version,answer_revision FROM onboarding.interview_sessions WHERE account_id=${accountId} AND purpose=${purpose} AND state='active'`,
    );
    return r.rows[0] ? toSession(r.rows[0]) : null;
  }
  async appendAnswer(input: {
    accountId: string;
    sessionId: string;
    purpose: OnboardingPurpose;
    mode: OnboardingMode;
    expectedRevision: number;
    text: string;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingSessionRecord> {
    return this.db.transaction(async (tx) => {
      await this.lockEnabledAccount(tx, input.accountId);
      await this.lockIdempotency(tx, input.accountId, input.idempotencyKey);
      const replay = await this.replay<OnboardingSessionRecord>(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
      );
      if (replay) return deserializeSession(replay);
      const lock = await tx.execute<SessionRow>(
        sql`SELECT id,account_id,purpose,modes,modes_version,dating_enabled,state,version,answer_revision FROM onboarding.interview_sessions WHERE id=${input.sessionId} AND account_id=${input.accountId} AND purpose=${input.purpose} FOR UPDATE`,
      );
      const session = lock.rows[0];
      if (
        !session ||
        session.state !== 'active' ||
        session.answer_revision !== input.expectedRevision
      )
        throw new OnboardingConcurrencyError();
      const encrypted = aesGcmEncrypt(this.key(), input.text);
      const revision = input.expectedRevision + 1;
      await tx.execute(
        sql`INSERT INTO onboarding.answer_revisions(id,session_id,purpose,mode,revision,answer_ciphertext,answer_nonce,answer_key_id,answer_hash,created_at) VALUES (${randomUUID()},${input.sessionId},${input.purpose},${input.mode},${revision},${encrypted.ciphertext},${encrypted.nonce},${this.keyId},${canonicalJsonHash(input.text)},now())`,
      );
      const changed = await tx.execute<SessionRow>(
        sql`UPDATE onboarding.interview_sessions SET answer_revision=${revision},version=version+1,updated_at=now() WHERE id=${input.sessionId} AND purpose=${input.purpose} RETURNING id,account_id,purpose,modes,modes_version,dating_enabled,state,version,answer_revision`,
      );
      const result = toSession(changed.rows[0]);
      await this.storeIdempotency(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
        serializeSession(result),
      );
      return result;
    });
  }
  async answerTexts(
    accountId: string,
    sessionId: string,
    purpose: OnboardingPurpose,
    mode?: OnboardingMode,
  ): Promise<string[]> {
    const r = await this.db.execute<{
      answer_ciphertext: string;
      answer_nonce: string;
      answer_key_id: string;
    }>(
      sql`SELECT a.answer_ciphertext,a.answer_nonce,a.answer_key_id FROM onboarding.answer_revisions a JOIN onboarding.interview_sessions s ON s.id=a.session_id WHERE s.id=${sessionId} AND s.account_id=${accountId} AND s.purpose=${purpose} ${mode === undefined ? sql`` : sql`AND a.mode=${mode}`} ORDER BY a.revision`,
    );
    return r.rows.map((x) =>
      aesGcmDecrypt(this.key(x.answer_key_id), {
        ciphertext: x.answer_ciphertext,
        nonce: x.answer_nonce,
      }),
    );
  }
  private async insertProposal(
    tx: Tx,
    input: {
      accountId: string;
      sessionId: string;
      purpose: OnboardingPurpose;
      mode: OnboardingMode;
      answerRevision: number;
      modesVersion: number;
      extraction: OnboardingExtraction;
      expiresAt: Date;
    },
  ): Promise<OnboardingProposalRecord> {
    const id = randomUUID();
    const preferences = input.extraction.preferences.map((preference) => ({
      ...preference,
      mode: input.mode,
    }));
    const payload = JSON.stringify({ preferences });
    const encrypted = aesGcmEncrypt(this.key(), payload);
    await tx.execute(
      sql`INSERT INTO onboarding.extraction_proposals(id,session_id,account_id,purpose,mode,answer_revision,modes_version,proposal_version,state,expires_at,confidence,provenance,payload_ciphertext,payload_nonce,payload_key_id,payload_hash,created_at) VALUES (${id},${input.sessionId},${input.accountId},${input.purpose},${input.mode},${input.answerRevision},${input.modesVersion},1,'pending',${input.expiresAt},${input.extraction.confidence},${input.extraction.provenance},${encrypted.ciphertext},${encrypted.nonce},${this.keyId},${canonicalJsonHash(payload)},now())`,
    );
    return {
      proposalId: id,
      sessionId: input.sessionId,
      accountId: input.accountId,
      purpose: input.purpose,
      mode: input.mode,
      answerRevision: input.answerRevision,
      modesVersion: input.modesVersion,
      state: 'pending',
      expiresAt: input.expiresAt,
      confidence: input.extraction.confidence,
      provenance: input.extraction.provenance,
      preferences,
      proposalVersion: 1,
    };
  }
  async saveProposal(input: {
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
  }): Promise<OnboardingProposalRecord> {
    return this.db.transaction(async (tx) => {
      await this.lockEnabledAccount(tx, input.accountId);
      await this.lockIdempotency(tx, input.accountId, input.idempotencyKey);
      const replay = await this.replay<OnboardingProposalRecord>(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
      );
      if (replay) return deserializeProposal(replay);
      const result = await this.insertProposal(tx, input);
      await this.storeIdempotency(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
        serializeProposal(result),
      );
      return result;
    });
  }
  async getProposal(
    accountId: string,
    proposalId: string,
  ): Promise<OnboardingProposalRecord | null> {
    const r = await this.db.execute<ProposalRow>(
      sql`SELECT id,session_id,account_id,purpose,mode,answer_revision,modes_version,proposal_version,state,expires_at,confidence,provenance,payload_ciphertext,payload_nonce,payload_key_id,payload_hash FROM onboarding.extraction_proposals WHERE id=${proposalId} AND account_id=${accountId}`,
    );
    const row = r.rows[0];
    if (!row) return null;
    return toProposal(row, this.key.bind(this));
  }
  async currentPendingProposal(
    accountId: string,
    purpose: OnboardingPurpose,
  ): Promise<OnboardingProposalRecord | null> {
    const r = await this.db.execute<ProposalRow>(
      sql`SELECT p.id,p.session_id,p.account_id,p.purpose,p.mode,p.answer_revision,p.modes_version,p.proposal_version,p.state,p.expires_at,p.confidence,p.provenance,p.payload_ciphertext,p.payload_nonce,p.payload_key_id,p.payload_hash FROM onboarding.extraction_proposals p JOIN onboarding.interview_sessions s ON s.id=p.session_id WHERE p.account_id=${accountId} AND p.purpose=${purpose} AND p.state='pending' AND p.expires_at>now() AND s.state='active' AND p.answer_revision=s.answer_revision AND p.modes_version=s.modes_version ORDER BY p.created_at DESC LIMIT 1`,
    );
    return r.rows[0] ? toProposal(r.rows[0], this.key.bind(this)) : null;
  }

  async withAuthorizedProviderDispatch(
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
  ): Promise<OnboardingProposalRecord> {
    return this.db.transaction(async (tx) => {
      await this.lockEnabledAccount(tx, input.accountId);
      await this.lockIdempotency(tx, input.accountId, input.idempotencyKey);
      const replay = await this.replay<OnboardingProposalRecord>(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
      );
      if (replay) return deserializeProposal(replay);
      const session = await tx.execute<SessionRow>(
        sql`SELECT id,account_id,purpose,modes,modes_version,dating_enabled,state,version,answer_revision FROM onboarding.interview_sessions WHERE id=${input.sessionId} AND account_id=${input.accountId} AND purpose=${input.purpose} AND state='active' FOR UPDATE`,
      );
      const currentSession = session.rows[0];
      if (
        !currentSession ||
        currentSession.answer_revision !== input.answerRevision ||
        currentSession.modes_version !== input.modesVersion ||
        !currentSession.modes.includes(input.mode)
      )
        throw new OnboardingConcurrencyError();
      const consent = await tx.execute<{
        id: string;
        receipt_version: number;
        provider: string;
        granted: boolean;
      }>(
        sql`SELECT id,receipt_version,provider,granted FROM onboarding.provider_consents WHERE account_id=${input.accountId} AND purpose=${input.purpose} AND provider=${input.provider} FOR UPDATE`,
      );
      const current = consent.rows[0];
      if (
        !current ||
        current.id !== input.consentId ||
        current.receipt_version !== input.receiptVersion ||
        current.provider !== input.provider ||
        !current.granted
      )
        throw new Error('onboarding_provider_consent_required');
      const extraction = await dispatch();
      const result = await this.insertProposal(tx, {
        accountId: input.accountId,
        sessionId: input.sessionId,
        purpose: input.purpose,
        mode: input.mode,
        answerRevision: input.answerRevision,
        modesVersion: input.modesVersion,
        extraction,
        expiresAt: input.expiresAt,
      });
      await this.storeIdempotency(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
        serializeProposal(result),
      );
      return result;
    });
  }
  async confirm(input: {
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
  }): Promise<OnboardingPreferencesRecord> {
    return this.db.transaction(async (tx) => {
      await this.lockEnabledAccount(tx, input.accountId);
      await this.lockIdempotency(tx, input.accountId, input.idempotencyKey);
      const replay = await this.replay<OnboardingPreferencesRecord>(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
      );
      if (replay) return deserializePreferences(replay);
      const p = await tx.execute<ProposalRow>(
        sql`SELECT id,session_id,account_id,purpose,mode,answer_revision,modes_version,proposal_version,state,expires_at,confidence,provenance,payload_ciphertext,payload_nonce,payload_key_id,payload_hash FROM onboarding.extraction_proposals WHERE id=${input.proposalId} AND account_id=${input.accountId} FOR UPDATE`,
      );
      const proposal = p.rows[0];
      if (!proposal) throw new Error('onboarding_proposal_not_found');
      const session = await tx.execute<SessionRow>(
        sql`SELECT id,account_id,purpose,modes,modes_version,dating_enabled,state,version,answer_revision FROM onboarding.interview_sessions WHERE id=${input.sessionId} AND account_id=${input.accountId} AND purpose=${input.purpose} AND state='active' FOR UPDATE`,
      );
      const currentSession = session.rows[0];
      if (
        !currentSession ||
        proposal.session_id !== input.sessionId ||
        proposal.purpose !== input.purpose ||
        proposal.answer_revision !== input.expectedAnswerRevision ||
        proposal.modes_version !== input.modesVersion ||
        !input.modes.includes(proposal.mode) ||
        input.preferences.some((preference) => preference.mode !== proposal.mode) ||
        currentSession.answer_revision !== input.expectedAnswerRevision ||
        currentSession.modes_version !== input.modesVersion ||
        JSON.stringify(currentSession.modes) !== JSON.stringify(input.modes)
      )
        throw new OnboardingConcurrencyError();
      if (asDate(proposal.expires_at).getTime() <= Date.now() || proposal.state !== 'pending')
        throw new OnboardingProposalExpiredError();
      const prior = await tx.execute<{ version: number }>(
        sql`SELECT version FROM onboarding.preference_sets WHERE account_id=${input.accountId} AND purpose=${input.purpose} AND current FOR UPDATE`,
      );
      const oldVersion = prior.rows[0]?.version ?? 0;
      if (oldVersion !== input.expectedVersion) throw new OnboardingConcurrencyError();
      const next = oldVersion + 1;
      const priorPreferences = prior.rows[0]
        ? await tx.execute<{
            preferences_ciphertext: string;
            preferences_nonce: string;
            preferences_key_id: string;
          }>(
            sql`SELECT preferences_ciphertext,preferences_nonce,preferences_key_id FROM onboarding.preference_sets WHERE account_id=${input.accountId} AND purpose=${input.purpose} AND current FOR UPDATE`,
          )
        : null;
      const existingPreferences = priorPreferences?.rows[0]
        ? (JSON.parse(
            aesGcmDecrypt(this.key(priorPreferences.rows[0].preferences_key_id), {
              ciphertext: priorPreferences.rows[0].preferences_ciphertext,
              nonce: priorPreferences.rows[0].preferences_nonce,
            }),
          ) as OnboardingPreference[])
        : [];
      const mergedPreferences = mergeModePreferences(
        existingPreferences,
        input.preferences,
        proposal.mode,
      );
      await tx.execute(
        sql`UPDATE onboarding.preference_sets SET current=false WHERE account_id=${input.accountId} AND purpose=${input.purpose} AND current`,
      );
      const now = new Date();
      const record: OnboardingPreferencesRecord = {
        accountId: input.accountId,
        purpose: input.purpose,
        version: next,
        modes: input.modes,
        modesVersion: input.modesVersion,
        preferences: mergedPreferences,
        confirmedAt: now,
      };
      const encrypted = aesGcmEncrypt(this.key(), JSON.stringify(mergedPreferences));
      const normalized = mergedPreferences.map(({ mode, criterion, strength, deal_breaker }) => ({
        mode,
        criterion,
        strength,
        deal_breaker,
      }));
      await tx.execute(
        sql`INSERT INTO onboarding.preference_sets(id,account_id,purpose,version,current,modes,modes_version,normalized_json,preferences_ciphertext,preferences_nonce,preferences_key_id,confirmed_at,source) VALUES (${randomUUID()},${input.accountId},${input.purpose},${next},true,${textArray(input.modes)},${input.modesVersion},${JSON.stringify(normalized)},${encrypted.ciphertext},${encrypted.nonce},${this.keyId},${now},'approved_ai_draft')`,
      );
      await tx.execute(
        sql`UPDATE onboarding.extraction_proposals SET state='confirmed',confirmed_at=${now} WHERE id=${input.proposalId}`,
      );
      await this.storeIdempotency(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
        serializePreferences(record),
      );
      return record;
    });
  }
  async correct(input: {
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
  }): Promise<{ proposalId: string; proposalVersion: number }> {
    return this.db.transaction(async (tx) => {
      await this.lockEnabledAccount(tx, input.accountId);
      await this.lockIdempotency(tx, input.accountId, input.idempotencyKey);
      const replay = await this.replay<unknown>(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
      );
      if (replay) {
        const stored = onboardingCorrectionResponseSchema.parse(replay);
        return { proposalId: stored.proposal_id, proposalVersion: stored.proposal_version };
      }
      const current = await tx.execute<{ version: number }>(
        sql`SELECT version FROM onboarding.preference_sets WHERE account_id=${input.accountId} AND purpose=${input.purpose} AND current FOR UPDATE`,
      );
      if ((current.rows[0]?.version ?? 0) !== input.expectedVersion)
        throw new OnboardingConcurrencyError();
      const p = await tx.execute<ProposalRow>(
        sql`SELECT id,session_id,account_id,purpose,mode,answer_revision,modes_version,proposal_version,state,expires_at,confidence,provenance,payload_ciphertext,payload_nonce,payload_key_id,payload_hash FROM onboarding.extraction_proposals WHERE id=${input.proposalId} AND account_id=${input.accountId} AND session_id=${input.sessionId} AND purpose=${input.purpose} FOR UPDATE`,
      );
      const proposal = p.rows[0];
      if (
        !proposal ||
        proposal.proposal_version !== input.expectedProposalVersion ||
        proposal.state !== 'pending'
      )
        throw new OnboardingConcurrencyError();
      const e = aesGcmEncrypt(this.key(), input.correction);
      await tx.execute(
        sql`INSERT INTO onboarding.corrections(id,account_id,proposal_id,purpose,expected_version,expected_proposal_version,field,correction_ciphertext,correction_nonce,correction_key_id,correction_hash,created_at) VALUES (${randomUUID()},${input.accountId},${input.proposalId},${input.purpose},${input.expectedVersion},${input.expectedProposalVersion},${input.field},${e.ciphertext},${e.nonce},${this.keyId},${canonicalJsonHash(input.correction)},now())`,
      );
      const nextId = randomUUID();
      const priorPayload = JSON.parse(
        aesGcmDecrypt(this.key(proposal.payload_key_id), {
          ciphertext: proposal.payload_ciphertext,
          nonce: proposal.payload_nonce,
        }),
      ) as { preferences: OnboardingPreference[] };
      const correctedPreferences = applyCorrection(
        priorPayload.preferences,
        input.field,
        input.correction,
      );
      const correctedPayload = JSON.stringify({ preferences: correctedPreferences });
      const correctedEncrypted = aesGcmEncrypt(this.key(), correctedPayload);
      await tx.execute(
        sql`INSERT INTO onboarding.extraction_proposals(id,session_id,account_id,purpose,mode,answer_revision,modes_version,proposal_version,state,expires_at,confidence,provenance,payload_ciphertext,payload_nonce,payload_key_id,payload_hash,created_at) VALUES (${nextId},${proposal.session_id},${proposal.account_id},${proposal.purpose},${proposal.mode},${proposal.answer_revision},${proposal.modes_version},${proposal.proposal_version + 1},'pending',now()+interval '15 minutes',${proposal.confidence},'member_correction',${correctedEncrypted.ciphertext},${correctedEncrypted.nonce},${this.keyId},${canonicalJsonHash(correctedPayload)},now())`,
      );
      await tx.execute(
        sql`UPDATE onboarding.extraction_proposals SET state='corrected' WHERE id=${input.proposalId}`,
      );
      await this.storeIdempotency(tx, input.accountId, input.idempotencyKey, input.payloadDigest, {
        corrected: true,
        proposal_id: nextId,
        proposal_version: proposal.proposal_version + 1,
      });
      return { proposalId: nextId, proposalVersion: proposal.proposal_version + 1 };
    });
  }
  async currentPreferences(
    accountId: string,
    purpose: OnboardingPurpose,
  ): Promise<OnboardingPreferencesRecord | null> {
    const r = await this.db.execute<{
      version: number;
      modes: string[];
      modes_version: number;
      preferences_ciphertext: string;
      preferences_nonce: string;
      preferences_key_id: string;
      confirmed_at: Date;
    }>(
      sql`SELECT version,modes,modes_version,preferences_ciphertext,preferences_nonce,preferences_key_id,confirmed_at FROM onboarding.preference_sets WHERE account_id=${accountId} AND purpose=${purpose} AND current`,
    );
    const x = r.rows[0];
    if (!x) return null;
    const parsed = onboardingPreferencesResponseSchema.parse({
      account_id: accountId,
      purpose,
      version: x.version,
      modes: x.modes,
      modes_version: x.modes_version,
      preferences: JSON.parse(
        aesGcmDecrypt(this.key(x.preferences_key_id), {
          ciphertext: x.preferences_ciphertext,
          nonce: x.preferences_nonce,
        }),
      ),
      confirmed_at: asDate(x.confirmed_at).toISOString(),
    });
    return {
      accountId: parsed.account_id,
      purpose: parsed.purpose,
      version: parsed.version,
      modes: parsed.modes,
      modesVersion: parsed.modes_version,
      preferences: parsed.preferences,
      confirmedAt: new Date(parsed.confirmed_at),
    };
  }
  async replacePreferences(input: {
    accountId: string;
    purpose: OnboardingPurpose;
    expectedVersion: number;
    modesVersion: number;
    modes: readonly OnboardingMode[];
    mode: OnboardingMode;
    preferences: readonly OnboardingPreference[];
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingPreferencesRecord> {
    return this.db.transaction(async (tx) => {
      await this.lockEnabledAccount(tx, input.accountId);
      await this.lockIdempotency(tx, input.accountId, input.idempotencyKey);
      const replay = await this.replay<OnboardingPreferencesRecord>(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
      );
      if (replay) return deserializePreferences(replay);
      const p = await tx.execute<{ version: number }>(
        sql`SELECT version FROM onboarding.preference_sets WHERE account_id=${input.accountId} AND purpose=${input.purpose} AND current FOR UPDATE`,
      );
      const current = p.rows[0]?.version ?? 0;
      if (current !== input.expectedVersion) throw new OnboardingConcurrencyError();
      if (!input.modes.includes(input.mode)) throw new OnboardingConcurrencyError();
      const prior = p.rows[0]
        ? await tx.execute<{
            preferences_ciphertext: string;
            preferences_nonce: string;
            preferences_key_id: string;
          }>(
            sql`SELECT preferences_ciphertext,preferences_nonce,preferences_key_id FROM onboarding.preference_sets WHERE account_id=${input.accountId} AND purpose=${input.purpose} AND current FOR UPDATE`,
          )
        : null;
      if (input.preferences.some((preference) => preference.mode !== input.mode))
        throw new OnboardingConcurrencyError();
      const existingPreferences = prior?.rows[0]
        ? (JSON.parse(
            aesGcmDecrypt(this.key(prior.rows[0].preferences_key_id), {
              ciphertext: prior.rows[0].preferences_ciphertext,
              nonce: prior.rows[0].preferences_nonce,
            }),
          ) as OnboardingPreference[])
        : [];
      const mergedPreferences = mergeModePreferences(
        existingPreferences,
        input.preferences,
        input.mode,
      );
      const now = new Date(),
        next = current + 1;
      await tx.execute(
        sql`UPDATE onboarding.preference_sets SET current=false WHERE account_id=${input.accountId} AND purpose=${input.purpose} AND current`,
      );
      const encrypted = aesGcmEncrypt(this.key(), JSON.stringify(mergedPreferences));
      const normalized = mergedPreferences.map(({ mode, criterion, strength, deal_breaker }) => ({
        mode,
        criterion,
        strength,
        deal_breaker,
      }));
      await tx.execute(
        sql`INSERT INTO onboarding.preference_sets(id,account_id,purpose,version,current,modes,modes_version,normalized_json,preferences_ciphertext,preferences_nonce,preferences_key_id,confirmed_at,source) VALUES (${randomUUID()},${input.accountId},${input.purpose},${next},true,${textArray(input.modes)},${input.modesVersion},${JSON.stringify(normalized)},${encrypted.ciphertext},${encrypted.nonce},${this.keyId},${now},'manual')`,
      );
      const out = {
        accountId: input.accountId,
        purpose: input.purpose,
        version: next,
        modes: input.modes,
        modesVersion: input.modesVersion,
        preferences: mergedPreferences,
        confirmedAt: now,
      };
      await this.storeIdempotency(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
        serializePreferences(out),
      );
      return out;
    });
  }
  async saveConsent(input: {
    accountId: string;
    purpose: OnboardingPurpose;
    provider: string;
    receiptVersion: number;
    retention: ConsentRetention;
    granted: boolean;
    idempotencyKey: string;
    payloadDigest: string;
  }): Promise<OnboardingProviderConsent> {
    return this.db.transaction(async (tx) => {
      await this.lockEnabledAccount(tx, input.accountId);
      await this.lockIdempotency(tx, input.accountId, input.idempotencyKey);
      const replay = await this.replay<OnboardingProviderConsent>(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
      );
      if (replay) return deserializeConsent(replay);
      const prior = await tx.execute<{ receipt_version: number }>(
        sql`SELECT receipt_version FROM onboarding.provider_consents WHERE account_id=${input.accountId} AND purpose=${input.purpose} AND provider=${input.provider} FOR UPDATE`,
      );
      const expected = (prior.rows[0]?.receipt_version ?? 0) + 1;
      if (input.receiptVersion !== expected) throw new OnboardingConcurrencyError();
      const id = randomUUID(),
        now = new Date(),
        withdrawn = input.granted ? null : now;
      await tx.execute(
        sql`INSERT INTO onboarding.consent_receipts(id,account_id,purpose,provider,receipt_version,retention,granted,recorded_at) VALUES (${id},${input.accountId},${input.purpose},${input.provider},${input.receiptVersion},${input.retention},${input.granted},${now})`,
      );
      await tx.execute(
        sql`INSERT INTO onboarding.provider_consents(id,account_id,purpose,provider,receipt_version,retention,granted,granted_at,withdrawn_at) VALUES (${id},${input.accountId},${input.purpose},${input.provider},${input.receiptVersion},${input.retention},${input.granted},${now},${withdrawn}) ON CONFLICT(account_id,purpose,provider) DO UPDATE SET id=excluded.id,receipt_version=excluded.receipt_version,retention=excluded.retention,granted=excluded.granted,granted_at=excluded.granted_at,withdrawn_at=excluded.withdrawn_at`,
      );
      const result = {
        consentId: id,
        accountId: input.accountId,
        purpose: input.purpose,
        provider: input.provider,
        receiptVersion: input.receiptVersion,
        retention: input.retention,
        granted: input.granted,
        withdrawnAt: withdrawn,
      };
      await this.storeIdempotency(
        tx,
        input.accountId,
        input.idempotencyKey,
        input.payloadDigest,
        serializeConsent(result),
      );
      return result;
    });
  }
  async currentConsent(
    accountId: string,
    purpose: OnboardingPurpose,
    provider: string,
  ): Promise<OnboardingProviderConsent | null> {
    const r = await this.db.execute<{
      id: string;
      purpose: OnboardingPurpose;
      provider: string;
      receipt_version: number;
      retention: ConsentRetention;
      granted: boolean;
      withdrawn_at: Date | null;
    }>(
      sql`SELECT id,purpose,provider,receipt_version,retention,granted,withdrawn_at FROM onboarding.provider_consents WHERE account_id=${accountId} AND purpose=${purpose} AND provider=${provider}`,
    );
    const x = r.rows[0];
    return x
      ? {
          consentId: x.id,
          accountId,
          purpose: x.purpose,
          provider: x.provider,
          receiptVersion: x.receipt_version,
          retention: x.retention,
          granted: x.granted,
          withdrawnAt: x.withdrawn_at ? asDate(x.withdrawn_at) : null,
        }
      : null;
  }
  private async replay<T>(
    tx: Tx,
    accountId: string,
    key: string,
    digest: string,
  ): Promise<T | null> {
    const kd = canonicalJsonHash(key);
    const r = await tx.execute<IdempotencyRow>(
      sql`SELECT payload_digest,result_ciphertext,result_nonce,result_key_id FROM onboarding.idempotency_keys WHERE account_id=${accountId} AND key_digest=${kd} FOR UPDATE`,
    );
    const x = r.rows[0];
    if (!x) return null;
    if (x.payload_digest !== digest) throw new OnboardingIdempotencyConflictError();
    return JSON.parse(
      aesGcmDecrypt(this.key(x.result_key_id), {
        ciphertext: x.result_ciphertext,
        nonce: x.result_nonce,
      }),
    ) as T;
  }
  private async storeIdempotency(
    tx: Tx,
    accountId: string,
    key: string,
    digest: string,
    result: unknown,
  ): Promise<void> {
    const encrypted = aesGcmEncrypt(this.key(), JSON.stringify(result));
    await tx.execute(
      sql`INSERT INTO onboarding.idempotency_keys(account_id,key_digest,payload_digest,result_ciphertext,result_nonce,result_key_id,created_at) VALUES (${accountId},${canonicalJsonHash(key)},${digest},${encrypted.ciphertext},${encrypted.nonce},${this.keyId},now())`,
    );
  }
  private async lockIdempotency(tx: Tx, accountId: string, key: string): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${accountId} || ':' || ${canonicalJsonHash(key)}, 0))`,
    );
  }
  private async lockEnabledAccount(tx: Tx, accountId: string): Promise<void> {
    const result = await tx.execute<{ state: string }>(
      sql`SELECT state FROM iam.accounts WHERE id=${accountId} FOR UPDATE`,
    );
    if (result.rows[0]?.state !== 'enabled') throw new Error('onboarding_account_disabled');
  }
}

function textArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toProposal(row: ProposalRow, key: (id?: string) => Buffer): OnboardingProposalRecord {
  const decoded: unknown = JSON.parse(
    aesGcmDecrypt(key(row.payload_key_id), {
      ciphertext: row.payload_ciphertext,
      nonce: row.payload_nonce,
    }),
  );
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Object.keys(decoded).length !== 1 ||
    !('preferences' in decoded) ||
    !Array.isArray(decoded.preferences)
  )
    throw new Error('onboarding_idempotency_result_invalid');
  const payload = {
    preferences: decoded.preferences.map((preference) =>
      onboardingPreferenceSchema.parse(preference),
    ),
  };
  const expiresAt = asDate(row.expires_at);
  const expired = row.state === 'pending' && expiresAt.getTime() <= Date.now();
  return {
    proposalId: row.id,
    sessionId: row.session_id,
    accountId: row.account_id,
    purpose: row.purpose,
    mode: row.mode,
    answerRevision: row.answer_revision,
    modesVersion: row.modes_version,
    state: expired ? 'expired' : row.state,
    expiresAt,
    confidence: Number(row.confidence),
    provenance: row.provenance,
    preferences: payload.preferences,
    proposalVersion: row.proposal_version,
  };
}

function mergeModePreferences(
  existing: readonly OnboardingPreference[],
  incoming: readonly OnboardingPreference[],
  mode: OnboardingMode,
): OnboardingPreference[] {
  return [
    ...existing.filter((preference) => preference.mode !== mode),
    ...incoming.map((preference) => ({ ...preference, mode })),
  ];
}

const storedSessionSchema = onboardingSessionResponseSchema
  .extend({ account_id: onboardingSessionResponseSchema.shape.session_id })
  .strict();

function serializeSession(value: OnboardingSessionRecord) {
  return {
    session_id: value.sessionId,
    account_id: value.accountId,
    purpose: value.purpose,
    modes: [...value.modes],
    modes_version: value.modesVersion,
    dating_enabled: value.datingEnabled,
    state: value.state,
    version: value.version,
    answer_revision: value.answerRevision,
  };
}
function deserializeSession(value: unknown): OnboardingSessionRecord {
  const stored = storedSessionSchema.parse(value);
  return {
    sessionId: stored.session_id,
    accountId: stored.account_id,
    purpose: stored.purpose,
    modes: stored.modes,
    modesVersion: stored.modes_version,
    datingEnabled: stored.dating_enabled,
    state: stored.state,
    version: stored.version,
    answerRevision: stored.answer_revision,
  };
}

function serializeProposal(value: OnboardingProposalRecord) {
  return {
    account_id: value.accountId,
    proposal_id: value.proposalId,
    session_id: value.sessionId,
    purpose: value.purpose,
    mode: value.mode,
    answer_revision: value.answerRevision,
    modes_version: value.modesVersion,
    proposal_version: value.proposalVersion,
    state: value.state,
    expires_at: value.expiresAt.toISOString(),
    confidence: value.confidence,
    provenance: value.provenance,
    preferences: value.preferences,
    ai_draft: true,
  };
}
function deserializeProposal(value: unknown): OnboardingProposalRecord {
  const stored = onboardingProposalResponseSchema
    .extend({ account_id: onboardingSessionResponseSchema.shape.session_id })
    .parse(value);
  return {
    proposalId: stored.proposal_id,
    sessionId: stored.session_id,
    accountId: stored.account_id,
    purpose: stored.purpose,
    mode: stored.mode,
    answerRevision: stored.answer_revision,
    modesVersion: stored.modes_version,
    proposalVersion: stored.proposal_version,
    state: stored.state,
    expiresAt: new Date(stored.expires_at),
    confidence: stored.confidence,
    provenance: stored.provenance,
    preferences: stored.preferences,
  };
}

type StoredPreferences = {
  account_id: string;
  purpose: OnboardingPurpose;
  version: number;
  modes: OnboardingMode[];
  modes_version: number;
  preferences: OnboardingPreference[];
  confirmed_at: string;
};

function serializePreferences(value: OnboardingPreferencesRecord): StoredPreferences {
  return onboardingPreferencesResponseSchema.parse({
    account_id: value.accountId,
    purpose: value.purpose,
    version: value.version,
    modes: [...value.modes],
    modes_version: value.modesVersion,
    preferences: [...value.preferences],
    confirmed_at: value.confirmedAt.toISOString(),
  }) as StoredPreferences;
}

function deserializePreferences(value: unknown): OnboardingPreferencesRecord {
  const stored = onboardingPreferencesResponseSchema.parse(value) as StoredPreferences;
  return {
    accountId: stored.account_id,
    purpose: stored.purpose,
    version: stored.version,
    modes: stored.modes,
    modesVersion: stored.modes_version,
    preferences: stored.preferences,
    confirmedAt: new Date(stored.confirmed_at),
  };
}

function serializeConsent(value: OnboardingProviderConsent) {
  return {
    account_id: value.accountId,
    consent_id: value.consentId,
    purpose: value.purpose,
    provider: value.provider,
    receipt_version: value.receiptVersion,
    retention: value.retention,
    granted: value.granted,
    withdrawn_at: value.withdrawnAt?.toISOString() ?? null,
  };
}
function deserializeConsent(value: unknown): OnboardingProviderConsent {
  const stored = onboardingConsentResponseSchema
    .extend({ account_id: onboardingSessionResponseSchema.shape.session_id })
    .parse(value);
  return {
    consentId: stored.consent_id,
    accountId: stored.account_id,
    purpose: stored.purpose,
    provider: stored.provider,
    receiptVersion: stored.receipt_version,
    retention: stored.retention,
    granted: stored.granted,
    withdrawnAt: stored.withdrawn_at ? new Date(stored.withdrawn_at) : null,
  };
}

function applyCorrection(
  preferences: readonly OnboardingPreference[],
  field: string,
  correction: string,
): OnboardingPreference[] {
  const index = preferences.findIndex((preference) => preference.criterion === field);
  if (index < 0) throw new Error('onboarding_correction_field_not_found');
  return preferences.map((preference, current) =>
    current === index ? { ...preference, value: correction } : { ...preference },
  );
}
function toSession(x: SessionRow | undefined): OnboardingSessionRecord {
  if (!x) throw new Error('onboarding_session_not_found');
  return {
    sessionId: x.id,
    accountId: x.account_id,
    purpose: x.purpose,
    modes: x.modes as OnboardingMode[],
    modesVersion: x.modes_version,
    datingEnabled: x.dating_enabled,
    state: x.state,
    version: x.version,
    answerRevision: x.answer_revision,
  };
}
export function createOnboardingRepository(
  db: Db,
  keys: Keyring,
  keyId: string,
): PgOnboardingRepository {
  return new PgOnboardingRepository(db, keys, keyId);
}
