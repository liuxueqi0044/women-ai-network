import { describe, expect, it, vi } from 'vitest';
import type {
  OnboardingModeGate,
  OnboardingProvider,
  OnboardingRepositoryPort,
} from '@wai/contracts';
import type { RateLimiter } from '../account/ports.js';
import { OnboardingService } from './onboarding.service.js';
import { OnboardingDispatchLimiter } from './onboarding.provider.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const consentId = '33333333-3333-4333-8333-333333333333';
const session = {
  sessionId,
  accountId,
  purpose: 'discovery' as const,
  modes: ['friends'] as const,
  modesVersion: 1,
  datingEnabled: false,
  state: 'active' as const,
  version: 0,
  answerRevision: 0,
};
const granted = {
  consentId,
  accountId,
  purpose: 'discovery' as const,
  provider: 'configured',
  receiptVersion: 1,
  retention: 'session' as const,
  granted: true,
  withdrawnAt: null,
};

function setup(
  overrides: Partial<OnboardingRepositoryPort> = {},
  rateLimiter: RateLimiter = { consume: vi.fn().mockResolvedValue({ allowed: true }) },
  dispatchLimiter = new OnboardingDispatchLimiter(2),
) {
  const repo = {
    currentSession: vi.fn().mockResolvedValue(session),
    answerTexts: vi.fn().mockResolvedValue(['quiet book clubs']),
    currentConsent: vi.fn().mockResolvedValue(granted),
    saveConsent: vi.fn(),
    withAuthorizedProviderDispatch: vi.fn().mockImplementation(async (_input, dispatch) => ({
      proposalId: '44444444-4444-4444-8444-444444444444',
      sessionId,
      accountId,
      purpose: 'discovery' as const,
      mode: 'friends' as const,
      answerRevision: 0,
      modesVersion: 1,
      state: 'pending' as const,
      expiresAt: new Date('2030-01-02T03:04:05.000Z'),
      confidence: (await dispatch()).confidence,
      provenance: 'provider_model',
      preferences: [],
      proposalVersion: 1,
    })),
    ...overrides,
  } as unknown as OnboardingRepositoryPort;
  const provider: OnboardingProvider = {
    name: 'configured',
    extract: vi.fn().mockResolvedValue({
      confidence: 0.8,
      provenance: 'provider_model',
      preferences: [],
    }),
  };
  const gate: OnboardingModeGate = { decide: vi.fn().mockResolvedValue(true) };
  const accounts = { findById: vi.fn().mockResolvedValue({ state: 'enabled' }) };
  return {
    service: new OnboardingService(
      repo,
      provider,
      gate,
      accounts as never,
      rateLimiter,
      dispatchLimiter,
    ),
    repo,
    provider,
    gate,
    accounts,
  };
}

