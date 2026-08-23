import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  circleCreateRequestSchema,
  circlePatchRequestSchema,
  circleListQuerySchema,
  circleInviteRequestSchema,
  circleJoinRequestSchema,
  circleRoleRequestSchema,
  circleNoteRequestSchema,
  reportCreateRequestSchema,
  canonicalEvidenceSnapshotSchema,
  type CircleRepositoryPort,
  type CircleGrowthGatePort,
  type CircleRole,
} from '@wai/contracts';
import { hmacDigest, parsePepper } from '@wai/db';
import type { AppConfig } from '@wai/config';
import { APP_CONFIG } from '../tokens.js';
import { RATE_LIMITER, type RateLimiter } from '../account/ports.js';
import { CIRCLE_GATE, CIRCLE_REPOSITORY } from './circles.tokens.js';
import { SafetyService } from '../safety/safety.service.js';

@Injectable()
export class CirclesService {
  private readonly key: Buffer;
  constructor(
    @Inject(CIRCLE_REPOSITORY) private readonly repo: CircleRepositoryPort,
    @Inject(CIRCLE_GATE) private readonly gate: CircleGrowthGatePort,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(SafetyService) private readonly safety: Pick<SafetyService, 'reportWithSnapshot'>,
  ) {
    this.key = parsePepper(config.iam.secretPepper);
  }
  private digest(op: string, path: string, body: unknown) {
    return hmacDigest(this.key, `circle:${op}`, `${path}\0${JSON.stringify(body)}`);
  }
  private async final(
    actor: string,
    id: string,
    operation: 'read' | 'mutate' | 'escape',
    requiredRole?: CircleRole,
  ) {
    const x = await this.gate.check({
      actorAccountId: actor,
      circleId: id,
      operation,
      ...(requiredRole ? { requiredRole } : {}),
    });
    if (!x.allowed) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Circle not found' });
    return x;
  }
  async create(actor: string, body: unknown, key: string) {
    const input = circleCreateRequestSchema.parse(body);
    await this.limit(actor, 'create');
    const result = await this.repo.create(
      actor,
      input,
      this.digest('create', '/circles', input),
      key,
    );
    await this.final(actor, result.id, 'read');
    return result;
  }
  async list(actor: string, query: unknown) {
    const q = circleListQuerySchema.parse(query ?? {});
    const page = await this.repo.list(actor, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
      ...(q.mode ? { mode: q.mode } : {}),
    });
    const items = [];
    for (const row of page.items) {
      const g = await this.gate.check({
        actorAccountId: actor,
        circleId: row.id,
        operation: 'read',
      });
      if (g.allowed) items.push(row);
    }
    return { ...page, items };
  }
  async get(actor: string, id: string) {
    await this.final(actor, id, 'read');
    const detail = await this.repo.get(actor, id);
    await this.final(actor, id, 'read');
    return detail;
  }
  async patch(actor: string, id: string, body: unknown, key: string) {
    const input = circlePatchRequestSchema.parse(body);
    await this.limit(actor, 'mutate');
    const result = await this.repo.patch(
      actor,
      id,
      input,
      this.digest('patch', `/circles/${id}`, input),
      key,
    );
    // Archiving is a terminal transition. The repository completes its owner
    // gate in the same transaction; a normal read gate must remain closed
    // afterwards without turning a committed archive into a false error.
    if (result.lifecycle !== 'archived') await this.final(actor, id, 'read');
    return result;
  }
  async invite(actor: string, id: string, body: unknown, key: string) {
    await this.final(actor, id, 'mutate', 'moderator');
    const input = circleInviteRequestSchema.parse(body);
    await this.limit(actor, 'invite');
    const created = await this.repo.invite(
      actor,
      id,
      input,
      this.digest('invite', `/circles/${id}/invitations`, input),
      key,
    );
    // The repository commits an opaque invitation-id handoff in the same
    // PostgreSQL transaction. NTF delivery/reconciliation is deliberately
    // asynchronous and cannot change circle correctness.
    await this.final(actor, id, 'read');
    return created;
  }
  async join(actor: string, id: string, body: unknown, key: string) {
    const input = circleJoinRequestSchema.parse(body ?? {});
    await this.limit(actor, 'join');
    await this.repo.join(
      actor,
      id,
      input,
      this.digest('join', `/circles/${id}/join-requests`, input),
      key,
    );
    await this.final(actor, id, 'escape');
  }
  async leave(actor: string, id: string, key: string) {
    // Leaving is an escape action: only the repository's resource-bound
    // membership check applies. A later VER/ELG/SAF revocation must not trap
    // an existing member in a Circle.
    const result = await this.repo.leave(
      actor,
      id,
      this.digest('leave', `/circles/${id}/leave`, {}),
      key,
    );
    return result;
  }
  async withdrawJoin(actor: string, id: string, key: string) {
    // Deliberate escape: current eligibility/block decisions cannot strand a
    // pending applicant. It has its own bucket, never the growth bucket.
    await this.limit(actor, 'withdraw');
    return this.repo.withdrawJoin(
      actor,
      id,
      this.digest('join:withdraw', `/circles/${id}/join-requests/withdraw`, {}),
      key,
    );
  }
  async member(
    actor: string,
    id: string,
    memberId: string,
    action: 'approve' | 'decline' | 'remove' | 'role',
    body: unknown,
    key: string,
  ) {
    await this.final(actor, id, 'mutate', action === 'role' ? 'owner' : 'moderator');
    await this.limit(actor, 'member');
    const role = action === 'role' ? circleRoleRequestSchema.parse(body).role : undefined;
    const result = await this.repo.memberAction(
      actor,
      id,
      memberId,
      action,
      role,
      this.digest(action, `/circles/${id}/members/${memberId}`, { action, role }),
      key,
    );
    await this.final(actor, id, 'read');
    return result;
  }
  async invitation(
    actor: string,
    id: string,
    invitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    key: string,
  ) {
    const input = { invitation_id: invitationId, action };
    if (action === 'cancel') {
      await this.final(actor, id, 'mutate', 'moderator');
      await this.limit(actor, 'invite');
      return this.repo.cancelInvitation(
        actor,
        id,
        invitationId,
        this.digest('invitation:cancel', `/circles/${id}/invitations/${invitationId}`, input),
        key,
      );
    }
    // Declining an invitation is likewise an escape action. Acceptance is
    // gated synchronously inside the transaction by the repository.
    if (action === 'accept') await this.limit(actor, 'join');
    await this.repo.respondInvitation(
      actor,
      id,
      invitationId,
      action,
      this.digest(`invitation:${action}`, `/circles/${id}/invitations/${invitationId}`, input),
      key,
    );
    if (action === 'accept') await this.final(actor, id, 'read');
  }
  async addNote(actor: string, id: string, body: unknown, key: string) {
    await this.final(actor, id, 'mutate');
    const input = circleNoteRequestSchema.parse(body);
    await this.limit(actor, 'note');
    const result = await this.repo.addNote(
      actor,
      id,
      input.body,
      this.digest('note', `/circles/${id}/notes`, input),
      key,
    );
    await this.final(actor, id, 'read');
    return result;
  }
  async notes(actor: string, id: string, query: unknown) {
    await this.final(actor, id, 'read');
    const q = circleListQuerySchema.pick({ limit: true, cursor: true }).parse(query ?? {});
    const result = await this.repo.listNotes(actor, id, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    // Repository-side gates protect the scan; this response-final pass closes
    // the TOCTOU window before a decrypted author/body can leave the service.
    const items = [];
    for (const row of result.items) {
      const subject = await this.gate.check({
        actorAccountId: actor,
        circleId: id,
        subjectAccountId: row.author_account_id,
        operation: 'read',
      });
      if (subject.allowed) items.push(row);
    }
    await this.final(actor, id, 'read');
    return { ...result, items };
  }
  async members(actor: string, id: string, query: unknown) {
    await this.final(actor, id, 'read');
    const q = circleListQuerySchema.pick({ limit: true, cursor: true }).parse(query ?? {});
    const result = await this.repo.listMembers(actor, id, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    const items = [];
    for (const row of result.items) {
      const subject = await this.gate.check({
        actorAccountId: actor,
        circleId: id,
        subjectAccountId: row.account_id,
        operation: 'read',
      });
      if (subject.allowed) items.push(row);
    }
    await this.final(actor, id, 'read');
    return { ...result, items };
  }
  async joinRequests(actor: string, id: string, query: unknown) {
    await this.final(actor, id, 'read', 'moderator');
    const q = circleListQuerySchema.pick({ limit: true, cursor: true }).parse(query ?? {});
    const result = await this.repo.listJoinRequests(actor, id, {
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
    });
    const items = [];
    for (const row of result.items) {
      const subject = await this.gate.check({
        actorAccountId: actor,
        circleId: id,
        subjectAccountId: row.account_id,
        operation: 'admit',
        requiredRole: 'moderator',
      });
      if (subject.allowed) items.push(row);
    }
    await this.final(actor, id, 'read', 'moderator');
    return { ...result, items };
  }
  async report(
    actor: string,
    targetType: 'circle' | 'note',
    targetId: string,
    body: unknown,
    circleId?: string,
  ) {
    const input = reportCreateRequestSchema.parse(body);
    await this.limit(actor, 'report');
    if (input.target_type !== targetType || input.target_id !== targetId)
      throw new HttpException(
        { code: 'VALIDATION_ERROR', message: 'Report target is invalid' },
        400,
      );
    // Reporting is a safety escape action. This bypasses ordinary Circle
    // growth gates but is resource/history-bound and emits only metadata.
    const evidence = await this.repo.reportableEvidence(actor, targetType, targetId, circleId);
    if (!evidence || evidence.subjectAccountId !== input.subject_account_id)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Circle not found' });
    const snapshot = canonicalEvidenceSnapshotSchema.parse(
      targetType === 'circle'
        ? {
            schemaVersion: 1,
            targetType: 'circle',
            reference: { targetType: 'circle', targetId, sourceVersion: evidence.sourceVersion },
            capturedAt: new Date().toISOString(),
            category: input.category,
            safeMetadata: {
              circle_version: evidence.sourceVersion,
              lifecycle: 'lifecycle' in evidence ? evidence.lifecycle : 'archived',
            },
          }
        : {
            schemaVersion: 1,
            targetType: 'note',
            reference: { targetType: 'note', targetId, sourceVersion: evidence.sourceVersion },
            capturedAt: new Date().toISOString(),
            category: input.category,
            safeMetadata: {
              note_version: evidence.sourceVersion,
              moderation_state:
                'moderationState' in evidence ? evidence.moderationState : 'removed',
            },
          },
    );
    return this.safety.reportWithSnapshot(actor, input, snapshot);
  }
  private async limit(actor: string, bucket: string) {
    // Escape operations (leave, decline, report) deliberately never share a
    // growth bucket. A hostile actor cannot consume a member's exit route.
    const result = await this.limiter.consume(`circles:${bucket}:${actor}`, 30, 3600);
    if (!result.allowed)
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Circle request rate limit exceeded' },
        429,
      );
  }
}
