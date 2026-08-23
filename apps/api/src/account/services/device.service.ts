import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { DeviceSummary } from '@wai/contracts';
import type { AuditRepository, Db, DeviceRepository, DeviceRow, SessionRepository } from '@wai/db';
import { ipPrefix } from '../infra/ip-prefix.js';
import {
  CLOCK,
  RANDOM_SOURCE,
  TOKEN_DIGESTER,
  type Clock,
  type RandomSource,
  type TokenDigester,
} from '../ports.js';
import {
  AUDIT_REPOSITORY,
  DEVICE_REPOSITORY,
  IAM_DB,
  SESSION_REPOSITORY,
} from '../repositories.js';

/**
 * Devices (task book §9). A device is keyed by a server-random opaque cookie
 * (`wai_device`, 365 days) — no canvas/font/hardware fingerprinting. Only
 * MINIMAL metadata is stored: the user-set label, a coarse browser/OS
 * summary (never the raw User-Agent — its keyed digest instead), the ipHmac,
 * and first/last seen.
 *
 * Revoking a device atomically revokes every active session bound to it in a
 * single transaction.
 */
@Injectable()
export class DeviceService {
  constructor(
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(IAM_DB) private readonly db: Db,
    @Inject(TOKEN_DIGESTER) private readonly digester: TokenDigester,
    @Inject(RANDOM_SOURCE) private readonly random: RandomSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Called at session issuance (login / MFA completion): create the device
   * from the cookie, or refresh its last_seen. A missing cookie gets a fresh
   * opaque token that the caller must set on the response.
   *
   * R1-06B: the persisted ip_hmac is the keyed HMAC of the client's IP
   * PREFIX (/24 for IPv4, /64 for IPv6), never of the full address — the raw
   * IP never leaves this method and is never stored or logged.
   */
  async touchForLogin(input: {
    accountId: string;
    deviceToken: string | null;
    userAgent: string | null;
    ip: string;
    nowMs: number;
  }): Promise<{ device: DeviceRow; deviceToken: string }> {
    const deviceToken = input.deviceToken ?? this.random.bytes(32).toString('base64url');
    const uaSummary = summarizeUserAgent(input.userAgent);
    const row = await this.devices.upsert({
      id: this.random.uuid(),
      accountId: input.accountId,
      deviceDigest: this.digester.digest('device', deviceToken),
      label: uaSummary,
      uaDigest: this.digester.digest('ua', input.userAgent ?? ''),
      uaSummary,
      ipHmac: this.digester.digest('device-ip', ipPrefix(input.ip) ?? 'unknown'),
      now: new Date(input.nowMs),
    });
    return { device: row, deviceToken };
  }

  /** The caller's un-revoked devices, most recently seen first. */
  async list(accountId: string): Promise<DeviceRow[]> {
    return this.devices.listByAccount(accountId);
  }

  /** Rename one of the caller's devices — unknown/cross-account → stable 404. */
  async rename(input: { accountId: string; deviceId: string; label: string }): Promise<DeviceRow> {
    const row = await this.devices.rename(input.accountId, input.deviceId, input.label);
    if (row === null) {
      throw deviceNotFound();
    }
    return row;
  }

  /** Revoke the device AND all its active sessions in one transaction. */
  async revoke(input: { accountId: string; deviceId: string; ipHmac: string }): Promise<void> {
    const now = new Date(this.clock.now());
    await this.db.transaction(async (tx) => {
      const row = await this.devices.revokeTx(tx, input.accountId, input.deviceId, now);
      if (row === null) {
        // Unknown, cross-account or already revoked — stable 404, and no
        // writes happened before the throw so the rollback is harmless.
        throw deviceNotFound();
      }
      await this.sessions.revokeByDevice(tx, input.deviceId, 'device_revoked', now);
      await this.audit.appendSecurityEventTx(tx, {
        eventType: 'device.revoked',
        accountId: input.accountId,
        deviceId: input.deviceId,
        severity: 'info',
        reason: 'DEVICE_REVOKED',
        ipHmac: input.ipHmac,
        now,
      });
    });
  }
}

/** Public device summary — ids, label, coarse summary and timestamps only. */
export function toDeviceSummary(row: DeviceRow): DeviceSummary {
  return {
    device_id: row.id,
    label: row.label,
    summary: row.uaSummary ?? row.label,
    first_seen_at: row.firstSeenAt.toISOString(),
    last_seen_at: row.lastSeenAt.toISOString(),
    ...(row.revokedAt === null ? {} : { revoked_at: row.revokedAt.toISOString() }),
  };
}

/**
 * Coarse browser/OS classification — the ONLY User-Agent-derived data ever
 * stored or shown. Deterministic and pure: no raw UA leaves the request.
 */
export function summarizeUserAgent(userAgent: string | null): string {
  const ua = userAgent ?? '';
  // iOS UAs carry "like Mac OS X" — check mobile platforms before desktop.
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Macintosh|Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Unknown browser';
  return `${browser} on ${os}`;
}

/** Uniform 404 — unknown and cross-account device ids look identical. */
export function deviceNotFound(): HttpException {
  return new HttpException({ code: 'DEVICE_NOT_FOUND', message: 'Device not found' }, 404);
}
