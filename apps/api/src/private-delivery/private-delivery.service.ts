import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type {
  ConnectionMode,
  InteractionGatePort,
  LetterRepositoryPort,
  PrivateDeliveryCreateRequest,
  PrivateDeliveryCreateResult,
  PrivateDeliveryRepositoryPort,
  PrivateDeliverySurface,
} from '@wai/contracts';
import {
  PrivateDeliveryIdempotencyConflictError,
  PrivateDeliveryNotFoundError,
  PrivateDeliveryStateError,
} from '@wai/db';
import { RATE_LIMITER, type RateLimiter } from '../account/ports.js';
import { CONNECTION_GATE, PRIVATE_DELIVERY_CONNECTION } from '../connection/connection.tokens.js';
import { LETTER_REPOSITORY } from '../letters/letters.tokens.js';
import { PRIVATE_DELIVERY_REPOSITORY, PRIVATE_DELIVERY_WAKEUP } from './private-delivery.tokens.js';

@Injectable()
export class PrivateDeliveryService {
  constructor(
    @Inject(PRIVATE_DELIVERY_REPOSITORY) private readonly repository: PrivateDeliveryRepositoryPort,
    @Inject(LETTER_REPOSITORY) private readonly letters: LetterRepositoryPort,
    @Inject(PRIVATE_DELIVERY_CONNECTION)
    private readonly connections: PrivateDeliveryPolicyConnectionPort,
    @Inject(CONNECTION_GATE) private readonly gate: InteractionGatePort,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(PRIVATE_DELIVERY_WAKEUP)
    private readonly wakeup: { enqueue(deliveryId: string): Promise<void> },
  ) {}

