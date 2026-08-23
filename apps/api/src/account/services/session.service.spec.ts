import { describe, expect, it } from 'vitest';
import { loadEnv, type AppConfig } from '@wai/config';
import { parsePepper, type Db } from '@wai/db';
import { DeterministicRandomSource, FixedClock } from '@wai/testkit';
import { NodeTokenDigester } from '../infra/node-token-digester.js';
import { AccountStateService } from './account-state.service.js';
import {
  expectHttpException,
  FakeAccountRepository,
  FakeAuditRepository,
  FakeSessionRepository,
  makeAccountRow,
  makeSessionRow,
} from './spec-helpers.js';
import { SessionService } from './session.service.js';

const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * CP4 unit spec for SessionService (task book §6). Fixed clock at 1_000_000
 * makes the sliding-window math exact: touch extends the idle expiry, rotate
 * issues a fresh opaque token with the family's absolute expiry inherited,
 * replay of a rotated token compromises the family, and account-state denial
 * revokes the account's sessions atomically with the audit event.
 */
function setup(): {
  config: AppConfig;
  accounts: FakeAccountRepository;
  sessions: FakeSessionRepository;
  audit: FakeAuditRepository;
  digester: NodeTokenDigester;
  service: SessionService;
} {
  const config = loadEnv({ NODE_ENV: 'test', LOG_PRETTY: 'false' });
  const clock = new FixedClock(1_000_000);
  const digester = new NodeTokenDigester(parsePepper(config.iam.secretPepper));
  const accounts = new FakeAccountRepository();
  const sessions = new FakeSessionRepository();
  const audit = new FakeAuditRepository();
  const db = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as Db;
  const service = new SessionService(
    config,
    sessions,
    accounts,
    audit,
    db,
    digester,
    clock,
    new DeterministicRandomSource(),
    new AccountStateService(),
  );
  return { config, accounts, sessions, audit, digester, service };
}

