import { randomBytes, randomUUID } from 'node:crypto';
import type { RandomSource } from '../ports.js';

/** Production random source: node:crypto CSPRNG only. */
export class CspRandomSource implements RandomSource {
  bytes(length: number): Buffer {
    return randomBytes(length);
  }

  uuid(): string {
    return randomUUID();
  }
}
