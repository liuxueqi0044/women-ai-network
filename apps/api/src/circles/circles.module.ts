import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { parsePepper, parsePiiKeys, PgCircleRepository } from '@wai/db';
import type { Pool } from 'pg';
import { IAM_POOL } from '../tokens.js';
import { SAFETY_BLOCK_DECISION } from '@wai/contracts';
import type { CircleGrowthGatePort, SafetyBlockDecisionPort } from '@wai/contracts';
import { CIRCLE_GATE, CIRCLE_REPOSITORY } from './circles.tokens.js';
import { CircleGrowthGateService } from './circles-gate.service.js';
import { CirclesService } from './circles.service.js';
import { CirclesController } from './circles.controller.js';
@Module({})
export class CirclesModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    eligibilityModule: DynamicModule,
    verificationModule: DynamicModule,
    safetyModule: DynamicModule,
    notificationsModule: DynamicModule,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: CIRCLE_REPOSITORY,
        inject: [IAM_POOL, CIRCLE_GATE],
        useFactory: (pool: Pool, gate: CircleGrowthGatePort) =>
          new PgCircleRepository(
            pool,
            parsePiiKeys(config.iam.piiKeysJson),
            config.iam.piiKeyId,
            gate,
            parsePepper(config.iam.secretPepper),
          ),
      },
      {
        provide: CIRCLE_GATE,
        inject: [IAM_POOL, SAFETY_BLOCK_DECISION],
        useFactory: (pool: Pool, safety: SafetyBlockDecisionPort) =>
          new CircleGrowthGateService(pool, safety),
      },
      CirclesService,
    ];
    return {
      module: CirclesModule,
      imports: [
        accountModule,
        eligibilityModule,
        verificationModule,
        safetyModule,
        notificationsModule,
      ],
      controllers: [CirclesController],
      providers,
      exports: [CirclesService, CIRCLE_REPOSITORY, CIRCLE_GATE],
    };
  }
}