describe('SessionService', () => {
  describe('findOwned', () => {
    it('returns the current-session row without writing (the R1-03 guard touched)', async () => {
      const s = setup();
      s.accounts.seed(makeAccountRow({}));
      s.sessions.seed(makeSessionRow({}));

      const row = await s.service.findOwned('account-1', 'session-1');

      expect(row.id).toBe('session-1');
      expect(row.idleExpiresAt.getTime()).toBe(1_000_000 + 3_600_000); // untouched seed value
      expect(s.sessions.touchCalls).toHaveLength(0);
    });

    it('rejects a session that belongs to another account', async () => {
      const s = setup();
      s.sessions.seed(makeSessionRow({}));
      try {
        await s.service.findOwned('account-other', 'session-1');
        expect.unreachable('findOwned must throw');
      } catch (error) {
        expectHttpException(error, 401, 'SESSION_REQUIRED');
      }
    });
  });

  describe('list', () => {
    it('returns only active sessions of the account', async () => {
      const s = setup();
      s.sessions.seed(makeSessionRow({ id: 's-1' }));
      s.sessions.seed(makeSessionRow({ id: 's-2', tokenDigest: 'd2' }));
      s.sessions.seed(
        makeSessionRow({
          id: 's-3',
          tokenDigest: 'd3',
          state: 'revoked',
          revokedAt: new Date(1_000_000),
        }),
      );
      s.sessions.seed(makeSessionRow({ id: 's-4', tokenDigest: 'd4', accountId: 'account-other' }));

      const rows = await s.service.list('account-1');

      expect(rows.map((row) => row.id).sort()).toEqual(['s-1', 's-2']);
    });
  });

  describe('rotate', () => {
    it('issues a fresh opaque token; family, auth level and absolute expiry are inherited', async () => {
      const s = setup();
      s.accounts.seed(makeAccountRow({}));
      const token = 'first-token';
      s.sessions.seed(makeSessionRow({ tokenDigest: s.digester.digest('session', token) }));

      const result = await s.service.rotate({ token, ipHmac: 'ip-a' });

      expect(result.token).toMatch(OPAQUE_TOKEN);
      expect(result.token).not.toBe(token);
      expect(result.state).toBe('active');
      expect(result.generation).toBe(2);
      expect(result.authLevel).toBe('aal1');
      expect(result.absoluteExpiresAtMs).toBe(1_000_000 + 86_400_000); // never extended
      // R1-02: the successor idle is capped at the inherited absolute expiry
      // (seeded absolute 24h < 7d idle window, so the cap applies).
      expect(result.idleExpiresAtMs).toBe(1_000_000 + 86_400_000);

      const rotated = s.sessions.rows.get('session-1');
      expect(rotated?.state).toBe('rotated');
      expect(rotated?.successorId).toBe(result.sessionId);
      expect(rotated?.rotatedAt?.getTime()).toBe(1_000_000);

      const successor = s.sessions.rows.get(result.sessionId);
      expect(successor?.familyId).toBe('family-1');
      expect(successor?.parentId).toBe('session-1');
      expect(successor?.generation).toBe(2);
      expect(successor?.authLevel).toBe('aal1');
      expect(successor?.absoluteExpiresAt.getTime()).toBe(1_000_000 + 86_400_000);
      expect(successor?.idleExpiresAt.getTime()).toBe(1_000_000 + 86_400_000);

      expect(s.audit.events).toEqual([
        expect.objectContaining({
          eventType: 'session.rotated',
          severity: 'info',
          reason: 'SESSION_ROTATED',
          accountId: 'account-1',
          sessionId: 'session-1',
          ipHmac: 'ip-a',
        }),
      ]);
    });

    it('caps the successor idle expiry at the inherited absolute expiry near session end', async () => {
      const s = setup();
      s.accounts.seed(makeAccountRow({}));
      const token = 'last-minute-token';
      // One minute of absolute life left; the idle window (7d) must cap.
      s.sessions.seed(
        makeSessionRow({
          tokenDigest: s.digester.digest('session', token),
          idleExpiresAt: new Date(1_000_000 + 60_000),
          absoluteExpiresAt: new Date(1_000_000 + 60_000),
        }),
      );

      const result = await s.service.rotate({ token, ipHmac: 'ip-a' });

      expect(result.absoluteExpiresAtMs).toBe(1_000_000 + 60_000); // never extended
      expect(result.idleExpiresAtMs).toBe(1_000_000 + 60_000); // capped, never beyond

      const successor = s.sessions.rows.get(result.sessionId);
      expect(successor?.idleExpiresAt.getTime()).toBe(1_000_000 + 60_000);
      expect(successor?.absoluteExpiresAt.getTime()).toBe(1_000_000 + 60_000);
    });

    it('a rotated token resurfacing is replay: the family is compromised', async () => {
      const s = setup();
      const token = 'old-token';
      s.sessions.seed(
        makeSessionRow({
          tokenDigest: s.digester.digest('session', token),
          state: 'rotated',
          rotatedAt: new Date(1_000_000),
        }),
      );
      s.sessions.seed(
        makeSessionRow({
          id: 'successor-1',
          tokenDigest: s.digester.digest('session', 'successor-token'),
          parentId: 'session-1',
        }),
      );

      try {
        await s.service.rotate({ token, ipHmac: 'ip-r' });
        expect.unreachable('rotate must throw');
      } catch (error) {
        expectHttpException(error, 401, 'SESSION_REPLAY_DETECTED');
      }

      expect(s.sessions.rows.get('successor-1')?.state).toBe('compromised');
      expect(s.audit.events).toEqual([
        expect.objectContaining({
          eventType: 'session.replay_detected',
          severity: 'critical',
          reason: 'SESSION_REPLAY_DETECTED',
          ipHmac: 'ip-r',
        }),
      ]);
    });

    it('rejects revoked and expired tokens uniformly', async () => {
      const s = setup();
      s.sessions.seed(
        makeSessionRow({
          tokenDigest: s.digester.digest('session', 'revoked-token'),
          state: 'revoked',
          revokedAt: new Date(1_000_000),
        }),
      );
      s.sessions.seed(
        makeSessionRow({
          id: 'expired-1',
          tokenDigest: s.digester.digest('session', 'expired-token'),
          idleExpiresAt: new Date(1_000_000),
        }),
      );

      for (const token of ['revoked-token', 'expired-token', 'unknown-token']) {
        try {
          await s.service.rotate({ token, ipHmac: 'ip-x' });
          expect.unreachable('rotate must throw');
        } catch (error) {
          expectHttpException(error, 401, 'SESSION_REQUIRED');
        }
      }
      expect(s.audit.events).toEqual([]);
    });

    it('denied account state revokes every session and records the reason', async () => {
      const s = setup();
      s.accounts.seed(
        makeAccountRow({ id: 'account-9', state: 'suspended', stateReason: 'admin_suspend' }),
      );
      const token = 'suspended-token';
      s.sessions.seed(
        makeSessionRow({
          accountId: 'account-9',
          tokenDigest: s.digester.digest('session', token),
        }),
      );
      s.sessions.seed(
        makeSessionRow({
          id: 'other-session',
          accountId: 'account-9',
          tokenDigest: s.digester.digest('session', 'other-token'),
        }),
      );

      try {
        await s.service.rotate({ token, ipHmac: 'ip-s' });
        expect.unreachable('rotate must throw');
      } catch (error) {
        expectHttpException(error, 401, 'ACCOUNT_STATE_DENIED');
      }

      for (const row of s.sessions.rows.values()) {
        expect(row.state).toBe('revoked');
        expect(row.revokedReason).toBe('account_state_denied');
      }
      expect(s.audit.events).toEqual([
        expect.objectContaining({
          eventType: 'account.state_denied',
          severity: 'warning',
          reason: 'ACCOUNT_STATE_DENIED_SUSPENDED',
          accountId: 'account-9',
          ipHmac: 'ip-s',
        }),
      ]);
    });
  });

  describe('logout', () => {
    it('revokes the session and records the logout event; a second logout is a no-op', async () => {
      const s = setup();
      s.sessions.seed(makeSessionRow({}));

      await s.service.logout({ accountId: 'account-1', sessionId: 'session-1', ipHmac: 'ip-l' });
      await s.service.logout({ accountId: 'account-1', sessionId: 'session-1', ipHmac: 'ip-l' });

      const row = s.sessions.rows.get('session-1');
      expect(row?.state).toBe('revoked');
      expect(row?.revokedReason).toBe('logout');
      expect(s.audit.events).toEqual([
        expect.objectContaining({
          eventType: 'session.revoked',
          severity: 'info',
          reason: 'LOGOUT',
          sessionId: 'session-1',
        }),
      ]);
    });
  });

  describe('revokeById', () => {
    it('revokes the caller’s own session', async () => {
      const s = setup();
      s.sessions.seed(makeSessionRow({}));

      await s.service.revokeById({
        accountId: 'account-1',
        sessionId: 'session-1',
        ipHmac: 'ip-v',
      });

      const row = s.sessions.rows.get('session-1');
      expect(row?.state).toBe('revoked');
      expect(row?.revokedReason).toBe('revoked_by_user');
      expect(s.audit.events).toEqual([
        expect.objectContaining({
          eventType: 'session.revoked',
          severity: 'info',
          reason: 'REVOKED_BY_USER',
          sessionId: 'session-1',
        }),
      ]);
    });

    it('answers the same 404 for another account’s session and unknown ids', async () => {
      const s = setup();
      s.sessions.seed(
        makeSessionRow({ id: 'theirs', tokenDigest: 'd-theirs', accountId: 'account-other' }),
      );

      for (const sessionId of ['theirs', 'no-such-session']) {
        try {
          await s.service.revokeById({ accountId: 'account-1', sessionId, ipHmac: 'ip-v' });
          expect.unreachable('revokeById must throw');
        } catch (error) {
          expectHttpException(error, 404, 'NOT_FOUND');
        }
      }
      expect(s.sessions.rows.get('theirs')?.state).toBe('active');
      expect(s.audit.events).toEqual([]);
    });

    it('an already-revoked session is a silent no-op', async () => {
      const s = setup();
      s.sessions.seed(
        makeSessionRow({
          state: 'revoked',
          revokedAt: new Date(1_000_000),
          revokedReason: 'logout',
        }),
      );

      await s.service.revokeById({
        accountId: 'account-1',
        sessionId: 'session-1',
        ipHmac: 'ip-v',
      });

      expect(s.audit.events).toEqual([]);
    });
  });
});
