import { randomUUID } from 'node:crypto';
import type { IdentityVerificationProviderPort, NormalizedProviderEvent } from '@wai/contracts';
import {
  normalizeProviderBody,
  signRawBody,
  verifyRawSignature,
} from '../domain/verification-state.js';

export interface MockProviderConfig {
  secret: string;
  previousSecret?: string;
  production?: boolean;
}

/** HMAC compliance harness. This adapter is intentionally never valid in production. */
export class MockIdentityVerificationProvider implements IdentityVerificationProviderPort {
  readonly name = 'mock';
  constructor(private readonly config: MockProviderConfig) {
    if (config.production) throw new Error('mock_identity_provider_forbidden_in_production');
    if (!config.secret || config.secret.length < 32)
      throw new Error('mock_provider_secret_too_short');
  }
  async createSession(input: {
    caseId: string;
    attemptId: string;
    accountReference: string;
    idempotencyKey: string;
  }) {
    return {
      providerSessionReference: `mock_session_${input.attemptId}`,
      clientToken: `mock_client_${randomUUID()}`,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }
  async verifyWebhook(input: {
    headers: Readonly<Record<string, string | undefined>>;
    rawBody: Uint8Array;
  }): Promise<NormalizedProviderEvent> {
    const signature = input.headers['x-verification-signature'];
    const secrets = [this.config.secret, this.config.previousSecret].filter((x): x is string =>
      Boolean(x),
    );
    if (!verifyRawSignature(signature, secrets, input.rawBody))
      throw new Error('provider_signature_invalid');
    return normalizeProviderBody(input.rawBody);
  }
  async requestRedaction(_providerSessionReference: string): Promise<void> {
    return;
  }
  sign(rawBody: Uint8Array): string {
    return signRawBody(this.config.secret, rawBody);
  }
}
