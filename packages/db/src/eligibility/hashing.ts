import { createHash } from 'node:crypto';

/**
 * Deterministic content hashing for eligibility policy documents and
 * decision inputs. The same logical JSON always produces the same hex
 * digest regardless of key order or whitespace — required so that
 * content_hash / rule_hash / input_hash / credential_hash survive any
 * JSON round-trip and match across the API, OPA adapter and DB.
 */

/** Recursively sort object keys so equal logical JSON hashes identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** sha256 of the canonical JSON rendering of `value`. */
export function canonicalJsonHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
