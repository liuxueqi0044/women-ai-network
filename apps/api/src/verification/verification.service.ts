import { Inject, Injectable } from '@nestjs/common';
import { aesGcmEncrypt, hmacDigest, parsePiiKeys, PgVerificationRepository } from '@wai/db';
import type { AppConfig } from '@wai/config';
import type {
  IdentitySessionResponse,
  IdentityVerificationProviderPort,
  AppealReviewReasonCode,
  MembershipDecisionReasonCode,
  MembershipReviewPort,
  VerificationStatus,
} from '@wai/contracts';
import type { Pool } from 'pg';
import { APP_CONFIG, IAM_POOL } from '../tokens.js';
import { VERIFICATION_PROVIDER } from './verification.tokens.js';

/** PostgreSQL-backed application service; no process-local state is authoritative. */
@Injectable()
export class VerificationService implements MembershipReviewPort {
  private readonly repo: PgVerificationRepository;
  private readonly key: Buffer;
  private readonly keyId: string;
  constructor(
    @Inject(VERIFICATION_PROVIDER) private readonly provider: IdentityVerificationProviderPort,
    @Inject(IAM_POOL) pool: Pool,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.repo = new PgVerificationRepository(pool);
    const key = parsePiiKeys(config.iam.piiKeysJson).get(config.iam.piiKeyId);
    if (key === undefined) throw new Error('verification key is not configured');
    this.key = key;
    this.keyId = config.iam.piiKeyId;
  }
  async createIdentitySession(
    accountId: string,
    idempotencyKey: string,
  ): Promise<IdentitySessionResponse> {
    const now = new Date();
    const ids = await this.repo.createCase(accountId, idempotencyKey, this.provider.name, now);
    if (ids.existing && !['created', 'failed'].includes(ids.attemptState)) {
      return { session_id: ids.attemptId, expires_at: ids.expiresAt.toISOString() };
    }
    try {
      const session = await this.provider.createSession({
        caseId: ids.caseId,
        attemptId: ids.attemptId,
        accountReference: `case_${ids.caseId}`,
        idempotencyKey,
      });
      const encrypted = aesGcmEncrypt(this.key, session.providerSessionReference);
      await this.repo.saveSession(
        ids.attemptId,
        {
          ...encrypted,
          keyId: this.keyId,
          digest: hmacDigest(
            this.key,
            'verification:session_reference',
            session.providerSessionReference,
          ),
        },
        new Date(session.expiresAt),
      );
      return {
        session_id: ids.attemptId,
        client_token: session.clientToken,
        expires_at: session.expiresAt,
      };
    } catch (error) {
      await this.repo.markSessionFailure(ids.caseId, ids.attemptId, new Date());
      throw error;
    }
  }
  async status(accountId: string): Promise<VerificationStatus> {
    const value = await this.repo.status(accountId);
    const obligations: VerificationStatus['obligations'] = [];
    if (value.identity !== 'verified')
      obligations.push(
        value.identity === 'needs_review'
          ? 'VERIFICATION_NEEDS_REVIEW'
          : 'IDENTITY_VERIFICATION_REQUIRED',
      );
    if (value.age_assurance !== 'attested')
      obligations.push(
        value.age_assurance === 'mismatch' ? 'AGE_ASSURANCE_MISMATCH' : 'AGE_ASSURANCE_REQUIRED',
      );
    if (value.membership === 'not_applied') obligations.push('MEMBERSHIP_APPLICATION_REQUIRED');
    else if (value.membership === 'submitted' || value.membership === 'under_review')
      obligations.push('MEMBERSHIP_REVIEW_PENDING');
    else if (value.membership === 'rejected') obligations.push('MEMBERSHIP_DENIED');
    return {
      identity: value.identity as VerificationStatus['identity'],
      age_assurance: value.age_assurance as VerificationStatus['age_assurance'],
      membership: value.membership as VerificationStatus['membership'],
      appeal: value.appeal as VerificationStatus['appeal'],
      obligations,
    };
  }
  async applyMembership(
    accountId: string,
    policyId: string,
    revision: number,
    statementCategory: 'community_participation' | 'safety_commitment',
  ): Promise<VerificationStatus> {
    await this.repo.insertMembership(accountId, policyId, revision, statementCategory, new Date());
    return this.status(accountId);
  }
  async reviewMembership(
    caseId: string,
    reviewer: string,
    decision: 'approved' | 'rejected',
    reason: MembershipDecisionReasonCode,
  ): Promise<void> {
    await this.repo.reviewMembership(caseId, reviewer, decision, reason);
  }
  async review(input: {
    caseId: string;
    reviewerPrincipal: string;
    decision: 'approved' | 'rejected';
    reasonCode: MembershipDecisionReasonCode;
  }): Promise<void> {
    await this.reviewMembership(
      input.caseId,
      input.reviewerPrincipal,
      input.decision,
      input.reasonCode,
    );
  }
  async reviewAppeal(input: {
    appealId: string;
    reviewerPrincipal: string;
    decision: 'upheld' | 'overturned';
    reasonCode: AppealReviewReasonCode;
  }): Promise<void> {
    await this.repo.reviewAppeal(
      input.appealId,
      input.reviewerPrincipal,
      input.decision,
      input.reasonCode,
    );
  }
  async appeal(
    accountId: string,
    category: string,
    statement: string,
  ): Promise<VerificationStatus> {
    const encrypted = aesGcmEncrypt(this.key, statement);
    await this.repo.createAppeal(accountId, category, { ...encrypted, keyId: this.keyId });
    return this.status(accountId);
  }
  async requestRedaction(accountId: string): Promise<VerificationStatus> {
    await this.repo.requestRedaction(accountId);
    return this.status(accountId);
  }
}
