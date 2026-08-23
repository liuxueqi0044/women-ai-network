import { describe, expect, it } from 'vitest';
import { loadEnv, type AppConfig } from '@wai/config';
import { parsePepper, type Db } from '@wai/db';
import { DeterministicRandomSource, FixedClock } from '@wai/testkit';
import { NodeTokenDigester } from '../infra/node-token-digester.js';
import {
  expectHttpException,
  FakeAuditRepository,
  FakeDeviceRepository,
  FakeSessionRepository,
  makeDeviceRow,
  makeSessionRow,
} from './spec-helpers.js';
import { DeviceService, summarizeUserAgent, toDeviceSummary } from './device.service.js';

const AT_MS = 1_000_000;
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * CP5 unit spec for DeviceService (task book §9). A device is the server-side
 * identity of the `wai_device` cookie: created on first login, refreshed on
 * every login with the same cookie (even after a revoke — the record must be
 * revocable again), never fingerprinted. Only a coarse UA summary + keyed
 * digests are stored, and revoking a device atomically revokes its sessions.
 */
function setup(): {
  config: AppConfig;
  devices: FakeDeviceRepository;
  sessions: FakeSessionRepository;
  audit: FakeAuditRepository;
  digester: NodeTokenDigester;
  service: DeviceService;
} {
  const config = loadEnv({ NODE_ENV: 'test', LOG_PRETTY: 'false' });
  const clock = new FixedClock(AT_MS);
  const digester = new NodeTokenDigester(parsePepper(config.iam.secretPepper));
  const devices = new FakeDeviceRepository();
  const sessions = new FakeSessionRepository();
  const audit = new FakeAuditRepository();
  const db = {
    transaction: <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  } as unknown as Db;
  const service = new DeviceService(
    devices,
    sessions,
    audit,
    db,
    digester,
    new DeterministicRandomSource(),
    clock,
  );
  return { config, devices, sessions, audit, digester, service };
}

