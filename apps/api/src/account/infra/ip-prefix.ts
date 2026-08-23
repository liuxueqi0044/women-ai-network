import { IPv6, parse } from 'ipaddr.js';

/**
 * Coarse IP-prefix extraction for device persistence (R1-06B). The task book
 * data-minimization rule says devices store the HMAC of the client's IP
 * PREFIX, not of the full address: IPv4 is reduced to the /24, IPv6 to the
 * /64, and IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalized back to IPv4
 * before truncation. Unparseable input returns null — the caller maps it to
 * a stable sentinel digest so nothing derived from a malformed address is
 * ever persisted.
 *
 * ipaddr.js@2.2.0 (MIT, pure JS, pinned) handles the RFC 4291 normalization;
 * we only slice bytes after parsing. The full client IP is never stored or
 * logged anywhere.
 */
export function ipPrefix(ip: string): string | null {
  let parsed;
  try {
    parsed = parse(ip);
  } catch {
    return null;
  }
  const bytes = parsed.toByteArray();
  if (parsed.kind() === 'ipv4') {
    return `${bytes[0]}.${bytes[1]}.${bytes[2]}.0/24`;
  }
  // kind() is a method, not a discriminant property, so TS cannot narrow the
  // union — instanceof both narrows and gives access to the mapped check.
  if (parsed instanceof IPv6 && parsed.isIPv4MappedAddress()) {
    // The last 4 of the 16 bytes carry the embedded IPv4 address.
    return `${bytes[12]}.${bytes[13]}.${bytes[14]}.0/24`;
  }
  // RFC 5952: leading zeros are dropped, groups stay non-empty.
  const groups = [0, 2, 4, 6].map((offset) =>
    (((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)).toString(16),
  );
  return `${groups.join(':')}::/64`;
}
