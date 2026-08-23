import type { InjectionToken } from '@nestjs/common';
import type { AgeModePolicyDecisionPort, AgePartitionDecisionPort } from '@wai/contracts';
import type { EligibilityRepositories } from '@wai/db';
import type { JurisdictionPolicySelector } from '@wai/contracts';
import type { BirthdayCipher } from './infra/eligibility-secret-cipher.js';
import type { ElgClock } from './infra/elg-clock.js';

/** ELG-01 DI tokens (module-scoped, resolved inside EligibilityModule). */
export const ELG_CLOCK: InjectionToken<ElgClock> = Symbol('ELG_CLOCK');
export const ELG_REPOSITORIES: InjectionToken<EligibilityRepositories> = Symbol('ELG_REPOSITORIES');
export const JURISDICTION_POLICY_SELECTOR: InjectionToken<JurisdictionPolicySelector> = Symbol(
  'JURISDICTION_POLICY_SELECTOR',
);
export const BIRTHDAY_CIPHER: InjectionToken<BirthdayCipher> = Symbol('BIRTHDAY_CIPHER');
/** Replaceable single-subject mode decision engine (the OPA adapter, CP3). */
export const AGE_MODE_POLICY_DECISION_PORT: InjectionToken<AgeModePolicyDecisionPort> = Symbol(
  'AGE_MODE_POLICY_DECISION_PORT',
);
/** Replaceable two-party partition decision engine (the OPA adapter, CP3). */
export const AGE_PARTITION_DECISION_PORT: InjectionToken<AgePartitionDecisionPort> = Symbol(
  'AGE_PARTITION_DECISION_PORT',
);
