import { describe, expect, it } from 'vitest';
import { ipPrefix } from './ip-prefix.js';

/**
 * R1-06B: device persistence uses the HMAC of the client IP PREFIX (/24 for
 * IPv4, /64 for IPv6), never of the full address. These pure-function tests
 * pin the truncation semantics; the digest layer is covered elsewhere.
 */
describe('ipPrefix', () => {
  it('reduces IPv4 to the /24 prefix', () => {
    expect(ipPrefix('203.0.113.7')).toBe('203.0.113.0/24');
    expect(ipPrefix('203.0.113.255')).toBe('203.0.113.0/24');
  });

  it('separates distinct /24 blocks', () => {
    expect(ipPrefix('203.0.113.7')).not.toBe(ipPrefix('203.0.114.7'));
  });

  it('reduces IPv6 to the first /64', () => {
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd:12::/64');
    expect(ipPrefix('2001:db8:abcd:12:ffff::1')).toBe('2001:db8:abcd:12::/64');
    expect(ipPrefix('2001:db8:abcd:13::1')).not.toBe('2001:db8:abcd:12::/64');
  });

  it('normalizes IPv4-mapped IPv6 to the embedded /24', () => {
    expect(ipPrefix('::ffff:203.0.113.7')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:cb00:7107')).toBe('203.0.113.0/24');
  });

  it('answers null for unparseable input', () => {
    expect(ipPrefix('not-an-ip')).toBeNull();
    expect(ipPrefix('')).toBeNull();
    expect(ipPrefix('999.1.1.1')).toBeNull();
  });
});
