import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import {
  notificationEventSchema,
  notificationEventRegistry,
  notificationListSchema,
  notificationPreferencesSchema,
  notificationRecordSchema,
  notificationMessageKey,
  type NotificationIngestRequest,
  type NotificationList,
  type NotificationPreferences,
  type NotificationPreferencesRequest,
  type NotificationRecord,
  type NotificationRepositoryPort,
  type NotificationCategory,
  type NotificationResourceGatePort,
  type NotificationEventKey,
  type NotificationResourceKind,
} from '@wai/contracts';
import { PgNotificationResourceGate } from './resource-gate.js';

const categoryFor = (key: keyof typeof notificationEventRegistry) =>
  notificationEventRegistry[key].category;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest('base64url');
const defaults = (): NotificationPreferences => ({
  version: 0,
  items: (['in_app', 'email', 'push'] as const).flatMap((channel) =>
    (
      [
        'letters',
        'messages',
        'connections',
        'introductions',
        'events',
        'circles',
        'critical-safety',
      ] as const
    ).map((category) => ({
      channel,
      category,
      enabled: channel === 'in_app' || category === 'critical-safety',
      quiet_start_minute: 22 * 60,
      quiet_end_minute: 7 * 60,
      digest_cadence: 'immediate' as const,
      critical_safety_exception: category === 'critical-safety',
    })),
  ),
});
// Runtime visibility is delegated to the single closed NotificationResourceGatePort.
type Row = {
  id: string;
  recipient_account_id: string;
  resource_kind: string;
  resource_id: string;
  event_key: string;
  event_version: number;
  category: string;
  parameters: Record<string, string | number>;
  read_at: Date | null;
  created_at: Date;
};

export class NotificationIdempotencyConflictError extends Error {
  readonly code = 'NOTIFICATION_IDEMPOTENCY_CONFLICT';
}
export class NotificationVersionConflictError extends Error {
  readonly code = 'NOTIFICATION_VERSION_CONFLICT';
}