describe('ONB-01 final policy/provider fences', () => {
  it('does not dispatch when consent is withdrawn by the last pre-dispatch fence', async () => {
    const { service, repo, provider } = setup({
      currentConsent: vi.fn().mockResolvedValueOnce(granted),
      withAuthorizedProviderDispatch: vi
        .fn()
        .mockRejectedValue(new Error('onboarding_provider_consent_required')),
    });
    await expect(
      service.extract(
        accountId,
        sessionId,
        {
          purpose: 'discovery',
          mode: 'friends',
          session_id: sessionId,
          provider: 'configured',
          consent_id: consentId,
          expected_answer_revision: 0,
          modes_version: 1,
        },
        'onb-service-extract-0001',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.extract).not.toHaveBeenCalled();
    expect(repo.currentConsent).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when IAM is disabled before the last fence', async () => {
    const { service, accounts, provider } = setup();
    accounts.findById
      .mockResolvedValueOnce({ state: 'enabled' })
      .mockResolvedValueOnce({ state: 'suspended' });
    await expect(
      service.extract(
        accountId,
        sessionId,
        {
          purpose: 'discovery',
          mode: 'friends',
          session_id: sessionId,
          provider: 'configured',
          consent_id: consentId,
          expected_answer_revision: 0,
          modes_version: 1,
        },
        'onb-service-extract-0002',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.extract).not.toHaveBeenCalled();
  });

  it('requires the configured provider and keeps a manual path independent', async () => {
    const { service, repo } = setup();
    await expect(
      service.consent(
        accountId,
        {
          purpose: 'discovery',
          provider: 'other-provider',
          receipt_version: 1,
          retention: 'session',
          granted: true,
        },
        'onb-consent-mismatch-0001',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.saveConsent).not.toHaveBeenCalled();
  });

  it('requires Dating selection and confirmation independently at the final write', async () => {
    const datingSession = { ...session, modes: ['dating'] as const, datingEnabled: true };
    const confirm = vi.fn().mockResolvedValue({
      accountId,
      purpose: 'discovery' as const,
      version: 1,
      modes: ['dating'] as const,
      modesVersion: 1,
      preferences: [],
      confirmedAt: new Date(),
    });
    const { service, repo } = setup({
      currentSession: vi.fn().mockResolvedValue(datingSession),
      confirm,
    });
    await expect(
      service.confirm(
        accountId,
        {
          purpose: 'discovery',
          session_id: sessionId,
          proposal_id: '44444444-4444-4444-8444-444444444444',
          expected_version: 0,
          expected_answer_revision: 0,
          modes_version: 1,
          modes: ['dating'],
          preferences: [],
        },
        'onb-dating-confirmation-0001',
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(repo.confirm).not.toHaveBeenCalled();
    await service.confirm(
      accountId,
      {
        purpose: 'discovery',
        session_id: sessionId,
        proposal_id: '44444444-4444-4444-8444-444444444444',
        expected_version: 0,
        expected_answer_revision: 0,
        modes_version: 1,
        modes: ['dating'],
        preferences: [],
        confirm_dating: true,
      },
      'onb-dating-confirmation-0002',
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it('hard rejects provider extraction for Dating so Dating stays manual-only', async () => {
    const datingSession = { ...session, modes: ['dating'] as const, datingEnabled: true };
    const { service, provider } = setup({
      currentSession: vi.fn().mockResolvedValue(datingSession),
    });
    await expect(
      service.extract(
        accountId,
        sessionId,
        {
          purpose: 'discovery',
          mode: 'dating',
          session_id: sessionId,
          provider: 'configured',
          consent_id: consentId,
          expected_answer_revision: 0,
          modes_version: 1,
        },
        'onb-service-extract-0003',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(provider.extract).not.toHaveBeenCalled();
  });
  it('server-binds every provider preference to the requested proposal mode', async () => {
    let dispatched: unknown;
    const { service, provider } = setup({
      withAuthorizedProviderDispatch: vi.fn().mockImplementation(async (_input, dispatch) => {
        dispatched = await dispatch();
        return {
          proposalId: '44444444-4444-4444-8444-444444444444',
          sessionId,
          accountId,
          purpose: 'discovery' as const,
          mode: 'friends' as const,
          answerRevision: 0,
          modesVersion: 1,
          state: 'pending' as const,
          expiresAt: new Date('2030-01-02T03:04:05.000Z'),
          confidence: 0.5,
          provenance: 'provider_model',
          preferences: (dispatched as { preferences: unknown[] }).preferences,
          proposalVersion: 1,
        };
      }),
    });
    provider.extract = vi.fn().mockResolvedValue({
      confidence: 0.5,
      provenance: 'provider_model',
      preferences: [
        {
          mode: 'activities',
          criterion: 'values',
          strength: 'strong_preference',
          value: 'shared projects',
          deal_breaker: false,
        },
      ],
    });
    await service.extract(
      accountId,
      sessionId,
      {
        purpose: 'discovery',
        mode: 'friends',
        session_id: sessionId,
        provider: 'configured',
        consent_id: consentId,
        expected_answer_revision: 0,
        modes_version: 1,
      },
      'onb-service-extract-mode-0001',
    );
    expect((dispatched as { preferences: Array<{ mode: string }> }).preferences[0]?.mode).toBe(
      'friends',
    );
  });

  it('rate-limits extraction and fails fast when the bounded provider capacity is full', async () => {
    const rateLimiter = { consume: vi.fn().mockResolvedValue({ allowed: true }) };
    const dispatchLimiter = new OnboardingDispatchLimiter(2);
    const { service, provider } = setup({}, rateLimiter, dispatchLimiter);
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.extract = vi.fn().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await barrier;
      active -= 1;
      return { confidence: 0.5, provenance: 'provider_model', preferences: [] };
    });
    const input = {
      purpose: 'discovery' as const,
      mode: 'friends' as const,
      session_id: sessionId,
      provider: 'configured',
      consent_id: consentId,
      expected_answer_revision: 0,
      modes_version: 1,
    };
    const pending = Promise.allSettled([
      service.extract(accountId, sessionId, input, 'onb-capacity-a-0001'),
      service.extract(accountId, sessionId, input, 'onb-capacity-b-0001'),
      service.extract(accountId, sessionId, input, 'onb-capacity-c-0001'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peak).toBe(2);
    expect(provider.extract).toHaveBeenCalledTimes(2);
    release();
    const results = await pending;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const busy = results.find(
      (result) => result.status === 'rejected' && result.reason?.status === 503,
    );
    expect(busy).toBeDefined();
  });

  it('returns a stable 429 when the existing extraction rate limiter denies', async () => {
    const rateLimiter = {
      consume: vi.fn().mockResolvedValue({ allowed: false, retryAfterSeconds: 7 }),
    };
    const { service, provider } = setup({}, rateLimiter);
    await expect(
      service.extract(
        accountId,
        sessionId,
        {
          purpose: 'discovery',
          mode: 'friends',
          session_id: sessionId,
          provider: 'configured',
          consent_id: consentId,
          expected_answer_revision: 0,
          modes_version: 1,
        },
        'onb-rate-limit-0001',
      ),
    ).rejects.toMatchObject({ status: 429, response: { code: 'RATE_LIMITED' } });
    expect(provider.extract).not.toHaveBeenCalled();
  });
});
