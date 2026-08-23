import { HttpException, Inject, Injectable, Optional } from '@nestjs/common';
import {
  canonicalJsonHash,
  OnboardingConcurrencyError,
  OnboardingIdempotencyConflictError,
  OnboardingProposalExpiredError,
} from '@wai/db';
import {
  onboardingAnswerSchema,
  onboardingConfirmSchema,
  onboardingCorrectionSchema,
  onboardingCorrectionResponseSchema,
  onboardingCreateSchema,
  onboardingExtractSchema,
  onboardingExtractionSchema,
  onboardingPreferencesResponseSchema,
  onboardingProposalResponseSchema,
  onboardingReplaceSchema,
  onboardingSessionResponseSchema,
  onboardingStateResponseSchema,
  onboardingConsentResponseSchema,
  providerConsentSchema,
  type OnboardingMode,
  type OnboardingModeGate,
  type OnboardingProvider,
  type OnboardingPurpose,
  type OnboardingRepositoryPort,
} from '@wai/contracts';
import type { AccountRepository } from '@wai/db';
import { ACCOUNT_REPOSITORY } from '../account/repositories.js';
import { RATE_LIMITER, type RateLimiter } from '../account/ports.js';
import {
  ONBOARDING_DISPATCH_LIMITER,
  ONBOARDING_MODE_GATE,
  ONBOARDING_PROVIDER,
  ONBOARDING_REPOSITORY,
} from './onboarding.tokens.js';
import { minimizeOnboardingPrompt, OnboardingDispatchLimiter } from './onboarding.provider.js';

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(ONBOARDING_REPOSITORY) private readonly repo: OnboardingRepositoryPort,
    @Inject(ONBOARDING_PROVIDER) private readonly provider: OnboardingProvider,
    @Inject(ONBOARDING_MODE_GATE) private readonly gate: OnboardingModeGate,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Optional() @Inject(RATE_LIMITER) private readonly rateLimiter?: RateLimiter,
    @Optional()
    @Inject(ONBOARDING_DISPATCH_LIMITER)
    private readonly dispatchLimiter: OnboardingDispatchLimiter = new OnboardingDispatchLimiter(2),
  ) {}

  async create(accountId: string, body: unknown, key: string) {
    const input = onboardingCreateSchema.parse(body);
    await this.enabled(accountId);
    await this.modesAllowed(accountId, input.modes);
    await this.enabled(accountId);
    await this.modesAllowed(accountId, input.modes);
    return onboardingSessionResponseSchema.parse(
      toSession(
        await this.repo.createSession({
          accountId,
          purpose: input.purpose,
          modes: input.modes,
          datingEnabled: input.dating_enabled,
          idempotencyKey: key,
          payloadDigest: canonicalJsonHash(input),
        }),
      ),
    );
  }
  async resume(accountId: string, purpose: OnboardingPurpose) {
    await this.enabled(accountId);
    const row = await this.repo.currentSession(accountId, purpose);
    if (!row) throw notFound('onboarding session');
    await this.modesAllowed(accountId, row.modes);
    await this.enabled(accountId);
    return onboardingSessionResponseSchema.parse(toSession(row));
  }
  async state(accountId: string, purpose: OnboardingPurpose) {
    await this.enabled(accountId);
    const row = await this.repo.currentSession(accountId, purpose);
    if (!row) throw notFound('onboarding session');
    await this.modesAllowed(accountId, row.modes);
    const preferences = await this.repo.currentPreferences(accountId, purpose);
    const proposal = await this.repo.currentPendingProposal(accountId, purpose);
    const consent = await this.repo.currentConsent(accountId, purpose, this.provider.name);
    await this.enabled(accountId);
    return onboardingStateResponseSchema.parse({
      session: toSession(row),
      preferences: preferences ? toPrefs(preferences) : null,
      proposal: proposal ? toProposal(proposal) : null,
      consent: consent
        ? {
            consent_id: consent.consentId,
            purpose: consent.purpose,
            provider: consent.provider,
            receipt_version: consent.receiptVersion,
            retention: consent.retention,
            granted: consent.granted,
            withdrawn_at: consent.withdrawnAt?.toISOString() ?? null,
          }
        : null,
    });
  }
  async answer(accountId: string, sessionId: string, body: unknown, key: string) {
    const input = onboardingAnswerSchema.parse(body);
    await this.enabled(accountId);
    const session = await this.requireSession(accountId, input.purpose);
    assertSession(session.sessionId === sessionId && session.modes.includes(input.mode));
    await this.modesAllowed(accountId, [input.mode]);
    try {
      return onboardingSessionResponseSchema.parse(
        toSession(
          await this.repo.appendAnswer({
            accountId,
            sessionId,
            purpose: input.purpose,
            mode: input.mode,
            expectedRevision: input.revision,
            text: input.text,
            idempotencyKey: key,
            payloadDigest: canonicalJsonHash(input),
          }),
        ),
      );
    } catch (e) {
      throw mapError(e);
    }
  }
  async consent(accountId: string, body: unknown, key: string) {
    const input = providerConsentSchema.parse(body);
    await this.enabled(accountId);
    const session = await this.repo.currentSession(accountId, input.purpose);
    if (session?.modes.every((mode) => mode === 'dating'))
      throw new HttpException(
        { code: 'DATING_PROVIDER_FORBIDDEN', message: 'Dating onboarding is manual only' },
        403,
      );
    if (input.provider !== this.provider.name)
      throw new HttpException(
        { code: 'PROVIDER_MISMATCH', message: 'configured provider mismatch' },
        403,
      );
    const result = await this.repo.saveConsent({
      accountId,
      purpose: input.purpose,
      provider: input.provider,
      receiptVersion: input.receipt_version,
      retention: input.retention,
      granted: input.granted,
      idempotencyKey: key,
      payloadDigest: canonicalJsonHash(input),
    });
    return onboardingConsentResponseSchema.parse({
      consent_id: result.consentId,
      purpose: result.purpose,
      provider: result.provider,
      receipt_version: result.receiptVersion,
      retention: result.retention,
      granted: result.granted,
      withdrawn_at: result.withdrawnAt?.toISOString() ?? null,
    });
  }
  async withdrawConsent(
    accountId: string,
    purpose: OnboardingPurpose,
    provider: string,
    receiptVersion: number,
    key: string,
  ) {
    return this.consent(
      accountId,
      {
        purpose,
        provider,
        receipt_version: receiptVersion,
        retention: 'none',
        granted: false,
      },
      key,
    );
  }
  async extract(accountId: string, sessionId: string, body: unknown, key: string) {
    const input = onboardingExtractSchema.parse(body);
    await this.enabled(accountId);
    const session = await this.requireSession(accountId, input.purpose);
    assertSession(
      session.sessionId === sessionId &&
        session.modes.includes(input.mode) &&
        session.answerRevision === input.expected_answer_revision &&
        session.modesVersion === input.modes_version,
    );
    if (input.mode === 'dating')
      throw new HttpException(
        { code: 'DATING_PROVIDER_FORBIDDEN', message: 'Dating onboarding is manual only' },
        403,
      );
    if (input.provider !== this.provider.name)
      throw new HttpException(
        { code: 'PROVIDER_MISMATCH', message: 'configured provider mismatch' },
        403,
      );
    const consent = await this.repo.currentConsent(accountId, input.purpose, input.provider);
    if (!consent?.granted || consent.consentId !== input.consent_id || consent.receiptVersion <= 0)
      throw new HttpException(
        { code: 'PROVIDER_CONSENT_REQUIRED', message: 'provider consent is required' },
        403,
      );
    if (this.rateLimiter !== undefined) {
      const rate = await this.rateLimiter.consume(`onboarding:extract:${accountId}`, 5, 60);
      if (!rate.allowed)
        throw new HttpException(
          {
            code: 'RATE_LIMITED',
            message: 'too many onboarding extraction requests',
            retry_after_seconds: rate.retryAfterSeconds ?? 1,
          },
          429,
        );
    }
    const answers = await this.repo.answerTexts(accountId, sessionId, input.purpose, input.mode);
    const prompt = minimizeOnboardingPrompt({
      purpose: input.purpose,
      modes: [input.mode],
      answers,
    });
    await this.enabled(accountId);
    await this.modesAllowed(accountId, [input.mode]);
    const release = this.dispatchLimiter.tryAcquire();
    if (release === undefined)
      throw new HttpException(
        { code: 'PROVIDER_CAPACITY_EXCEEDED', message: 'provider capacity is busy; retry later' },
        503,
      );
    try {
      let proposal;
      try {
        proposal = await this.repo.withAuthorizedProviderDispatch(
          {
            accountId,
            purpose: input.purpose,
            provider: input.provider,
            consentId: consent.consentId,
            receiptVersion: consent.receiptVersion,
            idempotencyKey: key,
            payloadDigest: canonicalJsonHash(input),
            sessionId,
            mode: input.mode,
            answerRevision: input.expected_answer_revision,
            modesVersion: input.modes_version,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          },
          async () => {
            const extraction = await withTimeout(this.provider.extract(prompt), 10_000);
            const parsed = onboardingExtractionSchema.parse(extraction);
            return {
              ...parsed,
              preferences: parsed.preferences.map((preference) => ({
                ...preference,
                mode: input.mode,
              })),
            };
          },
        );
      } catch (e) {
        if (e instanceof Error && e.message === 'ONBOARDING_PROVIDER_UNAVAILABLE')
          throw new HttpException(
            { code: 'PROVIDER_UNAVAILABLE', message: 'AI draft is unavailable; continue manually' },
            503,
          );
        if (e instanceof Error && e.message === 'onboarding_provider_consent_required')
          throw new HttpException(
            { code: 'PROVIDER_CONSENT_REQUIRED', message: 'provider consent was withdrawn' },
            403,
          );
        if (e instanceof Error && e.message === 'ONBOARDING_PROVIDER_TIMEOUT')
          throw new HttpException(
            { code: 'PROVIDER_TIMEOUT', message: 'AI draft timed out; continue manually' },
            503,
          );
        if (
          e instanceof OnboardingConcurrencyError ||
          e instanceof OnboardingIdempotencyConflictError
        )
          throw mapError(e);
        if (e instanceof Error && e.message === 'onboarding_account_disabled') throw mapError(e);
        throw e;
      }
      return onboardingProposalResponseSchema.parse(toProposal(proposal));
    } finally {
      release();
    }
  }
  async proposal(accountId: string, purpose: OnboardingPurpose, id: string) {
    await this.enabled(accountId);
    const session = await this.requireSession(accountId, purpose);
    await this.modesAllowed(accountId, session.modes);
    const p = await this.repo.getProposal(accountId, id);
    if (
      !p ||
      p.purpose !== purpose ||
      p.sessionId !== session.sessionId ||
      p.answerRevision !== session.answerRevision ||
      p.modesVersion !== session.modesVersion
    )
      throw notFound('proposal');
    await this.modesAllowed(accountId, [p.mode]);
    await this.enabled(accountId);
    return onboardingProposalResponseSchema.parse(toProposal(p));
  }
  async confirm(accountId: string, body: unknown, key: string) {
    const input = onboardingConfirmSchema.parse(body);
    await this.enabled(accountId);
    await this.modesAllowed(accountId, input.modes);
    const session = await this.requireSession(accountId, input.purpose);
    assertSession(
      session.sessionId === input.session_id &&
        session.answerRevision === input.expected_answer_revision &&
        session.modesVersion === input.modes_version &&
        sameModes(session.modes, input.modes),
    );
    if (session.modes.includes('dating') && input.confirm_dating !== true)
      throw new HttpException(
        { code: 'DATING_CONFIRMATION_REQUIRED', message: 'Dating must be explicitly confirmed' },
        400,
      );
    await this.enabled(accountId);
    await this.modesAllowed(accountId, input.modes);
    try {
      return onboardingPreferencesResponseSchema.parse(
        toPrefs(
          await this.repo.confirm({
            accountId,
            proposalId: input.proposal_id,
            sessionId: input.session_id,
            purpose: input.purpose,
            expectedVersion: input.expected_version,
            expectedAnswerRevision: input.expected_answer_revision,
            modesVersion: input.modes_version,
            preferences: input.preferences,
            modes: input.modes,
            idempotencyKey: key,
            payloadDigest: canonicalJsonHash(input),
          }),
        ),
      );
    } catch (e) {
      throw mapError(e);
    }
  }
  async correct(accountId: string, body: unknown, key: string) {
    const input = onboardingCorrectionSchema.parse(body);
    await this.enabled(accountId);
    const session = await this.requireSession(accountId, input.purpose);
    assertSession(session.sessionId === input.session_id);
    await this.modesAllowed(accountId, session.modes);
    await this.enabled(accountId);
    await this.modesAllowed(accountId, session.modes);
    try {
      const corrected = await this.repo.correct({
        accountId,
        proposalId: input.proposal_id,
        sessionId: input.session_id,
        purpose: input.purpose,
        expectedVersion: input.expected_version,
        expectedProposalVersion: input.expected_proposal_version,
        field: input.field,
        correction: input.correction,
        idempotencyKey: key,
        payloadDigest: canonicalJsonHash(input),
      });
      return onboardingCorrectionResponseSchema.parse({
        corrected: true,
        proposal_id: corrected.proposalId,
        proposal_version: corrected.proposalVersion,
      });
    } catch (e) {
      throw mapError(e);
    }
  }
  async preferences(accountId: string, purpose: OnboardingPurpose) {
    await this.enabled(accountId);
    const p = await this.repo.currentPreferences(accountId, purpose);
    if (!p)
      return {
        account_id: accountId,
        purpose,
        version: 0,
        modes: [],
        modes_version: 1,
        preferences: [],
        confirmed_at: new Date(0).toISOString(),
      };
    await this.modesAllowed(accountId, p.modes);
    await this.enabled(accountId);
    return onboardingPreferencesResponseSchema.parse(toPrefs(p));
  }
  async replacePreferences(accountId: string, body: unknown, key: string) {
    const input = onboardingReplaceSchema.parse(body);
    await this.enabled(accountId);
    await this.modesAllowed(accountId, input.modes);
    const session = await this.requireSession(accountId, input.purpose);
    assertSession(
      session.modesVersion === input.modes_version &&
        sameModes(session.modes, input.modes) &&
        session.modes.includes(input.mode),
    );
    if (session.modes.includes('dating') && input.confirm_dating !== true)
      throw new HttpException(
        { code: 'DATING_CONFIRMATION_REQUIRED', message: 'Dating must be explicitly confirmed' },
        400,
      );
    await this.enabled(accountId);
    await this.modesAllowed(accountId, input.modes);
    try {
      return onboardingPreferencesResponseSchema.parse(
        toPrefs(
          await this.repo.replacePreferences({
            accountId,
            purpose: input.purpose,
            expectedVersion: input.expected_version,
            modesVersion: input.modes_version,
            modes: input.modes,
            mode: input.mode,
            preferences: input.preferences,
            idempotencyKey: key,
            payloadDigest: canonicalJsonHash(input),
          }),
        ),
      );
    } catch (e) {
      throw mapError(e);
    }
  }
  private async enabled(id: string) {
    const account = await this.accounts.findById(id);
    if (!account || account.state !== 'enabled')
      throw new HttpException(
        { code: 'ACCOUNT_STATE_DENIED', message: 'account unavailable' },
        403,
      );
  }
  private async requireSession(accountId: string, purpose: OnboardingPurpose) {
    const session = await this.repo.currentSession(accountId, purpose);
    if (!session) throw notFound('onboarding session');
    return session;
  }
  private async modesAllowed(accountId: string, modes: readonly OnboardingMode[]) {
    for (const mode of modes) if (!(await this.gate.decide(accountId, mode))) throw policyDenied();
  }
}
function sameModes(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function assertSession(ok: boolean) {
  if (!ok)
    throw new HttpException(
      { code: 'ONBOARDING_CONTEXT_CONFLICT', message: 'onboarding context is stale' },
      409,
    );
}
function notFound(value: string) {
  return new HttpException({ code: 'NOT_FOUND', message: `${value} not found` }, 404);
}
function policyDenied() {
  return new HttpException(
    { code: 'POLICY_DENIED', message: 'onboarding mode is unavailable' },
    403,
  );
}
function toSession(row: {
  sessionId: string;
  purpose: OnboardingPurpose;
  modes: readonly OnboardingMode[];
  modesVersion: number;
  datingEnabled: boolean;
  state: string;
  version: number;
  answerRevision: number;
}) {
  return {
    session_id: row.sessionId,
    purpose: row.purpose,
    modes: row.modes,
    modes_version: row.modesVersion,
    dating_enabled: row.datingEnabled,
    state: row.state,
    version: row.version,
    answer_revision: row.answerRevision,
  };
}
function toProposal(row: {
  proposalId: string;
  sessionId: string;
  purpose: OnboardingPurpose;
  mode: OnboardingMode;
  answerRevision: number;
  modesVersion: number;
  state: string;
  expiresAt: Date;
  proposalVersion: number;
  confidence: number;
  provenance: string;
  preferences: readonly unknown[];
}) {
  return {
    proposal_id: row.proposalId,
    session_id: row.sessionId,
    purpose: row.purpose,
    mode: row.mode,
    answer_revision: row.answerRevision,
    modes_version: row.modesVersion,
    proposal_version: row.proposalVersion,
    state: row.state,
    expires_at: row.expiresAt.toISOString(),
    confidence: row.confidence,
    provenance: row.provenance,
    preferences: row.preferences,
    ai_draft: true as const,
  };
}
function toPrefs(row: {
  accountId: string;
  purpose: OnboardingPurpose;
  version: number;
  modes: readonly OnboardingMode[];
  modesVersion: number;
  preferences: readonly unknown[];
  confirmedAt: Date;
}) {
  return {
    account_id: row.accountId,
    purpose: row.purpose,
    version: row.version,
    modes: row.modes,
    modes_version: row.modesVersion,
    preferences: row.preferences,
    confirmed_at: row.confirmedAt.toISOString(),
  };
}
function mapError(e: unknown): HttpException {
  if (e instanceof OnboardingConcurrencyError)
    return new HttpException(
      { code: 'OPTIMISTIC_CONCURRENCY_CONFLICT', message: 'onboarding version conflict' },
      409,
    );
  if (e instanceof OnboardingIdempotencyConflictError)
    return new HttpException(
      { code: 'IDEMPOTENCY_CONFLICT', message: 'idempotency payload conflict' },
      409,
    );
  if (e instanceof OnboardingProposalExpiredError)
    return new HttpException(
      { code: 'PROPOSAL_EXPIRED', message: 'proposal expired; review manually' },
      409,
    );
  if (e instanceof Error && e.message === 'onboarding_account_disabled')
    return new HttpException({ code: 'ACCOUNT_STATE_DENIED', message: 'account unavailable' }, 403);
  return e instanceof HttpException
    ? e
    : new HttpException({ code: 'ONBOARDING_ERROR', message: 'onboarding mutation failed' }, 400);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ONBOARDING_PROVIDER_TIMEOUT')), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