export class PgNotificationRepository implements NotificationRepositoryPort {
  private readonly gate: NotificationResourceGatePort;
  constructor(
    private readonly pool: Pool,
    private readonly cursorKey: Buffer,
    gate?: NotificationResourceGatePort,
  ) {
    this.gate = gate ?? new PgNotificationResourceGate(pool);
  }
  private async isVisible(
    row: Pick<Row, 'recipient_account_id' | 'resource_kind' | 'resource_id' | 'event_key'>,
  ) {
    const result = await this.gate.check({
      actorAccountId: row.recipient_account_id,
      recipientAccountId: row.recipient_account_id,
      resourceKind: row.resource_kind as NotificationResourceKind,
      resourceId: row.resource_id,
      eventKey: row.event_key as NotificationEventKey,
    });
    return result.allowed;
  }
  async ingest(input: {
    request: NotificationIngestRequest;
    requestDigest: string;
    now: Date;
  }): Promise<{ record: NotificationRecord; replayed: boolean }> {
    const request = notificationIngest(input.request);
    const c = await this.pool.connect();
    const keyDigest = digest(request.idempotency_key);
    try {
      await c.query('BEGIN');
      const account = await c.query<{ state: string }>(
        'SELECT state FROM iam.accounts WHERE id=$1 FOR UPDATE',
        [request.recipient_account_id],
      );
      if (account.rows[0]?.state !== 'enabled') throw new Error('NOTIFICATION_ACCOUNT_UNAVAILABLE');
      const prior = await c.query<{
        request_digest: string;
        response_json: { notification_id: string };
      }>(
        'SELECT request_digest,response_json FROM notifications.notification_idempotency WHERE account_id=$1 AND idempotency_digest=$2',
        [request.recipient_account_id, keyDigest],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== input.requestDigest)
          throw new NotificationIdempotencyConflictError();
        const replay = await c.query<Row>(
          'SELECT id,recipient_account_id,resource_kind,resource_id,event_key,event_version,category,parameters,read_at,created_at FROM notifications.notifications WHERE id=$1 AND recipient_account_id=$2',
          [prior.rows[0].response_json.notification_id, request.recipient_account_id],
        );
        if (!replay.rows[0]) throw new Error('NOTIFICATION_REPLAY_MISSING');
        await c.query('COMMIT');
        return { record: toRecord(replay.rows[0]), replayed: true };
      }
      const id = randomUUID();
      const event = request.event;
      const category = categoryFor(event.event_key);
      const row = (
        await c.query<Row>(
          `INSERT INTO notifications.notifications(id,recipient_account_id,resource_kind,resource_id,event_key,event_version,category,parameters,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,recipient_account_id,resource_kind,resource_id,event_key,event_version,category,parameters,read_at,created_at`,
          [
            id,
            request.recipient_account_id,
            request.resource_kind,
            request.resource_id,
            event.event_key,
            event.event_version,
            category,
            event.parameters,
            input.now,
          ],
        )
      ).rows[0]!;
      await c.query(
        `INSERT INTO notifications.preferences(account_id,channel,category,enabled,quiet_start_minute,quiet_end_minute,digest_cadence,critical_safety_exception,version,updated_at) SELECT $1,channels.channel,categories.category,(channels.channel='in_app' OR categories.category='critical-safety'),1320,420,'immediate',(categories.category='critical-safety'),0,$2 FROM unnest(ARRAY['in_app','email','push']::text[]) channels(channel) CROSS JOIN unnest(ARRAY['letters','messages','connections','introductions','events','circles','critical-safety']::text[]) categories(category) WHERE NOT EXISTS (SELECT 1 FROM notifications.preferences p WHERE p.account_id=$1) ON CONFLICT(account_id,channel,category) DO NOTHING`,
        [request.recipient_account_id, input.now],
      );
      const channels = await c.query<{ channel: 'email' | 'push' }>(
        `SELECT p.channel FROM notifications.preferences p WHERE p.account_id=$1 AND (p.enabled=true OR ($3::boolean AND p.category='critical-safety')) AND p.channel IN ('email','push') AND p.category=$2`,
        [
          request.recipient_account_id,
          category,
          notificationEventRegistry[event.event_key].delivery_policy.bypass_channel_preference,
        ],
      );
      for (const channel of channels.rows)
        await c.query(
          `INSERT INTO notifications.provider_intents(id,notification_id,recipient_account_id,channel,state,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,'pending',$5,$5,$5) ON CONFLICT(notification_id,channel) DO NOTHING`,
          [randomUUID(), id, request.recipient_account_id, channel.channel, input.now],
        );
      const record = toRecord(row);
      await c.query(
        'INSERT INTO notifications.notification_idempotency(account_id,idempotency_digest,request_digest,response_json,created_at) VALUES($1,$2,$3,$4,$5)',
        [
          request.recipient_account_id,
          keyDigest,
          input.requestDigest,
          { notification_id: id },
          input.now,
        ],
      );
      await c.query('COMMIT');
      return { record, replayed: false };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
  async list(
    accountId: string,
    input: { limit: number; cursor?: string; category?: NotificationCategory },
  ): Promise<NotificationList> {
    const limit = Math.max(1, Math.min(100, input.limit));
    const cursor = input.cursor
      ? this.decodeCursor(input.cursor, accountId, input.category)
      : undefined;
    const scanLimit = Math.max(limit * 10, 100);
    const args: unknown[] = [accountId, scanLimit];
    let where = `n.recipient_account_id=$1 AND n.suppressed_at IS NULL AND EXISTS (SELECT 1 FROM iam.accounts a WHERE a.id=$1 AND a.state='enabled')`;
    if (input.category) {
      args.push(input.category);
      where += ` AND n.category=$3`;
    }
    if (cursor) {
      args.push(cursor.createdAt, cursor.id);
      const createdAtPlaceholder = input.category ? '$4' : '$3';
      const idPlaceholder = input.category ? '$5' : '$4';
      where += ` AND (n.created_at,n.id)<(${createdAtPlaceholder},${idPlaceholder})`;
    }
    const rows = (
      await this.pool.query<Row>(
        `SELECT n.id,n.recipient_account_id,n.resource_kind,n.resource_id,n.event_key,n.event_version,n.category,n.parameters,n.read_at,n.created_at FROM notifications.notifications n WHERE ${where} ORDER BY n.created_at DESC,n.id DESC LIMIT $2`,
        args,
      )
    ).rows;
    const pageRows: Row[] = [];
    let scannedCount = 0;
    for (const row of rows) {
      if (pageRows.length >= limit) break;
      scannedCount += 1;
      if (await this.isVisible(row)) pageRows.push(row);
    }
    const page = pageRows.map(toRecord);
    const boundary = rows[scannedCount - 1];
    return notificationListSchema.parse({
      items: page,
      next_cursor:
        boundary && (scannedCount < rows.length || rows.length >= scanLimit)
          ? this.encodeCursor(
              accountId,
              {
                createdAt: boundary.created_at.toISOString(),
                id: boundary.id,
              },
              input.category,
            )
          : null,
    });
  }
  async unreadCount(accountId: string) {
    const result = await this.pool.query<Row>(
      `SELECT n.id,n.recipient_account_id,n.resource_kind,n.resource_id,n.event_key,n.event_version,n.category,n.parameters,n.read_at,n.created_at FROM notifications.notifications n WHERE n.recipient_account_id=$1 AND n.read_at IS NULL AND n.suppressed_at IS NULL AND EXISTS (SELECT 1 FROM iam.accounts a WHERE a.id=$1 AND a.state='enabled')`,
      [accountId],
    );
    let count = 0;
    for (const row of result.rows) if (await this.isVisible(row)) count += 1;
    return { unread_count: count };
  }
  async intentIdsForNotification(notificationId: string) {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM notifications.provider_intents WHERE notification_id=$1 AND state IN ('pending','retrying','retained')",
      [notificationId],
    );
    return result.rows.map((row) => row.id);
  }
  async markRead(accountId: string, id: string, idempotencyKey: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const account = await c.query(
        "SELECT 1 FROM iam.accounts WHERE id=$1 AND state='enabled' FOR UPDATE",
        [accountId],
      );
      if (account.rowCount !== 1) throw new Error('NOTIFICATION_ACCOUNT_UNAVAILABLE');
      const key = digest(`one:${idempotencyKey}`);
      const request = digest(id);
      const prior = await c.query<{ request_digest: string; response_json: { read: boolean } }>(
        'SELECT request_digest,response_json FROM notifications.notification_idempotency WHERE account_id=$1 AND idempotency_digest=$2',
        [accountId, key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== request)
          throw new NotificationIdempotencyConflictError();
        const current = await c.query<Row>(
          `SELECT n.id,n.recipient_account_id,n.resource_kind,n.resource_id,n.event_key,n.event_version,n.category,n.parameters,n.read_at,n.created_at FROM notifications.notifications n WHERE n.id=$1 AND n.recipient_account_id=$2 AND n.suppressed_at IS NULL`,
          [id, accountId],
        );
        const visible = current.rows[0] ? await this.isVisible(current.rows[0]) : false;
        await c.query('COMMIT');
        return visible && prior.rows[0].response_json.read;
      }
      const candidate = await c.query<Row>(
        `SELECT n.id,n.recipient_account_id,n.resource_kind,n.resource_id,n.event_key,n.event_version,n.category,n.parameters,n.read_at,n.created_at FROM notifications.notifications n WHERE n.id=$1 AND n.recipient_account_id=$2 AND n.suppressed_at IS NULL FOR UPDATE`,
        [id, accountId],
      );
      const read = candidate.rows[0] ? await this.isVisible(candidate.rows[0]) : false;
      if (read)
        await c.query(
          `UPDATE notifications.notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND recipient_account_id=$2`,
          [id, accountId],
        );
      await c.query(
        'INSERT INTO notifications.notification_idempotency(account_id,idempotency_digest,request_digest,response_json,created_at) VALUES($1,$2,$3,$4,now())',
        [accountId, key, request, { read }],
      );
      await c.query('COMMIT');
      return read;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async markAllRead(accountId: string, idempotencyKey: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const account = await c.query(
        "SELECT 1 FROM iam.accounts WHERE id=$1 AND state='enabled' FOR UPDATE",
        [accountId],
      );
      if (account.rowCount !== 1) throw new Error('NOTIFICATION_ACCOUNT_UNAVAILABLE');
      const key = digest(`all:${idempotencyKey}`);
      const request = digest(accountId);
      const prior = await c.query<{
        request_digest: string;
        response_json: { count: number; ids?: string[] };
      }>(
        'SELECT request_digest,response_json FROM notifications.notification_idempotency WHERE account_id=$1 AND idempotency_digest=$2',
        [accountId, key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== request)
          throw new NotificationIdempotencyConflictError();
        const ids = prior.rows[0].response_json.ids ?? [];
        const current = ids.length
          ? await c.query<Row>(
              `SELECT n.id,n.recipient_account_id,n.resource_kind,n.resource_id,n.event_key,n.event_version,n.category,n.parameters,n.read_at,n.created_at FROM notifications.notifications n WHERE n.id=ANY($1::uuid[]) AND n.recipient_account_id=$2 AND n.suppressed_at IS NULL`,
              [ids, accountId],
            )
          : { rows: [] as Row[] };
        let safeCount = 0;
        for (const row of current.rows) if (await this.isVisible(row)) safeCount += 1;
        await c.query('COMMIT');
        return safeCount;
      }
      const candidates = await c.query<Row>(
        `SELECT n.id,n.recipient_account_id,n.resource_kind,n.resource_id,n.event_key,n.event_version,n.category,n.parameters,n.read_at,n.created_at FROM notifications.notifications n WHERE n.recipient_account_id=$1 AND n.read_at IS NULL AND n.suppressed_at IS NULL AND EXISTS (SELECT 1 FROM iam.accounts a WHERE a.id=$1 AND a.state='enabled') FOR UPDATE`,
        [accountId],
      );
      const visibleIds: string[] = [];
      for (const row of candidates.rows) if (await this.isVisible(row)) visibleIds.push(row.id);
      if (visibleIds.length)
        await c.query(
          `UPDATE notifications.notifications SET read_at=COALESCE(read_at,now()) WHERE id=ANY($1::uuid[]) AND recipient_account_id=$2`,
          [visibleIds, accountId],
        );
      const count = visibleIds.length;
      await c.query(
        'INSERT INTO notifications.notification_idempotency(account_id,idempotency_digest,request_digest,response_json,created_at) VALUES($1,$2,$3,$4,now())',
        [accountId, key, request, { count, ids: visibleIds }],
      );
      await c.query('COMMIT');
      return count;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async readPreferences(accountId: string) {
    const rows = (
      await this.pool.query(
        'SELECT channel,category,enabled,quiet_start_minute,quiet_end_minute,digest_cadence,critical_safety_exception,version FROM notifications.preferences WHERE account_id=$1 ORDER BY channel,category',
        [accountId],
      )
    ).rows;
    if (rows.length === 0) return defaults();
    const versions = new Set(rows.map((r: Record<string, unknown>) => Number(r['version'])));
    if (rows.length !== 21 || versions.size !== 1)
      throw new Error('NOTIFICATION_PREFERENCES_UNAVAILABLE');
    return notificationPreferencesSchema.parse({
      version: Number(rows[0]['version']),
      items: rows.map((r: Record<string, unknown>) => ({
        channel: r['channel'],
        category: r['category'],
        enabled: r['enabled'],
        quiet_start_minute: r['quiet_start_minute'],
        quiet_end_minute: r['quiet_end_minute'],
        digest_cadence: r['digest_cadence'],
        critical_safety_exception: r['critical_safety_exception'],
      })),
    });
  }
  async replacePreferences(input: {
    accountId: string;
    expectedVersion: number;
    value: NotificationPreferencesRequest;
    requestDigest: string;
    idempotencyKey: string;
    now: Date;
  }) {
    const c = await this.pool.connect();
    const key = digest(input.idempotencyKey);
    const effectiveItems = input.value.items.map((item) =>
      item.category === 'critical-safety'
        ? {
            ...item,
            enabled: true,
            quiet_start_minute: 0,
            quiet_end_minute: 0,
            digest_cadence: 'immediate' as const,
          }
        : item,
    );
    try {
      await c.query('BEGIN');
      const prior = await c.query<{
        request_digest: string;
        response_json: NotificationPreferences;
      }>(
        'SELECT request_digest,response_json FROM notifications.preferences_idempotency WHERE account_id=$1 AND idempotency_digest=$2',
        [input.accountId, key],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== input.requestDigest)
          throw new NotificationIdempotencyConflictError();
        await c.query('COMMIT');
        return prior.rows[0].response_json;
      }
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
        input.accountId,
      ]);
      const current = await c.query<{ version: number }>(
        'SELECT version FROM notifications.preferences WHERE account_id=$1 LIMIT 1 FOR UPDATE',
        [input.accountId],
      );
      const version = current.rows[0] ? Number(current.rows[0].version) : 0;
      if (version !== input.expectedVersion) throw new NotificationVersionConflictError();
      const next = version + 1;
      for (const item of effectiveItems)
        await c.query(
          `INSERT INTO notifications.preferences(account_id,channel,category,enabled,quiet_start_minute,quiet_end_minute,digest_cadence,critical_safety_exception,version,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id,channel,category) DO UPDATE SET enabled=EXCLUDED.enabled,quiet_start_minute=EXCLUDED.quiet_start_minute,quiet_end_minute=EXCLUDED.quiet_end_minute,digest_cadence=EXCLUDED.digest_cadence,critical_safety_exception=EXCLUDED.critical_safety_exception,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at`,
          [
            input.accountId,
            item.channel,
            item.category,
            item.enabled,
            item.quiet_start_minute,
            item.quiet_end_minute,
            item.digest_cadence,
            item.category === 'critical-safety',
            next,
            input.now,
          ],
        );
      for (const item of effectiveItems)
        if (
          (item.enabled ||
            (item.category === 'critical-safety' &&
              notificationEventRegistry['safety.action_required'].delivery_policy
                .bypass_channel_preference)) &&
          item.channel !== 'in_app'
        ) {
          const notifications = await c.query<{ id: string; created_at: Date }>(
            `SELECT n.id,n.created_at FROM notifications.notifications n WHERE n.recipient_account_id=$1 AND n.category=$2 AND n.suppressed_at IS NULL AND NOT EXISTS (SELECT 1 FROM notifications.provider_intents i WHERE i.notification_id=n.id AND i.channel=$3)`,
            [input.accountId, item.category, item.channel],
          );
          for (const notification of notifications.rows)
            await c.query(
              `INSERT INTO notifications.provider_intents(id,notification_id,recipient_account_id,channel,state,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,'pending',LEAST($5,$6),$6,$6) ON CONFLICT(notification_id,channel) DO NOTHING`,
              [
                randomUUID(),
                notification.id,
                input.accountId,
                item.channel,
                notification.created_at,
                input.now,
              ],
            );
        }
      const result = notificationPreferencesSchema.parse({
        version: next,
        items: effectiveItems.map((item) => ({
          ...item,
          critical_safety_exception: item.category === 'critical-safety',
        })),
      });
      await c.query(
        'INSERT INTO notifications.preferences_idempotency(account_id,idempotency_digest,request_digest,response_json,created_at) VALUES($1,$2,$3,$4,$5)',
        [input.accountId, key, input.requestDigest, result, input.now],
      );
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      if (e instanceof Error && e.message.includes('notification preference version must increase'))
        throw new NotificationVersionConflictError();
      throw e;
    } finally {
      c.release();
    }
  }
  encodeCursor(
    accountId: string,
    cursor: { createdAt: string; id: string },
    category?: NotificationCategory,
  ) {
    const body = Buffer.from(
      JSON.stringify({ a: accountId, c: category ?? null, ...cursor }),
    ).toString('base64url');
    return `${body}.${hmac(this.cursorKey, body)}`;
  }
  decodeCursor(
    value: string,
    accountId: string,
    category?: NotificationCategory,
  ): { createdAt: string; id: string } {
    const [body, sig] = value.split('.');
    if (!body || !sig) throw new Error('NOTIFICATION_CURSOR_INVALID');
    const expected = hmac(this.cursorKey, body);
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
      throw new Error('NOTIFICATION_CURSOR_INVALID');
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      a?: string;
      c?: string | null;
      createdAt?: string;
      id?: string;
    };
    if (
      parsed.a !== accountId ||
      (parsed.c ?? null) !== (category ?? null) ||
      !parsed.createdAt ||
      !parsed.id
    )
      throw new Error('NOTIFICATION_CURSOR_INVALID');
    return { createdAt: parsed.createdAt, id: parsed.id };
  }
}
export type NotificationLeaseRow = {
  intentId: string;
  leaseToken: string;
  fence: number;
  recipientAccountId: string;
  channel: 'email' | 'push';
  resourceKind: string;
  resourceId: string;
  eventKey: string;
  category: string;
  timeZone: string;
  uiLocale: string;
  quietStartMinute: number;
  quietEndMinute: number;
  digestCadence: 'immediate' | 'daily' | 'weekly';
  nextAttemptAt: string | null;
  digestDueAt: string | null;
  digestCadenceBucket: 'daily' | 'weekly' | null;
  criticalSafetyException: boolean;
};
/** Durable fenced lease operations used by the worker. All terminal writes
 * require the exact owner token, fence and leased state, so an expired worker
 * cannot complete or retry after takeover. */
