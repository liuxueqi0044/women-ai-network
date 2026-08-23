import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  connectionListResponseSchema,
  connectionResponseSchema,
  type ConnectionListQuery,
  type ConnectionRepositoryPort,
  type ConnectionRequest,
  type ConnectionRow,
  type InteractionGatePort,
} from '@wai/contracts';
import type { RateLimiter } from '../account/ports.js';
import { RATE_LIMITER } from '../account/ports.js';
import { CONNECTION_GATE, CONNECTION_REPOSITORY } from './connection.tokens.js';

@Injectable()
export class ConnectionService {
  constructor(
    @Inject(CONNECTION_REPOSITORY) private readonly repository: ConnectionRepositoryPort,
    @Inject(CONNECTION_GATE) private readonly gate: InteractionGatePort,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async request(actorAccountId: string, input: ConnectionRequest, idempotencyKey: string) {
    try {
      const replay = await this.repository.replayCreateRequest({
        actorAccountId,
        recipientAccountId: input.recipient_account_id,
        mode: input.mode,
        idempotencyKey,
      });
      if (replay !== null) return toPublic(replay);
    } catch (error) {
      throw mapRepositoryError(error);
    }
    if (actorAccountId === input.recipient_account_id)
      throw new HttpException(
        { code: 'VALIDATION_ERROR', message: 'Cannot connect to yourself' },
        400,
      );
    await this.enforceRateLimits(actorAccountId, input.recipient_account_id);
    const decision = await this.gate.check({
      actorAccountId,
      subjectAccountId: input.recipient_account_id,
      capability: 'introduce',
      mode: input.mode,
      surface: 'matching',
    });
    if (!decision.allowed) throw unavailableInteraction();
    try {
      return toPublic(
        await this.repository.createRequest({
          actorAccountId,
          recipientAccountId: input.recipient_account_id,
          mode: input.mode,
          idempotencyKey,
        }),
      );
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async action(
    actorAccountId: string,
    connectionId: string,
    action: 'accept' | 'decline' | 'cancel' | 'disconnect',
    idempotencyKey: string,
  ) {
    try {
      const replay = await this.repository.replayTransition({
        connectionId,
        actorAccountId,
        action,
        idempotencyKey,
      });
      if (replay !== null) return toPublic(replay);
    } catch (error) {
      throw mapRepositoryError(error);
    }
    const row = await this.repository.getForActor(connectionId, actorAccountId);
    if (row === null) throw notFound();
    if (action === 'accept') {
      const decision = await this.gate.check({
        actorAccountId,
        subjectAccountId:
          row.requesterAccountId === actorAccountId
            ? row.recipientAccountId
            : row.requesterAccountId,
        capability: 'introduce',
        mode: row.mode,
        surface: 'matching',
      });
      if (!decision.allowed) throw unavailableInteraction();
    }
    try {
      return toPublic(
        await this.repository.transition({ connectionId, actorAccountId, action, idempotencyKey }),
      );
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  accept(actorAccountId: string, connectionId: string, idempotencyKey: string) {
    return this.action(actorAccountId, connectionId, 'accept', idempotencyKey);
  }
  decline(actorAccountId: string, connectionId: string, idempotencyKey: string) {
    return this.action(actorAccountId, connectionId, 'decline', idempotencyKey);
  }
  cancel(actorAccountId: string, connectionId: string, idempotencyKey: string) {
    return this.action(actorAccountId, connectionId, 'cancel', idempotencyKey);
  }
  disconnect(actorAccountId: string, connectionId: string, idempotencyKey: string) {
    return this.action(actorAccountId, connectionId, 'disconnect', idempotencyKey);
  }

  async get(actorAccountId: string, connectionId: string) {
    const row = await this.repository.getForActor(connectionId, actorAccountId);
    if (row === null) throw notFound();
    const subject =
      row.requesterAccountId === actorAccountId ? row.recipientAccountId : row.requesterAccountId;
    const decision = await this.gate.check({
      actorAccountId,
      subjectAccountId: subject,
      capability: 'discover',
      mode: row.mode,
      surface: 'matching',
      requireConnection: row.state === 'accepted',
    });
    if (!decision.allowed) throw notFound();
    return toPublic(row);
  }

  async list(actorAccountId: string, query: ConnectionListQuery = { limit: 50 }) {
    let page;
    try {
      page = await this.repository.listForActor(actorAccountId, query);
    } catch (error) {
      throw mapRepositoryError(error);
    }
    const visible: ConnectionRow[] = [];
    for (const row of page.rows) {
      const subject =
        row.requesterAccountId === actorAccountId ? row.recipientAccountId : row.requesterAccountId;
      const decision = await this.gate.check({
        actorAccountId,
        subjectAccountId: subject,
        capability: 'discover',
        mode: row.mode,
        surface: 'matching',
        requireConnection: row.state === 'accepted',
      });
      if (decision.allowed) visible.push(row);
    }
    return connectionListResponseSchema.parse({
      connections: visible.map(toPublic),
      next_cursor: page.nextCursor,
    });
  }

  private async enforceRateLimits(actorAccountId: string, recipientAccountId: string) {
    const account = await this.limiter.consume(`connection:account:${actorAccountId}`, 20, 3600);
    const pair = await this.limiter.consume(
      `connection:pair:${[actorAccountId, recipientAccountId].sort().join(':')}`,
      3,
      86400,
    );
    if (!account.allowed || !pair.allowed)
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many connection requests' },
        429,
      );
  }
}

function toPublic(row: ConnectionRow) {
  return connectionResponseSchema.parse({
    id: row.id,
    requester_account_id: row.requesterAccountId,
    recipient_account_id: row.recipientAccountId,
    mode: row.mode,
    state: row.state,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ...(row.acceptedAt === undefined ? {} : { accepted_at: row.acceptedAt.toISOString() }),
    ...(row.disconnectedAt === undefined
      ? {}
      : { disconnected_at: row.disconnectedAt.toISOString() }),
  });
}

function unavailableInteraction(): HttpException {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'Connection not found' });
}
function notFound(): HttpException {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'Connection not found' });
}
function mapRepositoryError(error: unknown): HttpException {
  const code = error instanceof Error ? error.message : '';
  if (code === 'SELF_CONNECTION_FORBIDDEN')
    return new ForbiddenException({
      code: 'SELF_CONNECTION_FORBIDDEN',
      message: 'Connection is not available',
    });
  if (
    code === 'CONNECTION_NOT_FOUND' ||
    code === 'CONNECTION_INVALIDATED' ||
    code === 'ACTIVE_BLOCK'
  )
    return notFound();
  if (code === 'INVALID_CURSOR')
    return new HttpException({ code: 'VALIDATION_ERROR', message: 'Cursor is invalid' }, 400);
  if (
    code === 'IDEMPOTENCY_CONFLICT' ||
    code === 'CONNECTION_TERMINAL' ||
    code === 'CONNECTION_ACTION_FORBIDDEN' ||
    code === 'PAIR_COOLDOWN'
  )
    return new ConflictException({
      code: code === 'IDEMPOTENCY_CONFLICT' ? code : 'CONNECTION_CONFLICT',
      message: 'Connection state conflict',
    });
  return new HttpException({ code: 'INTERNAL_ERROR', message: 'Connection unavailable' }, 503);
}
