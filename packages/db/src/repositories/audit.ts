import type { Db } from '../client.js';
import { securityEvents } from '../schema.js';

/**
 * Append-only security event log. Carries the MINIMAL metadata only — never
 * tokens, emails, passwords, codes or full IPs (ipHmac is a keyed digest of
 * a coarse prefix). `reason` is a stable enum-ish code for internal triage
 * (e.g. INVALID_CREDENTIALS_UNKNOWN_EMAIL vs INVALID_CREDENTIALS_BAD_PASSWORD).
 */

export type SecurityEventSeverity = 'info' | 'warning' | 'critical';

export interface SecurityEventInput {
  eventType: string;
  accountId?: string;
  sessionId?: string;
  deviceId?: string;
  severity: SecurityEventSeverity;
  reason: string;
  ipHmac?: string;
  now: Date;
}

export interface AuditRepository {
  appendSecurityEvent(input: SecurityEventInput): Promise<void>;
  /** Append inside an existing transaction — atomic with the state change (replay compromise, revoke). */
  appendSecurityEventTx(tx: Db, input: SecurityEventInput): Promise<void>;
}

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly db: Db) {}

  async appendSecurityEvent(input: SecurityEventInput): Promise<void> {
    await this.appendSecurityEventTx(this.db, input);
  }

  async appendSecurityEventTx(tx: Db, input: SecurityEventInput): Promise<void> {
    await tx.insert(securityEvents).values({
      eventType: input.eventType,
      accountId: input.accountId,
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      severity: input.severity,
      reason: input.reason,
      ipHmac: input.ipHmac,
      createdAt: input.now,
    });
  }
}
