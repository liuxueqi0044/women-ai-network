import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../client.js';
import { devices } from '../schema.js';

export interface DeviceRow {
  id: string;
  accountId: string;
  deviceDigest: string;
  label: string;
  uaDigest: string;
  uaSummary: string | null;
  ipHmac: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface NewDevice {
  id: string;
  accountId: string;
  deviceDigest: string;
  label: string;
  uaDigest: string;
  uaSummary: string | null;
  ipHmac: string;
  now: Date;
}

export interface DeviceRepository {
  /**
   * Insert or refresh the device keyed by (account, digest). A login with the
   * SAME cookie after a revoke re-activates the record (revoked_at reset) —
   * the cookie is the device identity, and a revoked device that logs in again
   * must be revocable again.
   */
  upsert(input: NewDevice): Promise<DeviceRow>;
  findByAccountAndDigest(accountId: string, deviceDigest: string): Promise<DeviceRow | null>;
  findById(accountId: string, deviceId: string): Promise<DeviceRow | null>;
  listByAccount(accountId: string): Promise<DeviceRow[]>;
  rename(accountId: string, deviceId: string, label: string): Promise<DeviceRow | null>;
  revoke(accountId: string, deviceId: string, now: Date): Promise<DeviceRow | null>;
  /** Tx-scoped revoke gate (revoked_at IS NULL): a concurrent revoke loses (null). */
  revokeTx(tx: Db, accountId: string, deviceId: string, now: Date): Promise<DeviceRow | null>;
}

export class PgDeviceRepository implements DeviceRepository {
  constructor(private readonly db: Db) {}

  async upsert(input: NewDevice): Promise<DeviceRow> {
    const rows = await this.db
      .insert(devices)
      .values({
        id: input.id,
        accountId: input.accountId,
        deviceDigest: input.deviceDigest,
        label: input.label,
        uaDigest: input.uaDigest,
        uaSummary: input.uaSummary,
        ipHmac: input.ipHmac,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
      })
      .onConflictDoUpdate({
        target: [devices.accountId, devices.deviceDigest],
        // Re-login refreshes the coarse summary/digests/ip and re-activates
        // the record — the cookie is the device identity.
        set: {
          label: input.label,
          uaDigest: input.uaDigest,
          uaSummary: input.uaSummary,
          ipHmac: input.ipHmac,
          lastSeenAt: input.now,
          revokedAt: null,
        },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error('upsert device returned no row');
    }
    return row as unknown as DeviceRow;
  }

  async findByAccountAndDigest(accountId: string, deviceDigest: string): Promise<DeviceRow | null> {
    const rows = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.accountId, accountId), eq(devices.deviceDigest, deviceDigest)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as DeviceRow);
  }

  async findById(accountId: string, deviceId: string): Promise<DeviceRow | null> {
    const rows = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.accountId, accountId), eq(devices.id, deviceId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : (row as unknown as DeviceRow);
  }

  async listByAccount(accountId: string): Promise<DeviceRow[]> {
    const rows = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.accountId, accountId), isNull(devices.revokedAt)))
      .orderBy(desc(devices.lastSeenAt));
    return rows as unknown as DeviceRow[];
  }

  async rename(accountId: string, deviceId: string, label: string): Promise<DeviceRow | null> {
    const rows = await this.db
      .update(devices)
      .set({ label })
      .where(
        and(eq(devices.accountId, accountId), eq(devices.id, deviceId), isNull(devices.revokedAt)),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : (row as unknown as DeviceRow);
  }

  async revoke(accountId: string, deviceId: string, now: Date): Promise<DeviceRow | null> {
    return this.revokeTx(this.db, accountId, deviceId, now);
  }

  async revokeTx(
    tx: Db,
    accountId: string,
    deviceId: string,
    now: Date,
  ): Promise<DeviceRow | null> {
    const rows = await tx
      .update(devices)
      .set({ revokedAt: now })
      .where(
        and(eq(devices.accountId, accountId), eq(devices.id, deviceId), isNull(devices.revokedAt)),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : (row as unknown as DeviceRow);
  }
}