export class PgNotificationDeliveryRepository {
  constructor(public readonly pool: Pool) {}
  async reconcileDueIntentIds(limit = 100): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT i.id FROM notifications.provider_intents i JOIN iam.accounts a ON a.id=i.recipient_account_id AND a.state='enabled' WHERE i.state IN ('pending','retrying') AND COALESCE(i.next_attempt_at,i.available_at) <= now() ORDER BY i.created_at,i.id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }
  async releaseExpiredLeases(_workerId: string): Promise<void> {
    await this.pool.query(
      `UPDATE notifications.provider_intents SET state='retrying',lease_owner=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=now(),updated_at=now() WHERE state='leased' AND lease_until < now()`,
    );
  }
  async claimDue(
    limit: number,
    workerId: string,
    intentId?: string,
  ): Promise<NotificationLeaseRow[]> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const intentFilter = intentId ? ' AND i.id=$2' : '';
      const rows = (
        await c.query(
          `SELECT i.id,n.recipient_account_id,i.channel,n.resource_kind,n.resource_id,n.event_key,n.category,i.attempt_count,i.next_attempt_at,i.digest_due_at,i.digest_cadence_bucket,COALESCE(g.time_zone,'UTC') time_zone,COALESCE(g.ui_locale,'en') ui_locale,COALESCE(p.quiet_start_minute,1320) quiet_start_minute,COALESCE(p.quiet_end_minute,420) quiet_end_minute,COALESCE(p.digest_cadence,'immediate') digest_cadence,COALESCE(p.critical_safety_exception,false) critical_safety_exception FROM notifications.provider_intents i JOIN notifications.notifications n ON n.id=i.notification_id LEFT JOIN globalization.account_preferences g ON g.account_id=i.recipient_account_id JOIN notifications.preferences p ON p.account_id=i.recipient_account_id AND p.channel=i.channel AND p.category=n.category AND (p.enabled=true OR (n.event_key='safety.action_required' AND n.category='critical-safety')) JOIN iam.accounts a ON a.id=i.recipient_account_id AND a.state='enabled' WHERE i.state IN ('pending','retrying','retained') AND COALESCE(i.next_attempt_at,i.available_at) <= now()${intentFilter} ORDER BY i.created_at,i.id LIMIT $1 FOR UPDATE OF i SKIP LOCKED`,
          intentId ? [limit, intentId] : [limit],
        )
      ).rows;
      const result: NotificationLeaseRow[] = [];
      for (const row of rows) {
        const token = randomUUID();
        const updated = await c.query<{ lease_fence: number }>(
          `UPDATE notifications.provider_intents SET state='leased',lease_owner=$2,lease_token=$3,lease_until=now()+interval '60 seconds',lease_fence=lease_fence+1,updated_at=now() WHERE id=$1 AND state IN ('pending','retrying','retained') RETURNING lease_fence`,
          [row.id, workerId, token],
        );
        if (updated.rows[0])
          result.push({
            intentId: row.id,
            leaseToken: token,
            fence: updated.rows[0].lease_fence,
            recipientAccountId: row.recipient_account_id,
            channel: row.channel,
            resourceKind: row.resource_kind,
            resourceId: row.resource_id,
            eventKey: row.event_key,
            category: row.category,
            timeZone: row.time_zone ?? 'UTC',
            uiLocale: row.ui_locale ?? 'en',
            quietStartMinute: Number(row.quiet_start_minute),
            quietEndMinute: Number(row.quiet_end_minute),
            digestCadence: row.digest_cadence,
            nextAttemptAt: row.next_attempt_at?.toISOString?.() ?? null,
            digestDueAt: row.digest_due_at?.toISOString?.() ?? null,
            digestCadenceBucket: row.digest_cadence_bucket ?? null,
            criticalSafetyException: Boolean(row.critical_safety_exception),
          });
      }
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async complete(input: {
    intentId: string;
    leaseToken: string;
    fence: number;
    providerId?: string;
  }): Promise<'sent' | 'stale'> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const row = (
        await c.query<{ attempt_count: number }>(
          "SELECT attempt_count FROM notifications.provider_intents WHERE id=$1 AND state='leased' AND lease_token=$2 AND lease_fence=$3 FOR UPDATE",
          [input.intentId, input.leaseToken, input.fence],
        )
      ).rows[0];
      if (!row) {
        await c.query('ROLLBACK');
        return 'stale';
      }
      await c.query(
        `UPDATE notifications.provider_intents SET state='sent',lease_owner=NULL,lease_token=NULL,lease_until=NULL,provider_id=$4,attempt_count=attempt_count+1,updated_at=now() WHERE id=$1 AND state='leased' AND lease_token=$2 AND lease_fence=$3`,
        [input.intentId, input.leaseToken, input.fence, input.providerId ?? null],
      );
      await c.query(
        `INSERT INTO notifications.provider_attempts(intent_id,attempt_no,outcome,provider_id,payload_digest,created_at) VALUES($1,$2,'accepted',$3,$4,now())`,
        [
          input.intentId,
          row.attempt_count + 1,
          input.providerId ?? null,
          digest(`notification-intent:${input.intentId}`),
        ],
      );
      await c.query('COMMIT');
      return 'sent';
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async retry(input: {
    intentId: string;
    leaseToken: string;
    fence: number;
    reason: string;
    retryAfterMs: number;
    digestCadence?: 'daily' | 'weekly';
    maxAttempts?: number;
  }): Promise<'retrying' | 'failed' | 'stale'> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const row = (
        await c.query<{ attempt_count: number }>(
          "SELECT attempt_count FROM notifications.provider_intents WHERE id=$1 AND state='leased' AND lease_token=$2 AND lease_fence=$3 FOR UPDATE",
          [input.intentId, input.leaseToken, input.fence],
        )
      ).rows[0];
      if (!row) {
        await c.query('ROLLBACK');
        return 'stale';
      }
      const consumesAttempt = ![
        'QUIET_HOURS',
        'GATE_UNAVAILABLE',
        'DIGEST_CADENCE',
        'PROVIDER_UNAVAILABLE',
      ].includes(input.reason);
      const terminal = consumesAttempt && row.attempt_count + 1 >= (input.maxAttempts ?? 5);
      await c.query(
        `UPDATE notifications.provider_intents SET state=$4,lease_owner=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=CASE WHEN $4='retrying' THEN now()+($5::text || ' milliseconds')::interval ELSE NULL END,digest_due_at=CASE WHEN $6='DIGEST_CADENCE' THEN now()+($5::text || ' milliseconds')::interval ELSE digest_due_at END,digest_cadence_bucket=CASE WHEN $6='DIGEST_CADENCE' THEN $8 ELSE digest_cadence_bucket END,last_error_code=$6,attempt_count=attempt_count+CASE WHEN $7 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 AND state='leased' AND lease_token=$2 AND lease_fence=$3`,
        [
          input.intentId,
          input.leaseToken,
          input.fence,
          terminal ? 'failed' : 'retrying',
          input.retryAfterMs,
          input.reason,
          consumesAttempt,
          input.digestCadence ?? null,
        ],
      );
      if (consumesAttempt)
        await c.query(
          `INSERT INTO notifications.provider_attempts(intent_id,attempt_no,outcome,error_code,payload_digest,created_at) SELECT id,attempt_count,$2,$3,repeat('0',64),now() FROM notifications.provider_intents WHERE id=$1`,
          [input.intentId, terminal ? 'terminal_failure' : 'retryable_failure', input.reason],
        );
      await c.query('COMMIT');
      return terminal ? 'failed' : 'retrying';
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async retain(input: {
    intentId: string;
    leaseToken: string;
    fence: number;
  }): Promise<'retained' | 'stale'> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await c.query(
        `UPDATE notifications.provider_intents SET state='retained',lease_owner=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=now()+interval '15 minutes',last_error_code='PROVIDER_UNAVAILABLE',updated_at=now() WHERE id=$1 AND state='leased' AND lease_token=$2 AND lease_fence=$3`,
        [input.intentId, input.leaseToken, input.fence],
      );
      await c.query('COMMIT');
      return result.rowCount === 1 ? 'retained' : 'stale';
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async suppress(input: {
    intentId: string;
    leaseToken: string;
    fence: number;
  }): Promise<'suppressed' | 'stale'> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const row = (
        await c.query<{ attempt_count: number }>(
          "SELECT attempt_count FROM notifications.provider_intents WHERE id=$1 AND state='leased' AND lease_token=$2 AND lease_fence=$3 FOR UPDATE",
          [input.intentId, input.leaseToken, input.fence],
        )
      ).rows[0];
      if (!row) {
        await c.query('ROLLBACK');
        return 'stale';
      }
      await c.query(
        `UPDATE notifications.provider_intents SET state='suppressed',lease_owner=NULL,lease_token=NULL,lease_until=NULL,last_error_code='RESOURCE_UNAVAILABLE',updated_at=now() WHERE id=$1 AND state='leased' AND lease_token=$2 AND lease_fence=$3`,
        [input.intentId, input.leaseToken, input.fence],
      );
      await c.query(
        `INSERT INTO notifications.provider_attempts(intent_id,attempt_no,outcome,error_code,payload_digest,created_at) VALUES($1,$2,'suppressed','RESOURCE_UNAVAILABLE',$3,now())`,
        [
          input.intentId,
          Math.max(1, row.attempt_count + 1),
          digest(`notification-intent:${input.intentId}`),
        ],
      );
      await c.query('COMMIT');
      return 'suppressed';
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
}
function notificationIngest(input: NotificationIngestRequest) {
  const parsed = notificationEventSchema.parse(input.event);
  return { ...input, event: parsed };
}
function toRecord(row: Row): NotificationRecord {
  return notificationRecordSchema.parse({
    id: row.id,
    recipient_account_id: row.recipient_account_id,
    resource_kind: row.resource_kind,
    resource_id: row.resource_id,
    event_key: row.event_key,
    event_version: row.event_version,
    category: row.category,
    message_key: notificationMessageKey[row.event_key as keyof typeof notificationMessageKey],
    parameters: row.parameters,
    read_at: row.read_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  });
}