  async create(
    senderAccountId: string,
    input: PrivateDeliveryCreateRequest,
    idempotencyKey: string,
  ): Promise<PrivateDeliveryCreateResult> {
    const payload = {
      recipient_id: input.recipient_id,
      letter_id: input.letter_id,
      revision: input.revision,
      purpose: input.purpose,
    };
    let replay: PrivateDeliveryCreateResult | null;
    try {
      replay = await this.repository.replayCreate({ senderAccountId, idempotencyKey, payload });
    } catch (error) {
      throw this.map(error);
    }
    if (replay) {
      // An idempotent replay is frozen data, but authorization is not. Recheck
      // the exact connection epoch before exposing even the frozen response or
      // waking a previously queued delivery.
      const context = await this.repository.getDeliveryContext(replay.deliveryId);
      if (!context)
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
      const current = await this.connections.isCurrentAccepted({
        connectionId: context.connectionId,
        acceptedEpoch: context.connectionEpoch,
        senderAccountId: context.senderAccountId,
        recipientAccountId: context.recipientAccountId,
      });
      if (!current || current.mode !== context.mode)
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
      const decision = await this.gate.check({
        actorAccountId: context.senderAccountId,
        subjectAccountId: context.recipientAccountId,
        capability: 'direct_message',
        mode: current.mode,
        surface: 'chat',
        requireConnection: true,
        connectionId: context.connectionId,
        acceptedEpoch: context.connectionEpoch,
      });
      if (!decision.allowed)
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
      if (await this.repository.shouldWake(replay.deliveryId))
        await this.dispatch(replay.deliveryId);
      return replay;
    }
    try {
      await this.limiter.consume(`pvl:sender:${senderAccountId}`, 20, 3600).then((r) => {
        if (!r.allowed)
          throw new HttpException(
            { code: 'RATE_LIMITED', message: 'Delivery rate limit exceeded' },
            HttpStatus.TOO_MANY_REQUESTS,
          );
      });
      await this.limiter
        .consume(`pvl:pair:${senderAccountId}:${input.recipient_id}`, 5, 3600)
        .then((r) => {
          if (!r.allowed)
            throw new HttpException(
              { code: 'RATE_LIMITED', message: 'Delivery rate limit exceeded' },
              HttpStatus.TOO_MANY_REQUESTS,
            );
        });
      const snapshot = await this.letters.readOwnedRevision(
        senderAccountId,
        input.letter_id,
        input.revision,
      );
      if (!snapshot || snapshot.kind !== 'private_letter')
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Private letter not found' });
      const connection = await this.connections.currentAccepted(
        senderAccountId,
        input.recipient_id,
      );
      if (!connection)
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Recipient is not an active connection',
        });
      const decision = await this.gate.check({
        actorAccountId: senderAccountId,
        subjectAccountId: input.recipient_id,
        capability: 'direct_message',
        mode: connection.mode,
        surface: 'chat',
        requireConnection: true,
      });
      if (!decision.allowed)
        throw new ForbiddenException({
          code: 'LETTER_POLICY_DENIED',
          message: 'Delivery is not available',
        });
      const result = await this.repository.createQueued({
        senderAccountId,
        recipientAccountId: input.recipient_id,
        connectionId: connection.connectionId,
        connectionEpoch: connection.acceptedEpoch,
        mode: connection.mode,
        purpose: input.purpose,
        snapshot,
        idempotencyKey,
      });
      await this.dispatch(result.deliveryId);
      return result;
    } catch (error) {
      throw this.map(error);
    }
  }

  async inbox(actor: string, query: { cursor?: string; limit: number }) {
    return this.list(actor, 'inbox', query);
  }
  async sent(actor: string, query: { cursor?: string; limit: number }) {
    return this.list(actor, 'sent', query);
  }
  async read(actor: string, deliveryId: string) {
    const row = await this.repository.getForRecipient(actor, deliveryId);
    if (!row || !(await this.finalGate(actor, row, 'inbox')))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
    return row;
  }
  async sentRead(actor: string, deliveryId: string) {
    const row = await this.repository.getForSender(actor, deliveryId);
    if (!row || !(await this.finalGate(actor, row, 'sent')))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
    return row;
  }
  async markRead(actor: string, deliveryId: string) {
    const row = await this.requireRecipientDelivery(actor, deliveryId);
    if (!(await this.finalGate(actor, row, 'inbox')))
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
    try {
      await this.repository.markRead(actor, deliveryId);
    } catch (error) {
      throw this.map(error);
    }
    return { ok: true };
  }
  async hide(actor: string, deliveryId: string) {
    await this.requireRecipientDelivery(actor, deliveryId);
    try {
      await this.repository.hide(actor, deliveryId);
    } catch (error) {
      throw this.map(error);
    }
    return { ok: true };
  }

  async withdraw(actor: string, deliveryId: string) {
    try {
      const row = await this.repository.getForSender(actor, deliveryId);
      if (!row || typeof row !== 'object')
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
      await this.repository.withdraw({ senderAccountId: actor, deliveryId });
      return { ok: true };
    } catch (error) {
      throw this.map(error);
    }
  }

  async captureEvidence(actor: string, deliveryId: string, category: string) {
    try {
      await this.repository.captureEvidence({ deliveryId, actorAccountId: actor, category });
      return { ok: true };
    } catch (error) {
      throw this.map(error);
    }
  }

  private async list(
    actor: string,
    surface: PrivateDeliverySurface,
    query: { cursor?: string; limit: number },
  ) {
    try {
      const result = await this.repository.list({
        actorAccountId: actor,
        surface,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: query.limit,
      });
      const allowed: unknown[] = [];
      for (const item of result.items) {
        if (await this.finalGate(actor, item, surface)) allowed.push(item);
      }
      return { items: allowed, nextCursor: result.nextCursor };
    } catch (error) {
      throw this.map(error);
    }
  }
  private async requireRecipientDelivery(actor: string, deliveryId: string) {
    const row = await this.repository.getForRecipient(actor, deliveryId);
    if (!row || typeof row !== 'object')
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
    return row;
  }
  private async finalGate(
    actor: string,
    row: unknown,
    surface: 'inbox' | 'sent',
  ): Promise<boolean> {
    if (typeof row !== 'object' || row === null) return false;
    const value = row as {
      sender_id?: string;
      recipient_id?: string;
      connection_id?: string;
      connection_epoch?: number;
      mode?: ConnectionMode;
    };
    const subject = surface === 'inbox' ? value.sender_id : value.recipient_id;
    if (!subject || !value.connection_id || value.connection_epoch === undefined || !value.mode)
      return false;
    const current = await this.connections.isCurrentAccepted({
      connectionId: value.connection_id,
      acceptedEpoch: value.connection_epoch,
      senderAccountId: surface === 'inbox' ? subject : actor,
      recipientAccountId: surface === 'inbox' ? actor : subject,
    });
    if (!current) return false;
    const decision = await this.gate.check({
      actorAccountId: actor,
      subjectAccountId: subject,
      capability: 'direct_message',
      mode: current.mode,
      surface: 'chat',
      requireConnection: true,
    });
    return decision.allowed;
  }
  private async dispatch(deliveryId: string) {
    try {
      await this.wakeup.enqueue(deliveryId);
    } catch {
      throw new ServiceUnavailableException({
        code: 'QUEUE_UNAVAILABLE',
        message: 'Delivery queue unavailable',
      });
    }
  }
  private map(error: unknown): Error {
    if (error instanceof HttpException) return error;
    if (error instanceof Error && error.message === 'private delivery idempotency conflict')
      return new ConflictException({
        code: 'LETTER_CONFLICT',
        message: 'Idempotency key conflict',
      });
    if (error instanceof PrivateDeliveryIdempotencyConflictError)
      return new ConflictException({
        code: 'LETTER_CONFLICT',
        message: 'Idempotency key conflict',
      });
    if (error instanceof PrivateDeliveryNotFoundError)
      return new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
    if (
      error instanceof PrivateDeliveryStateError &&
      ['ACTIVE_BLOCK', 'CONNECTION_NOT_CURRENT'].includes(error.message)
    )
      return new ForbiddenException({
        code: 'LETTER_POLICY_DENIED',
        message: 'Delivery is not available',
      });
    if (
      error instanceof PrivateDeliveryStateError &&
      error.message === 'LETTER_REVISION_BINDING_INVALID'
    )
      return new NotFoundException({ code: 'NOT_FOUND', message: 'Private letter not found' });
    if (error instanceof PrivateDeliveryStateError && error.message === 'INVALID_CURSOR')
      return new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Cursor is invalid' });
    return new ServiceUnavailableException({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Delivery service unavailable',
    });
  }
}

interface PrivateDeliveryPolicyConnectionPort {
  currentAccepted(
    sender: string,
    recipient: string,
  ): Promise<{ connectionId: string; acceptedEpoch: number; mode: ConnectionMode } | null>;
  isCurrentAccepted(input: {
    connectionId: string;
    acceptedEpoch: number;
    senderAccountId: string;
    recipientAccountId: string;
  }): Promise<{ mode: ConnectionMode } | null>;
}
