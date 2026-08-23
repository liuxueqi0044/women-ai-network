import { createHash } from 'node:crypto';
import type { MediaType } from '@wai/contracts';

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_PIXELS = 40_000_000;

/** Byte-level allowlist. Header MIME and extensions are intentionally absent. */
export function detectStaticImageType(input: Uint8Array): MediaType {
  if (input.byteLength < 12 || input.byteLength > MAX_MEDIA_BYTES) {
    throw new Error(input.byteLength > MAX_MEDIA_BYTES ? 'SIZE_LIMIT' : 'UNSUPPORTED_TYPE');
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (jpeg) {
    // A JPEG ends at EOI; accepting bytes after EOI creates a polyglot surface.
    const end = bytes.lastIndexOf(0xd9);
    if (end < 2 || end !== bytes.length - 1 || bytes[end - 1] !== 0xff) throw new Error('POLYGLOT');
    return 'image/jpeg';
  }
  const png =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  if (png) {
    const tail = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
    if (
      bytes.length < 12 ||
      tail.some((value, index) => bytes[bytes.length - 12 + index] !== value)
    )
      throw new Error('POLYGLOT');
    return 'image/png';
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    const declared =
      8 + new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (declared !== bytes.byteLength) throw new Error('POLYGLOT');
    return 'image/webp';
  }
  throw new Error('UNSUPPORTED_TYPE');
}

export function sha256Hex(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
