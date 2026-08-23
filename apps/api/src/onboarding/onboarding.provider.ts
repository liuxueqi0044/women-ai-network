import {
  forbiddenOnboardingKeys,
  type MinimizedOnboardingPrompt,
  type OnboardingExtraction,
  type OnboardingMode,
  type OnboardingPurpose,
  type OnboardingProvider,
} from '@wai/contracts';

/**
 * Bounded in-process capacity for the provider transaction fence. There is
 * deliberately no waiter queue: when the shared PostgreSQL pool is busy the
 * caller gets a stable 503 instead of holding an unbounded promise or socket.
 */
export class OnboardingDispatchLimiter {
  private active = 0;

  constructor(private readonly capacity = 2) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('onboarding dispatch capacity must be a positive integer');
    }
  }

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.capacity) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  get activeCount(): number {
    return this.active;
  }
}

/** Provider boundary: sensitive identity/age evidence is omitted before any adapter call. */
export function minimizeOnboardingPrompt(input: {
  purpose: OnboardingPurpose;
  modes: readonly OnboardingMode[];
  answers: readonly string[];
}): MinimizedOnboardingPrompt {
  const forbidden = new RegExp(
    `(?:${forbiddenOnboardingKeys.join('|')}|\\b(?:passport|passports|license|licence|national\\s+id|identity\\s+card|verification|verified|selfie|evidence|reviewer|canary|romantic|dating|born|birth|\\bid\\b)\\b|\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b|\\d)`,
    'i',
  );
  return {
    purpose: input.purpose,
    modes: input.modes.filter((mode) => mode !== 'dating'),
    answers: input.answers
      .filter((answer) => !forbidden.test(answer))
      .map((answer) => answer.slice(0, 1000)),
  };
}
export class SanitizingOnboardingProvider implements OnboardingProvider {
  readonly name: string;
  constructor(private readonly inner: OnboardingProvider) {
    this.name = inner.name;
  }
  extract(prompt: MinimizedOnboardingPrompt): Promise<OnboardingExtraction> {
    return this.inner.extract(minimizeOnboardingPrompt(prompt));
  }
}
export class UnavailableOnboardingProvider implements OnboardingProvider {
  readonly name = 'unconfigured';
  async extract(_prompt: MinimizedOnboardingPrompt): Promise<OnboardingExtraction> {
    throw new Error('ONBOARDING_PROVIDER_UNAVAILABLE');
  }
}
