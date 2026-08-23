import {
  Inject,
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  canonicalEvidenceSnapshotSchema,
  type CanonicalEvidenceSnapshotValidated,
  type EvidenceSnapshotPort,
  type CanonicalEvidenceSnapshot,
  type ReportCreateRequest,
} from '@wai/contracts';
import type { PgSafetyRepository } from '@wai/db';
import { EVIDENCE_PROVIDER, SAFETY_REPOSITORY } from './tokens.js';
@Injectable()
export class SafetyService {
  constructor(
    @Inject(SAFETY_REPOSITORY) private readonly repo: PgSafetyRepository,
    @Inject(EVIDENCE_PROVIDER) private readonly evidence: EvidenceSnapshotPort,
  ) {}
  async block(
    accountId: string,
    input: { blocked_account_id: string; reason: string; idempotency_key: string },
  ) {
    try {
      return await this.repo.createBlock({
        blockerAccountId: accountId,
        blockedAccountId: input.blocked_account_id,
        reason: input.reason,
        idempotencyKey: input.idempotency_key,
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'SELF_BLOCK_FORBIDDEN')
        throw new ForbiddenException({
          code: 'SELF_BLOCK_FORBIDDEN',
          message: 'Cannot block this account',
        });
      if (e instanceof Error && e.message === 'BLOCK_ALREADY_ACTIVE')
        throw new ConflictException({
          code: 'BLOCK_ALREADY_ACTIVE',
          message: 'Block already active',
        });
      if (e instanceof Error && e.message === 'IDEMPOTENCY_CONFLICT')
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key conflict',
        });
      throw e;
    }
  }
  /** Used by trusted product evidence adapters after they have performed their
   * own participant/target authorization. The vault/repository remains SAF's
   * single durable authority. */
  async reportWithSnapshot(
    accountId: string,
    input: ReportCreateRequest,
    snapshot: CanonicalEvidenceSnapshot,
  ) {
    try {
      return await this.repo.createReport({
        reporterAccountId: accountId,
        subjectAccountId: input.subject_account_id,
        targetType: input.target_type,
        targetId: input.target_id,
        category: input.category,
        idempotencyKey: input.idempotency_key,
        snapshot,
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'SELF_REPORT_FORBIDDEN')
        throw new ForbiddenException({
          code: 'SELF_REPORT_FORBIDDEN',
          message: 'Cannot report this account',
        });
      if (e instanceof Error && e.message === 'IDEMPOTENCY_CONFLICT')
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key conflict',
        });
      throw e;
    }
  }
  revoke(accountId: string, target: string) {
    return this.repo.revokeBlock(accountId, target);
  }
  list(accountId: string) {
    return this.repo.listBlocks(accountId);
  }
  async report(accountId: string, input: ReportCreateRequest) {
    let snapshot: CanonicalEvidenceSnapshotValidated;
    try {
      const captured = await this.evidence.capture(
        { targetType: input.target_type, targetId: input.target_id, sourceVersion: null },
        accountId,
        input.subject_account_id,
        input.category,
      );
      if (captured === null) throw new Error('TARGET_UNAVAILABLE');
      snapshot = canonicalEvidenceSnapshotSchema.parse(captured);
      if (
        snapshot.targetType !== input.target_type ||
        snapshot.reference.targetType !== input.target_type ||
        snapshot.reference.targetId !== input.target_id ||
        snapshot.category !== input.category
      )
        throw new Error('TARGET_UNAVAILABLE');
    } catch {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Target not found' });
    }
    try {
      return await this.repo.createReport({
        reporterAccountId: accountId,
        subjectAccountId: input.subject_account_id,
        targetType: input.target_type,
        targetId: input.target_id,
        category: input.category,
        idempotencyKey: input.idempotency_key,
        snapshot,
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'SELF_REPORT_FORBIDDEN')
        throw new ForbiddenException({
          code: 'SELF_REPORT_FORBIDDEN',
          message: 'Cannot report this account',
        });
      if (e instanceof Error && e.message === 'IDEMPOTENCY_CONFLICT')
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency key conflict',
        });
      throw e;
    }
  }
  async getReport(accountId: string, id: string) {
    const r = await this.repo.getReport(id, accountId);
    if (!r) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Report not found' });
    return r;
  }
  async appeal(accountId: string, id: string, input: { category: string; statement: string }) {
    try {
      return await this.repo.createAppeal({
        actionId: id,
        appellantAccountId: accountId,
        category: input.category,
        statement: input.statement,
      });
    } catch (e) {
      if (e instanceof Error && e.message === 'APPEAL_ALREADY_OPEN')
        throw new ConflictException({
          code: 'APPEAL_ALREADY_OPEN',
          message: 'Appeal already open',
        });
      if (e instanceof Error && e.message === 'ACTION_NOT_FOUND')
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Action not found' });
      throw e;
    }
  }
}
