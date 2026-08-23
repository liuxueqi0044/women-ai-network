import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import {
  transitionIdentity,
  type IdentityState,
  type IdentityVerificationProviderPort,
  type NormalizedProviderEvent,
  type VerificationAgeCredentialIssuer,
} from '@wai/contracts';
import { hmacDigest, parsePiiKeys, PgVerificationRepository } from '@wai/db';
import type { Pool } from 'pg';
import { AgeCredentialService } from '../eligibility/services/age-credential.service.js';
import { APP_CONFIG, IAM_POOL } from '../tokens.js';
import { digestPayload } from './domain/verification-state.js';
import { VERIFICATION_PROVIDER } from './verification.tokens.js';

@Injectable()
export class VerificationWebhookService {
  private readonly repo: PgVerificationRepository;
  private readonly digestKey: Buffer;

  constructor(
    @Inject(VERIFICATION_PROVIDER) private readonly provider: IdentityVerificationProviderPort,
    @Inject(IAM_POOL) pool: Pool,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(AgeCredentialService)
    private readonly ageIssuer: VerificationAgeCredentialIssuer,
  ) {
    this.repo = new PgVerificationRepository(pool);
    const key = parsePiiKeys(config.iam.piiKeysJson).get(config.iam.piiKeyId);
    if (key === undefined) throw new Error('verification key is not configured');
    this.digestKey = key;
  }

  async handle(
    providerName: string,
    headers: Readonly<Record<string, string | undefined>>,
    rawBody: Uint8Array,
  ): Promise<{ accepted: boolean; replay: boolean }> {
    if (providerName !== this.provider.name)
      throw new Error('verification_provider_not_configured');
    const event = await this.provider.verifyWebhook({ headers, rawBody });
    const now = new Date();
    const occurredAt = new Date(event.occurred_at);
    if (occurredAt.getTime() > now.getTime() + 5 * 60_000)
      throw new Error('provider_event_from_future');
    const claim = await this.repo.claimProviderEvent(
      providerName,
      event.provider_event_id,
      digestPayload(rawBody),
      occurredAt,
      now,
    );
    if (claim.outcome === 'conflict') throw new Error('provider_event_conflict');
    if (claim.outcome === 'retry_later') throw new Error('provider_event_retry_not_ready');
    if (claim.outcome === 'processed' || claim.outcome === 'in_progress') {
      return { accepted: true, replay: true };
    }
    if (!('processingToken' in claim)) throw new Error('provider_event_claim_invalid');

    try {
      const result = await this.apply(providerName, event);
      const completed = await this.repo.completeProviderEvent(
        providerName,
        event.provider_event_id,
        claim.processingToken,
        result,
      );
      if (!completed) throw new Error('provider_event_lease_lost');
      return { accepted: true, replay: false };
    } catch (error) {
      await this.repo.failProviderEvent(
        providerName,
        event.provider_event_id,
        claim.processingToken,
        safeProcessingError(error),
      );
      throw error;
    }
  }

  private async apply(
    providerName: string,
    event: NormalizedProviderEvent,
  ): Promise<'processed' | 'ignored'> {
    const sessionDigest = hmacDigest(
      this.digestKey,
      'verification:session_reference',
      event.provider_session_reference,
    );
    const linked = await this.repo.findCaseBySessionDigest(providerName, sessionDigest);
    if (linked === null) throw new Error('provider_session_unlinked');

    return this.repo.withCaseLock(linked.caseId, async () => {
      const current = await this.repo.identityCase(linked.caseId);
      if (current === null) throw new Error('verification_case_not_found');
      const occurredAt = new Date(event.occurred_at);
      if (!eventIsNewer(occurredAt, event.provider_event_id, current)) return 'ignored';

      if (event.provider_subject_reference !== undefined) {
        const binding = await this.repo.bindSubject(
          providerName,
          hmacDigest(this.digestKey, 'verification:subject', event.provider_subject_reference),
          linked.accountId,
        );
        if (binding === 'collision') {
          if (!transitionIdentity(current.state as IdentityState, 'needs_review')) return 'ignored';
          const updated = await this.repo.updateIdentity(
            linked.caseId,
            'needs_review',
            'needs_review',
            occurredAt,
            event.provider_event_id,
          );
          return updated ? 'processed' : 'ignored';
        }
      }

      const desired = providerDecisionState(event);
      if (!transitionIdentity(current.state as IdentityState, desired)) return 'ignored';

      let ageState = event.decision === 'verified' ? 'insufficient' : 'pending';
      if (
        event.decision === 'verified' &&
        event.verified_birth_date !== undefined &&
        event.assurance_expires_at !== undefined
      ) {
        const eventKey = `${providerName}\0${event.provider_event_id}`;
        await this.ageIssuer.issueExternalAttestation({
          accountId: linked.accountId,
          evidenceId: deterministicUuid(
            hmacDigest(this.digestKey, 'verification:evidence_id', eventKey),
          ),
          verificationCaseId: linked.caseId,
          attestationDigest: hmacDigest(this.digestKey, 'verification:attestation', eventKey),
          birthDate: event.verified_birth_date,
          assuranceExpiresAt: event.assurance_expires_at,
        });
        ageState = 'attested';
      }

      const updated = await this.repo.updateIdentity(
        linked.caseId,
        desired,
        ageState,
        occurredAt,
        event.provider_event_id,
      );
      return updated ? 'processed' : 'ignored';
    });
  }
}

function providerDecisionState(event: NormalizedProviderEvent): IdentityState {
  switch (event.decision) {
    case 'verified':
      return 'verified';
    case 'requires_input':
      return 'requires_input';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'canceled':
      return 'canceled';
    case 'pending':
      return 'processing';
  }
}

function eventIsNewer(
  occurredAt: Date,
  eventId: string,
  current: {
    lastProviderOccurredAt: Date | null;
    lastProviderEventId: string | null;
  },
): boolean {
  if (current.lastProviderOccurredAt === null) return true;
  const difference = occurredAt.getTime() - current.lastProviderOccurredAt.getTime();
  if (difference !== 0) return difference > 0;
  return eventId > (current.lastProviderEventId ?? '');
}

function deterministicUuid(hexDigest: string): string {
  const bytes = Buffer.from(hexDigest, 'hex').subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function safeProcessingError(error: unknown): string {
  const allowed = new Set([
    'provider_session_unlinked',
    'verification_case_not_found',
    'provider_event_lease_lost',
  ]);
  return error instanceof Error && allowed.has(error.message)
    ? error.message
    : 'provider_event_processing_failed';
}