describe('DeviceService', () => {
  describe('touchForLogin', () => {
    it('creates a device from a missing cookie and returns a fresh opaque token', async () => {
      const s = setup();

      const result = await s.service.touchForLogin({
        accountId: 'account-1',
        deviceToken: null,
        userAgent: CHROME_UA,
        ip: '1.2.3.4',
        nowMs: AT_MS,
      });

      expect(result.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.device.accountId).toBe('account-1');
      expect(result.device.label).toBe('Chrome on Windows');
      expect(result.device.uaSummary).toBe('Chrome on Windows');
      expect(result.device.uaDigest).toBe(s.digester.digest('ua', CHROME_UA));
      // R1-06B: the persisted ip_hmac is the keyed HMAC of the /24 prefix —
      // never of the full address.
      expect(result.device.ipHmac).toBe(s.digester.digest('device-ip', '1.2.3.0/24'));
      expect(result.device.firstSeenAt.getTime()).toBe(AT_MS);
      expect(result.device.lastSeenAt.getTime()).toBe(AT_MS);
      expect(s.devices.rows.get(result.device.id)).toBeDefined();
    });

    it('reuses the same device for the same cookie, refreshing last_seen only', async () => {
      const s = setup();
      const first = await s.service.touchForLogin({
        accountId: 'account-1',
        deviceToken: 'same-cookie',
        userAgent: CHROME_UA,
        ip: '1.2.3.4',
        nowMs: AT_MS,
      });

      const second = await s.service.touchForLogin({
        accountId: 'account-1',
        deviceToken: 'same-cookie',
        userAgent: CHROME_UA,
        ip: '1.2.3.4',
        nowMs: AT_MS + 3_600_000,
      });

      expect(second.device.id).toBe(first.device.id);
      expect(second.device.firstSeenAt.getTime()).toBe(AT_MS);
      expect(second.device.lastSeenAt.getTime()).toBe(AT_MS + 3_600_000);
      expect(second.deviceToken).toBe('same-cookie');
    });

    it('re-activates a revoked device that logs in again with the same cookie', async () => {
      const s = setup();
      s.devices.seed(
        makeDeviceRow({
          id: 'device-1',
          deviceDigest: s.digester.digest('device', 'same-cookie'),
          revokedAt: new Date(AT_MS),
        }),
      );

      const result = await s.service.touchForLogin({
        accountId: 'account-1',
        deviceToken: 'same-cookie',
        userAgent: null,
        ip: '5.6.7.8',
        nowMs: AT_MS + 3_600_000,
      });

      expect(result.device.id).toBe('device-1');
      expect(result.device.revokedAt).toBeNull();
      expect(result.device.lastSeenAt.getTime()).toBe(AT_MS + 3_600_000);
    });

    it('R1-06B: persists the HMAC of the /64 prefix for IPv6 addresses', async () => {
      const s = setup();

      const result = await s.service.touchForLogin({
        accountId: 'account-1',
        deviceToken: null,
        userAgent: null,
        ip: '2001:db8:abcd:0012:ffff:ffff:ffff:ffff',
        nowMs: AT_MS,
      });

      expect(result.device.ipHmac).toBe(s.digester.digest('device-ip', '2001:db8:abcd:12::/64'));
    });

    it('R1-06B: normalizes IPv4-mapped IPv6 back to the embedded /24 prefix', async () => {
      const s = setup();

      const result = await s.service.touchForLogin({
        accountId: 'account-1',
        deviceToken: null,
        userAgent: null,
        ip: '::ffff:203.0.113.9',
        nowMs: AT_MS,
      });

      expect(result.device.ipHmac).toBe(s.digester.digest('device-ip', '203.0.113.0/24'));
    });

    it('R1-06B: an unparseable address digests a stable sentinel — nothing derived from it persists', async () => {
      const s = setup();

      const result = await s.service.touchForLogin({
        accountId: 'account-1',
        deviceToken: null,
        userAgent: null,
        ip: 'not-an-ip',
        nowMs: AT_MS,
      });

      expect(result.device.ipHmac).toBe(s.digester.digest('device-ip', 'unknown'));
    });
  });

  describe('summarizeUserAgent', () => {
    it('classifies coarse browser/OS combinations deterministically', () => {
      expect(summarizeUserAgent(CHROME_UA)).toBe('Chrome on Windows');
      expect(
        summarizeUserAgent(
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Safari/605.1.15',
        ),
      ).toBe('Safari on macOS');
      expect(
        summarizeUserAgent(
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile/15E148 Safari/604.1',
        ),
      ).toBe('Safari on iOS');
      expect(
        summarizeUserAgent(
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
        ),
      ).toBe('Chrome on Android');
      expect(
        summarizeUserAgent(
          'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
        ),
      ).toBe('Firefox on Linux');
      expect(
        summarizeUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/126.0.0.0',
        ),
      ).toBe('Edge on Windows');
      expect(summarizeUserAgent(null)).toBe('Unknown browser on Unknown OS');
      expect(summarizeUserAgent('curl/8.5.0')).toBe('Unknown browser on Unknown OS');
    });
  });

  describe('list', () => {
    it('returns only the caller’s un-revoked devices, newest first', async () => {
      const s = setup();
      s.devices.seed(makeDeviceRow({ id: 'd-1', lastSeenAt: new Date(AT_MS) }));
      s.devices.seed(
        makeDeviceRow({ id: 'd-2', deviceDigest: 'digest-2', lastSeenAt: new Date(AT_MS + 100) }),
      );
      s.devices.seed(
        makeDeviceRow({
          id: 'd-3',
          deviceDigest: 'digest-3',
          revokedAt: new Date(AT_MS + 50),
        }),
      );
      s.devices.seed(
        makeDeviceRow({ id: 'd-4', deviceDigest: 'digest-4', accountId: 'account-other' }),
      );

      const rows = await s.service.list('account-1');

      expect(rows.map((row) => row.id)).toEqual(['d-2', 'd-1']);
    });
  });

  describe('rename', () => {
    it('renames one of the caller’s devices', async () => {
      const s = setup();
      s.devices.seed(makeDeviceRow({}));

      const row = await s.service.rename({
        accountId: 'account-1',
        deviceId: 'device-1',
        label: 'Work laptop',
      });

      expect(row.label).toBe('Work laptop');
      expect(s.devices.rows.get('device-1')?.label).toBe('Work laptop');
    });

    it('unknown and cross-account ids answer the same stable 404', async () => {
      const s = setup();
      s.devices.seed(makeDeviceRow({}));
      for (const deviceId of ['device-missing', 'device-1']) {
        const accountId = deviceId === 'device-1' ? 'account-other' : 'account-1';
        try {
          await s.service.rename({ accountId, deviceId, label: 'x' });
          expect.unreachable('must throw');
        } catch (error) {
          expectHttpException(error, 404, 'DEVICE_NOT_FOUND');
        }
      }
    });

    it('a revoked device cannot be renamed', async () => {
      const s = setup();
      s.devices.seed(makeDeviceRow({ revokedAt: new Date(AT_MS) }));

      try {
        await s.service.rename({ accountId: 'account-1', deviceId: 'device-1', label: 'x' });
        expect.unreachable('must throw');
      } catch (error) {
        expectHttpException(error, 404, 'DEVICE_NOT_FOUND');
      }
    });
  });

  describe('revoke', () => {
    it('revokes the device and ALL its active sessions in one transaction', async () => {
      const s = setup();
      s.devices.seed(makeDeviceRow({}));
      s.sessions.seed(makeSessionRow({ id: 's-device', deviceId: 'device-1' }));
      s.sessions.seed(
        makeSessionRow({ id: 's-other', deviceId: 'device-other', tokenDigest: 'd2' }),
      );

      await s.service.revoke({ accountId: 'account-1', deviceId: 'device-1', ipHmac: 'ip-a' });

      expect(s.devices.rows.get('device-1')?.revokedAt).not.toBeNull();
      expect(s.sessions.rows.get('s-device')?.state).toBe('revoked');
      expect(s.sessions.rows.get('s-device')?.revokedReason).toBe('device_revoked');
      expect(s.sessions.rows.get('s-other')?.state).toBe('active');
      expect(s.audit.events.some((e) => e.eventType === 'device.revoked')).toBe(true);
    });

    it('unknown, cross-account and already-revoked ids answer the same stable 404', async () => {
      const s = setup();
      s.devices.seed(makeDeviceRow({ revokedAt: new Date(AT_MS) }));
      s.sessions.seed(makeSessionRow({ id: 's-device', deviceId: 'device-1' }));
      const cases: Array<{ accountId: string; deviceId: string }> = [
        { accountId: 'account-1', deviceId: 'device-missing' },
        { accountId: 'account-other', deviceId: 'device-1' },
        { accountId: 'account-1', deviceId: 'device-1' }, // already revoked
      ];
      for (const input of cases) {
        try {
          await s.service.revoke({
            accountId: input.accountId,
            deviceId: input.deviceId,
            ipHmac: 'ip-a',
          });
          expect.unreachable('must throw');
        } catch (error) {
          expectHttpException(error, 404, 'DEVICE_NOT_FOUND');
        }
      }
      expect(s.sessions.rows.get('s-device')?.state).toBe('active'); // never touched
    });
  });

  describe('toDeviceSummary', () => {
    it('omits revoked_at until the device is revoked', () => {
      const active = toDeviceSummary(makeDeviceRow({}));
      expect(active).toEqual({
        device_id: 'device-1',
        label: 'Chrome on Windows',
        summary: 'Chrome on Windows',
        first_seen_at: new Date(AT_MS).toISOString(),
        last_seen_at: new Date(AT_MS).toISOString(),
      });
      const revoked = toDeviceSummary(makeDeviceRow({ revokedAt: new Date(AT_MS) }));
      expect(revoked.revoked_at).toBe(new Date(AT_MS).toISOString());
      const fallback = toDeviceSummary(makeDeviceRow({ uaSummary: null }));
      expect(fallback.summary).toBe('Chrome on Windows'); // label fallback
    });
  });
});
