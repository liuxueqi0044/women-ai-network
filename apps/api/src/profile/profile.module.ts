import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { createProfileRepository, parsePiiKeys, type Db } from '@wai/db';
import { ProfileVisibilityPolicy, type CapabilityCode } from '@wai/contracts';
import type { ProfileMatchingSafeViewPort } from '@wai/contracts';
import { IAM_DB } from '../account/repositories.js';
import { PartitionDecisionService } from '../eligibility/services/partition-decision.service.js';
import { AgeCredentialService } from '../eligibility/services/age-credential.service.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import {
  PROFILE_AGE_PARTITION,
  PROFILE_RELATIONSHIP,
  PROFILE_REPOSITORY,
  PROFILE_MATCHING_SAFE_VIEW,
  PROFILE_VISIBILITY_POLICY,
} from './profile.tokens.js';
import { ProfileService } from './profile.service.js';
import { ProfileController, PublicProfileController } from './profile.controller.js';
import { CONNECTION_RELATIONSHIP } from '../connection/connection.tokens.js';

@Module({})
export class ProfileModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    eligibilityModule: DynamicModule,
    verificationModule: DynamicModule,
    connectionModule?: DynamicModule,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: PROFILE_REPOSITORY,
        inject: [IAM_DB],
        useFactory: (db: Db) =>
          createProfileRepository(db, parsePiiKeys(config.iam.piiKeysJson), config.iam.piiKeyId),
      },
      {
        provide: PROFILE_MATCHING_SAFE_VIEW,
        inject: [PROFILE_REPOSITORY],
        useFactory: (repository: ProfileMatchingSafeViewPort) => repository,
      },
      { provide: PROFILE_VISIBILITY_POLICY, useClass: ProfileVisibilityPolicy },
      // Isolated PRF tests use the fail-closed fallback below; the application
      // root supplies CON-01's real PostgreSQL graph adapter.
      {
        provide: PROFILE_AGE_PARTITION,
        inject: [PartitionDecisionService, AgeCredentialService],
        useFactory: (partition: PartitionDecisionService, credentials: AgeCredentialService) => ({
          self: async (account: string) => {
            const credential = await credentials.current(account);
            return credential === null ? null : { ageBand: credential.age_band };
          },
          decide: (actor: string, subject: string, capability: string) =>
            partition.decide(actor, subject, { capability: capability as CapabilityCode }),
        }),
      },
      ProfileService,
      OriginGuard,
      SessionAuthGuard,
    ];
    if (connectionModule !== undefined) {
      providers.push({
        provide: PROFILE_RELATIONSHIP,
        inject: [CONNECTION_RELATIONSHIP],
        useFactory: (graph: {
          relationship(
            viewer: string,
            subject: string,
          ): Promise<{ relationship: 'none' | 'connection' }>;
        }) => ({
          decide: async (viewer: string, subject: string) => {
            const result = await graph.relationship(viewer, subject);
            return {
              relationship: result.relationship === 'connection' ? 'connection' : 'none',
            } as const;
          },
        }),
      });
    } else {
      providers.push({
        provide: PROFILE_RELATIONSHIP,
        useValue: { decide: async () => ({ relationship: 'none' as const }) },
      });
    }
    return {
      module: ProfileModule,
      imports: [
        accountModule,
        eligibilityModule,
        verificationModule,
        ...(connectionModule === undefined ? [] : [connectionModule]),
      ],
      controllers: [ProfileController, PublicProfileController],
      providers,
      exports: [ProfileService, PROFILE_MATCHING_SAFE_VIEW],
    };
  }
}
