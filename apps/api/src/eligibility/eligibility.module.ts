import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import type { Db } from '@wai/db';
import { createEligibilityRepositories, type EligibilityRepositories } from '@wai/db';
import type { JurisdictionPolicySelector } from '@wai/contracts';
import { OpaModeDecisionAdapter, OpaPartitionDecisionAdapter } from '@wai/authz';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { IAM_DB } from '../account/repositories.js';
import { EligibilityController } from './controllers/eligibility.controller.js';
import {
  AGE_MODE_POLICY_DECISION_PORT,
  AGE_PARTITION_DECISION_PORT,
  BIRTHDAY_CIPHER,
  ELG_CLOCK,
  ELG_REPOSITORIES,
  JURISDICTION_POLICY_SELECTOR,
} from './eligibility.tokens.js';
import { createBirthdayCipher } from './infra/eligibility-secret-cipher.js';
import { SystemElgClock } from './infra/elg-clock.js';
import type { OpaConfig } from './infra/opa-config.js';
import { PgJurisdictionPolicySelector } from './infra/pg-jurisdiction-policy-selector.js';
import { AgeCredentialService } from './services/age-credential.service.js';
import { JurisdictionService } from './services/jurisdiction.service.js';
import { ModeEvaluationService } from './services/mode-evaluation.service.js';
import { PartitionDecisionService } from './services/partition-decision.service.js';

/**
 * ELG-01 slice: session-bound jurisdiction + age-declaration API over the
 * `eligibility` schema repositories, with the DB-backed policy selector and
 * the shared IAM PII keyring for birthday encryption.
 *
 * `accountModule` must be the SAME DynamicModule reference the root module
 * imports — a second forRoot() call would re-register the account
 * controllers (Fastify duplicate route). The guards' private dependencies
 * (TOKEN_DIGESTER, session/account/audit repositories, IAM_DB, CLOCK) are
 * exported by AccountModule (documented ELG-01 deviation: exports are a
 * pure additive change, no IAM-01 semantics touched).
 */
@Module({})
export class EligibilityModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    opaConfig: OpaConfig,
  ): DynamicModule {
    const providers: Provider[] = [
      { provide: ELG_CLOCK, useClass: SystemElgClock },
      {
        provide: BIRTHDAY_CIPHER,
        useValue: createBirthdayCipher(config.iam.piiKeysJson, config.iam.piiKeyId),
      },
      {
        provide: ELG_REPOSITORIES,
        inject: [IAM_DB],
        useFactory: (db: Db): EligibilityRepositories => createEligibilityRepositories(db),
      },
      {
        provide: JURISDICTION_POLICY_SELECTOR,
        inject: [ELG_REPOSITORIES],
        useFactory: (repos: EligibilityRepositories): JurisdictionPolicySelector =>
          new PgJurisdictionPolicySelector(
            repos.jurisdictionDeclarations,
            repos.jurisdictionPolicies,
          ),
      },
      {
        provide: AGE_MODE_POLICY_DECISION_PORT,
        useFactory: (): OpaModeDecisionAdapter =>
          new OpaModeDecisionAdapter(opaConfig.baseUrl, opaConfig.queryTimeoutMs),
      },
      {
        provide: AGE_PARTITION_DECISION_PORT,
        useFactory: (): OpaPartitionDecisionAdapter =>
          new OpaPartitionDecisionAdapter(opaConfig.baseUrl, opaConfig.queryTimeoutMs),
      },
      JurisdictionService,
      AgeCredentialService,
      ModeEvaluationService,
      PartitionDecisionService,
      // Guards used on the eligibility routes resolve in this module's context.
      OriginGuard,
      SessionAuthGuard,
    ];

    return {
      module: EligibilityModule,
      imports: [accountModule],
      controllers: [EligibilityController],
      providers,
      // Internal partition decisions are consumed by future Matching/Chat/
      // Events modules — exported, never exposed as a public HTTP route.
      exports: [PartitionDecisionService, AgeCredentialService, ModeEvaluationService],
    };
  }
}
