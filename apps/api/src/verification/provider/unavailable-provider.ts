import type { IdentityVerificationProviderPort } from '@wai/contracts';

/** Production fail-closed adapter until a reviewed real provider is configured. */
export class UnavailableVerificationProvider implements IdentityVerificationProviderPort {
  readonly name = 'unavailable';
  async createSession(): Promise<never> {
    throw new Error('verification_provider_not_configured');
  }
  async verifyWebhook(): Promise<never> {
    throw new Error('verification_provider_not_configured');
  }
  async requestRedaction(): Promise<never> {
    throw new Error('verification_provider_not_configured');
  }
}
