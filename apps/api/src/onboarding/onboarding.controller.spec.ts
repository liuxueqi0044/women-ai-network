import { describe, expect, it, vi } from 'vitest';
import { OnboardingController } from './onboarding.controller.js';

const session = { accountId: '11111111-1111-4111-8111-111111111111' } as never;

describe('ONB HTTP boundary', () => {
  const service = {
    create: vi.fn(),
    answer: vi.fn(),
    extract: vi.fn(),
    consent: vi.fn(),
    confirm: vi.fn(),
    correct: vi.fn(),
    replacePreferences: vi.fn(),
    withdrawConsent: vi.fn(),
  };
  const controller = new OnboardingController(service as never);

  it('rejects non-UUID session paths before service dispatch', () => {
    expect(() => controller.answer(session, 'not-a-uuid', {})).toThrowError(/id is invalid/);
    expect(service.answer).not.toHaveBeenCalled();
  });

  it('rejects missing or malformed Idempotency-Key consistently', () => {
    expect(() => controller.create(session, {})).toThrowError(/Idempotency-Key/);
    expect(() =>
      controller.answer(session, '11111111-1111-4111-8111-111111111111', {}, undefined),
    ).toThrowError(/Idempotency-Key/);
    expect(() =>
      controller.extract(session, '11111111-1111-4111-8111-111111111111', {}, undefined),
    ).toThrowError(/Idempotency-Key/);
    expect(() => controller.consent(session, {}, undefined)).toThrowError(/Idempotency-Key/);
    expect(() =>
      controller.withdraw(session, 'configured', 'discovery', '1', undefined),
    ).toThrowError(/Idempotency-Key/);
    expect(() => controller.confirm(session, {}, undefined)).toThrowError(/Idempotency-Key/);
    expect(() => controller.correct(session, {}, 'short')).toThrowError(/Idempotency-Key/);
    expect(() => controller.replace(session, {}, 'contains whitespace ')).toThrowError(
      /Idempotency-Key/,
    );
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it('rejects invalid purpose/provider paths and never turns them into an IDOR lookup', () => {
    expect(() =>
      controller.proposal(session, 'other', '11111111-1111-4111-8111-111111111111'),
    ).toThrowError(/purpose/);
    expect(() => controller.withdraw(session, 'other', 'configured', '1')).toThrowError(/purpose/);
    expect(() => controller.withdraw(session, 'Bad.Provider', 'discovery', '1')).toThrowError(
      /provider/,
    );
    expect(service.withdrawConsent).not.toHaveBeenCalled();
  });
});
