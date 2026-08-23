import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { parsePepper, PgWorldDiscoveryRepository } from '@wai/db';
import type { Pool } from 'pg';
import { IAM_POOL } from '../tokens.js';
import { WorldDiscoveryController } from './world-discovery.controller.js';
import { WorldDiscoveryService } from './world-discovery.service.js';
import { WORLD_DISCOVERY_REPOSITORY } from './world-discovery.tokens.js';
import { WORLD_DISCOVERY_GATE } from './world-discovery-gate.token.js';
import { WorldDiscoveryGateService } from './world-discovery-gate.service.js';

@Module({})
export class WorldDiscoveryModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    eligibilityModule: DynamicModule,
    verificationModule: DynamicModule,
    safetyModule: DynamicModule,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: WORLD_DISCOVERY_REPOSITORY,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) =>
          new PgWorldDiscoveryRepository(pool, parsePepper(config.iam.secretPepper)),
      },
      { provide: WORLD_DISCOVERY_GATE, useClass: WorldDiscoveryGateService },
      WorldDiscoveryService,
    ];
    return {
      module: WorldDiscoveryModule,
      imports: [accountModule, eligibilityModule, verificationModule, safetyModule],
      controllers: [WorldDiscoveryController],
      providers,
      exports: [WorldDiscoveryService, WORLD_DISCOVERY_REPOSITORY, WORLD_DISCOVERY_GATE],
    };
  }
}
