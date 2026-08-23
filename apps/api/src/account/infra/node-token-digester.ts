import { hmacDigest } from '@wai/db';
import type { DigestContext, TokenDigester } from '../ports.js';

/** HMAC-SHA-256 keyed digests via the shared @wai/db primitives. */
export class NodeTokenDigester implements TokenDigester {
  constructor(private readonly pepper: Buffer) {}

  digest(context: DigestContext, value: string): string {
    return hmacDigest(this.pepper, context, value);
  }
}
