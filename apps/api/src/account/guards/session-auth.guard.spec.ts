import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { loadEnv, type AppConfig } from '@wai/config';
import { parsePepper, type Db } from '@wai/db';
import { FixedClock } from '@wai/testkit';
import { NodeTokenDigester } from '../infra/node-token-digester.js';
import { AccountStateService } from '../services/account-state.service.js';
import {
  expectHttpException,
  FakeAccountRepository,
  FakeAuditRepository,
  FakeSessionRepository,
  makeAccountRow,
  makeSessionRow,
} from '../services/spec-helpers.js';
import { SessionAuthGuard } from './session-auth.guard.js';

const COOKIE = 'wai_session_dev';

/**
 * R1-03: any request authenticated through the guard counts as activity —
 * the guard refreshes the idle window (capped at the absolute expiry by the
 * R1-02 helper) and NEVER touches on denied/expired/rotated/replay paths.
 */
function setup(): {
  config: AppConfig;
  sessions: FakeSessionRepository;
  accounts: FakeAccountRepository;
  audit: FakeAuditRepository;
  guard: SessionAuthGuard;
  digester: NodeTokenDigester;
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
  const guard = new SessionAuthGuard(
    config,
    digester,
    sessions,
    accounts,
    audit,
    db,
    clock,
    new AccountStateService(),
  );
  return { config, sessions, accounts, audit, guard, digester };
}

function requestWith(token: string | undefined, ip = '203.0.113.7'): ExecutionContext {
  const cookies = token === undefined ? {} : { [COOKIE]: token };
  return {
    switchToHttp: () => ({
      getRequest: () => ({ ip, cookies }),
      getResponse: () => ({ clearCookie: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('SessionAuthGuard (R1-03 activity refresh)', () => {
  it('touches the session on success, capped at the absolute expiry', async () => {
    const s = setup();
    const token = 'valid-token';
    s.accounts.seed(makeAccountRow({}));
    s.sessions.seed(makeSessionRow({ tokenDigest: s.digester.digest('session', token) }));

    const allowed = await s.guard.canActivate(requestWith(token));

    expect(allowed).toBe(true);
    expect(s.sessions.touchCalls).toEqual([
      expect.objectContaining({
        id: 'session-1',
        // Seeded absolute (24h) is shorter than the 7d idle window: capped.
        idleExpiresAt: new Date(1_000_000 + 86_400_000),
      }),
    ]);
  });

  it('touches with the full idle window when far from the absolute expiry', async () => {
    const s = setup();
    const token = 'valid-token';
    s.accounts.seed(makeAccountRow({}));
    s.sessions.seed(
      makeSessionRow({
        tokenDigest: s.digester.digest('session', token),
        idleExpiresAt: new Date(1_000_000 + 3_600_000),
        absoluteExpiresAt: new Date(1_000_000 + 2_592_000_000), // 30 days
      }),
    );

    const allowed = await s.guard.canActivate(requestWith(token));

    expect(allowed).toBe(true);
    expect(s.sessions.touchCalls).toEqual([
      expect.objectContaining({
        id: 'session-1',
        idleExpiresAt: new Date(1_000_000 + 604_800_000), // now + 7d idle
      }),
    ]);
  });

  it('rejects when revocation wins after the initial read but before activity touch', async () => {
    const s = setup();
    const token = 'revoked-between-read-and-touch';
    s.accounts.seed(makeAccountRow({}));
    s.sessions.seed(makeSessionRow({ tokenDigest: s.digester.digest('session', token) }));
    const findAccount = s.accounts.findById.bind(s.accounts);
    s.accounts.findById = async (accountId: string) => {
      await s.sessions.revokeById({} as Db, 'session-1', 'concurrent_revoke', new Date(1_000_000));
      return findAccount(accountId);
    };

    try {
      await s.guard.canActivate(requestWith(token));
      expect.unreachable('a session revoked before the conditional touch must not authorize');
    } catch (error) {
      expectHttpException(error, 401, 'SESSION_REQUIRED');
    }
  });

  it('never touches when the session is idle-expired', async () => {
    const s = setup();
    const token = 'expired-token';
    s.accounts.seed(makeAccountRow({}));
    s.sessions.seed(
      makeSessionRow({
        tokenDigest: s.digester.digest('session', token),
        idleExpiresAt: new Date(1_000_000), // idle window already closed
      }),
    );

    try {
      await s.guard.canActivate(requestWith(token));
      expect.unreachable('guard must throw');
    } catch (error) {
      expectHttpException(error, 401, 'SESSION_REQUIRED');
    }
    expect(s.sessions.touchCalls).toHaveLength(0);
  });

  it('never touches when the session is absolute-expired', async () => {
    const s = setup();
    const token = 'abs-expired-token';
    s.accounts.seed(makeAccountRow({}));
    s.sessions.seed(
      makeSessionRow({
        tokenDigest: s.digester.digest('session', token),
        absoluteExpiresAt: new Date(1_000_000),
      }),
    );

    try {
      await s.guard.canActivate(requestWith(token));
      expect.unreachable('guard must throw');
    } catch (error) {
      expectHttpException(error, 401, 'SESSION_REQUIRED');
    }
    expect(s.sessions.touchCalls).toHaveLength(0);
  });

  it('never touches on replay: the rotated token compromises the family', async () => {
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
      await s.guard.canActivate(requestWith(token));
      expect.unreachable('guard must throw');
    } catch (error) {
      expectHttpException(error, 401, 'SESSION_REPLAY_DETECTED');
    }
    expect(s.sessions.touchCalls).toHaveLength(0);
    expect(s.sessions.rows.get('successor-1')?.state).toBe('compromised');
    expect(s.audit.events).toEqual([
      expect.objectContaining({ eventType: 'session.replay_detected' }),
    ]);
  });

  it('never touches on account-state denial: sessions are revoked', async () => {
    const s = setup();
    const token = 'denied-token';
    s.accounts.seed(makeAccountRow({ state: 'suspended', stateReason: 'admin_suspend' }));
    s.sessions.seed(makeSessionRow({ tokenDigest: s.digester.digest('session', token) }));

    try {
      await s.guard.canActivate(requestWith(token));
      expect.unreachable('guard must throw');
    } catch (error) {
      expectHttpException(error, 401, 'ACCOUNT_STATE_DENIED');
    }
    expect(s.sessions.touchCalls).toHaveLength(0);
    expect(s.sessions.rows.get('session-1')?.state).toBe('revoked');
  });

  it('never touches when no cookie is presented', async () => {
    const s = setup();
    try {
      await s.guard.canActivate(requestWith(undefined));
      expect.unreachable('guard must throw');
    } catch (error) {
      expectHttpException(error, 401, 'SESSION_REQUIRED');
    }
    expect(s.sessions.touchCalls).toHaveLength(0);
  });
});
