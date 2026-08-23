import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  formatGlobalizationMessage,
  globalizationPreferencesSchema,
  notificationIngestRequestSchema,
  notificationPreferencesPutSchema,
  notificationCategorySchema,
  JOB_NAMES,
  type NotificationRepositoryPort,
  type NotificationResourceGatePort,
} from '@wai/contracts';
import {
  hmacDigest,
  parsePepper,
  NotificationIdempotencyConflictError,
  NotificationVersionConflictError,
} from '@wai/db';
import type { AppConfig } from '@wai/config';
import { APP_CONFIG, NOTIFICATION_QUEUE_ADAPTER } from '../tokens.js';
import type { QueueProducerAdapter } from '../infra/adapters.js';
import { GLOBALIZATION_REPOSITORY } from '../globalization/globalization.tokens.js';
import type { GlobalizationRepositoryPort } from '@wai/contracts';
import { NOTIFICATION_GATE, NOTIFICATION_REPOSITORY } from './notifications.tokens.js';

@Injectable()
export class NotificationsService {
  private readonly key: Buffer;
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepositoryPort,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(NOTIFICATION_QUEUE_ADAPTER) private readonly queue: QueueProducerAdapter,
    @Inject(GLOBALIZATION_REPOSITORY) private readonly globalization: GlobalizationRepositoryPort,
    @Inject(NOTIFICATION_GATE) private readonly gate: NotificationResourceGatePort,
  ) {
    this.key = parsePepper(config.iam.secretPepper);
  }
  private async accountPreferences(accountId: string) {
    const globalization = await this.globalization.read(accountId);
    if (!globalization)
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Notification account unavailable',
      });
    try {
      return globalizationPreferencesSchema.parse(globalization);
    } catch {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Notification account unavailable',
      });
    }
  }
  async ingest(request: unknown) {
    const parsed = notificationIngestRequestSchema.parse(request);
    const requestDigest = hmacDigest(this.key, 'notification:ingest', JSON.stringify(parsed));
    const result = await this.repo.ingest({ request: parsed, requestDigest, now: new Date() });
    if (this.repo.intentIdsForNotification)
      for (const intentId of await this.repo.intentIdsForNotification(result.record.id))
        await this.queue.enqueue(
          JOB_NAMES.notificationWakeup,
          { intent_id: intentId },
          {
            jobId: `notification:${intentId}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
          },
        );
    return result.record;
  }
  async list(accountId: string, limit: number, cursor?: string, category?: string) {
    const prefs = await this.accountPreferences(accountId);
    const parsedCategory = category ? notificationCategorySchema.parse(category) : undefined;
    const items: unknown[] = [];
    let next = cursor;
    const maxScanPages = 100;
    let scannedPages = 0;
    while (items.length < limit && scannedPages < maxScanPages) {
      scannedPages += 1;
      let page;
      try {
        // Scan one authoritative row at a time. The repository cursor is the
        // last scanned key, so a gate rejection cannot create a sparse page or
        // skip rows after the first visible item.
        page = await this.repo.list(accountId, {
          limit: 1,
          ...(next ? { cursor: next } : {}),
          ...(parsedCategory ? { category: parsedCategory } : {}),
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'NOTIFICATION_CURSOR_INVALID')
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'Notification cursor is invalid',
          });
        throw error;
      }
      for (const item of page.items) {
        const gate = await this.gate.check({
          actorAccountId: accountId,
          recipientAccountId: accountId,
          resourceKind: item.resource_kind,
          resourceId: item.resource_id,
          eventKey: item.event_key,
        });
        if (gate.allowed)
          items.push({
            ...item,
            message: formatGlobalizationMessage(
              prefs.ui_locale,
              item.message_key as never,
              item.parameters,
            ),
          });
      }
      next = page.next_cursor ?? undefined;
      if (!next) break;
    }
    return { items, next_cursor: next ?? null };
  }
  async unread(accountId: string) {
    await this.accountPreferences(accountId);
    return this.repo.unreadCount(accountId);
  }
  async markRead(accountId: string, id: string, key: string) {
    await this.accountPreferences(accountId);
    return this.repo.markRead(accountId, id, key);
  }
  async markAllRead(accountId: string, key: string) {
    await this.accountPreferences(accountId);
    return this.repo.markAllRead(accountId, key);
  }
  async preferences(accountId: string) {
    await this.accountPreferences(accountId);
    return this.repo.readPreferences(accountId);
  }
  async replacePreferences(accountId: string, body: unknown, key: string) {
    const parsed = notificationPreferencesPutSchema.parse(body);
    const requestDigest = hmacDigest(this.key, 'notification:preferences', JSON.stringify(parsed));
    try {
      return await this.repo.replacePreferences({
        accountId,
        expectedVersion: parsed.expected_version,
        value: { items: parsed.items },
        requestDigest,
        idempotencyKey: key,
        now: new Date(),
      });
    } catch (e) {
      if (e instanceof NotificationIdempotencyConflictError)
        throw new ConflictException({ code: 'BAD_REQUEST', message: 'Idempotency key conflict' });
      if (e instanceof NotificationVersionConflictError)
        throw new ConflictException({
          code: 'BAD_REQUEST',
          message: 'Preference version is stale',
        });
      throw e;
    }
  }
}
