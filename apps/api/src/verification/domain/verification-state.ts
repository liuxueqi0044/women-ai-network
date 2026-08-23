import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  normalizedProviderEventSchema,
  transitionIdentity,
  type IdentityState,
  type NormalizedProviderEvent,
} from '@wai/contracts';

export function digestPayload(rawBody: Uint8Array): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function subjectDigest(secret: string, subject: string): string {
  return createHmac('sha256', secret).update(`verification:subject:${subject}`).digest('hex');
}

export function signRawBody(secret: string, rawBody: Uint8Array): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyRawSignature(
  signature: string | undefined,
  secrets: readonly string[],
  rawBody: Uint8Array,
): boolean {
  if (signature === undefined || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const candidate = Buffer.from(signature, 'hex');
  return secrets.some((secret) => {
    const expected = Buffer.from(signRawBody(secret, rawBody), 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

export function normalizeProviderBody(rawBody: Uint8Array): NormalizedProviderEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString('utf8'));
  } catch {
    throw new Error('provider_event_invalid');
  }
  return normalizedProviderEventSchema.parse(parsed);
}

export function applyProviderDecision(
  current: IdentityState,
  event: NormalizedProviderEvent,
): IdentityState {
  const next: IdentityState =
    event.decision === 'verified'
      ? 'verified'
      : event.decision === 'requires_input'
        ? 'requires_input'
        : event.decision === 'failed'
          ? 'failed'
          : event.decision === 'expired'
            ? 'expired'
            : event.decision === 'canceled'
              ? 'canceled'
              : 'processing';
  return transitionIdentity(current, next) ? next : current;
}

export function createOpaqueReference(): string {
  return `wai_ver_${randomUUID().replaceAll('-', '')}`;
}
