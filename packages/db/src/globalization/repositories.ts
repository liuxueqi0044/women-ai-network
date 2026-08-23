import { createHash } from 'node:crypto';
import type {
  GlobalizationPreferences,
  GlobalizationPreferencesRequest,
  GlobalizationRepositoryPort,
} from '@wai/contracts';
import type { Pool } from 'pg';

export class GlobalizationVersionConflictError extends Error {
  readonly code = 'GLOBALIZATION_VERSION_CONFLICT';
}
export class GlobalizationIdempotencyConflictError extends Error {
  readonly code = 'GLOBALIZATION_IDEMPOTENCY_CONFLICT';
}
export class GlobalizationTimeZoneError extends Error {
  readonly code = 'GLOBALIZATION_TIME_ZONE_INVALID';
}
export class GlobalizationAccountUnavailableError extends Error {
  readonly code = 'GLOBALIZATION_ACCOUNT_UNAVAILABLE';
}

type Stored = {
  account_id: string;
  ui_locale: string;
  content_locales: string[];
  time_zone: string;
  hour_cycle: string;
  week_start: number;
  version: number;
  updated_at: Date;
};
function toValue(row: Stored): GlobalizationPreferences {
  return {
    account_id: row.account_id,
    ui_locale: row.ui_locale as GlobalizationPreferences['ui_locale'],
    content_locales: row.content_locales,
    time_zone: row.time_zone,
    hour_cycle: row.hour_cycle as GlobalizationPreferences['hour_cycle'],
    week_start: row.week_start,
    version: row.version,
    updated_at: new Date(row.updated_at).toISOString(),
  };
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function hash(value: unknown): string {
  return digest(JSON.stringify(value));
}

export class PgGlobalizationRepository implements GlobalizationRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async read(accountId: string): Promise<GlobalizationPreferences | null> {
    const result = await this.pool.query<Stored>(
      `SELECT p.account_id,p.ui_locale,p.content_locales,p.time_zone,p.hour_cycle,p.week_start,p.version,p.updated_at FROM globalization.account_preferences p JOIN iam.accounts a ON a.id=p.account_id AND a.state='enabled' WHERE p.account_id=$1`,
      [accountId],
    );
    if (result.rows[0] !== undefined) return toValue(result.rows[0]);
    const account = await this.pool.query<{ state: string }>(
      'SELECT state FROM iam.accounts WHERE id=$1',
      [accountId],
    );
    if (account.rows[0]?.state !== 'enabled') return null;
    return {
      account_id: accountId,
      ui_locale: 'en',
      content_locales: [],
      time_zone: 'UTC',
      hour_cycle: 'h23',
      week_start: 1,
      version: 0,
      updated_at: new Date().toISOString(),
    };
  }

  async replace(input: {
    accountId: string;
    expectedVersion: number;
    idempotencyKey: string;
    requestDigest: string;
    value: GlobalizationPreferencesRequest;
    now: Date;
  }): Promise<{ value: GlobalizationPreferences; replayed: boolean }> {
    const client = await this.pool.connect();
    const keyDigest = digest(input.idempotencyKey);
    try {
      await client.query('BEGIN');
      const account = await client.query<{ state: string }>(
        'SELECT state FROM iam.accounts WHERE id=$1 FOR UPDATE',
        [input.accountId],
      );
      if (account.rows[0]?.state !== 'enabled') throw new GlobalizationAccountUnavailableError();
      const existing = await client.query<{
        request_digest: string;
        response_json: GlobalizationPreferences;
      }>(
        'SELECT request_digest,response_json FROM globalization.preference_idempotency WHERE account_id=$1 AND idempotency_key_digest=$2',
        [input.accountId, keyDigest],
      );
      if (existing.rows[0] !== undefined) {
        if (existing.rows[0].request_digest !== input.requestDigest)
          throw new GlobalizationIdempotencyConflictError();
        await client.query('COMMIT');
        return { value: existing.rows[0].response_json, replayed: true };
      }
      const current = await client.query<Stored>(
        'SELECT account_id,ui_locale,content_locales,time_zone,hour_cycle,week_start,version,updated_at FROM globalization.account_preferences WHERE account_id=$1 FOR UPDATE',
        [input.accountId],
      );
      const old = current.rows[0];
      if (old === undefined && input.expectedVersion !== 0)
        throw new GlobalizationVersionConflictError();
      if (old !== undefined && old.version !== input.expectedVersion)
        throw new GlobalizationVersionConflictError();
      const timezone = await client.query<{ name: string }>(
        'SELECT name FROM pg_timezone_names WHERE name=$1 LIMIT 1',
        [input.value.time_zone],
      );
      if (timezone.rows[0] === undefined) throw new GlobalizationTimeZoneError();
      const version = old === undefined ? 1 : old.version + 1;
      const row = (
        await client.query<Stored>(
          `INSERT INTO globalization.account_preferences(account_id,ui_locale,content_locales,time_zone,hour_cycle,week_start,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT(account_id) DO UPDATE SET ui_locale=EXCLUDED.ui_locale,content_locales=EXCLUDED.content_locales,time_zone=EXCLUDED.time_zone,hour_cycle=EXCLUDED.hour_cycle,week_start=EXCLUDED.week_start,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at RETURNING account_id,ui_locale,content_locales,time_zone,hour_cycle,week_start,version,updated_at`,
          [
            input.accountId,
            input.value.ui_locale,
            input.value.content_locales,
            input.value.time_zone,
            input.value.hour_cycle,
            input.value.week_start,
            version,
            input.now,
          ],
        )
      ).rows[0];
      if (row === undefined) throw new Error('globalization preference write returned no row');
      await client.query(
        `INSERT INTO globalization.preference_audit(account_id,version,ui_locale_old,ui_locale_new,content_locales_old_hash,content_locales_new_hash,time_zone_old_hash,time_zone_new_hash,hour_cycle_old,hour_cycle_new,week_start_old,week_start_new,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          input.accountId,
          version,
          old?.ui_locale ?? null,
          input.value.ui_locale,
          old === undefined ? null : hash(old.content_locales),
          hash(input.value.content_locales),
          old === undefined ? null : hash(old.time_zone),
          hash(input.value.time_zone),
          old?.hour_cycle ?? null,
          input.value.hour_cycle,
          old?.week_start ?? null,
          input.value.week_start,
          input.now,
        ],
      );
      const value = toValue(row);
      await client.query(
        'INSERT INTO globalization.preference_idempotency(account_id,idempotency_key_digest,request_digest,response_json,created_at) VALUES($1,$2,$3,$4,$5)',
        [input.accountId, keyDigest, input.requestDigest, JSON.stringify(value), input.now],
      );
      await client.query('COMMIT');
      return { value, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
