import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { parsePepper, PgConnectionRepository, type Db } from '@wai/db';
import type { Pool } from 'pg';
import { IAM_POOL } from '../tokens.js';
import { IAM_DB } from '../account/repositories.js';
import { PartitionDecisionService } from '../eligibility/services/partition-decision.service.js';
import { COMMUNITY_ACCESS_DECISION_PORT } from '../verification/verification.tokens.js';
import {
  CONNECTION_GATE,
  CONNECTION_RELATIONSHIP,
  CONNECTION_REPOSITORY,
  PRIVATE_DELIVERY_CONNECTION,
  CONNECTION_MATERIALIZATION,
} from './connection.tokens.js';
import { ConnectionController } from './connection.controller.js';
import { ConnectionService } from './connection.service.js';
import { InteractionGateService } from './interaction-gate.service.js';
import { PgMutualMaterialization } from './mutual-materialization.js';
import {
  SAFETY_BLOCK_DECISION,
  type CommunityAccessDecisionPort,
  type SafetyBlockDecisionPort,
  type InteractionGatePort,
} from '@wai/contracts';

@Module({})
export class ConnectionModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    eligibilityModule: DynamicModule,
    verificationModule: DynamicModule,
    safetyModule: DynamicModule,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: CONNECTION_REPOSITORY,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) =>
          new PgConnectionRepository(pool, parsePepper(config.iam.secretPepper)),
      },
      { provide: CONNECTION_RELATIONSHIP, useExisting: CONNECTION_REPOSITORY },
      { provide: PRIVATE_DELIVERY_CONNECTION, useExisting: CONNECTION_REPOSITORY },
      {
        provide: CONNECTION_GATE,
        inject: [
          COMMUNITY_ACCESS_DECISION_PORT,
          PartitionDecisionService,
          SAFETY_BLOCK_DECISION,
          CONNECTION_RELATIONSHIP,
        ],
        useFactory: (
          community: CommunityAccessDecisionPort,
          partition: PartitionDecisionService,
          safety: SafetyBlockDecisionPort,
          graph: Pick<PgConnectionRepository, 'relationship' | 'getForActor'>,
        ) => new InteractionGateService(community, partition, safety, graph),
      },
      ConnectionService,
      InteractionGateService,
      {
        provide: CONNECTION_MATERIALIZATION,
        inject: [IAM_DB, CONNECTION_GATE],
        useFactory: (db: Db, gate: InteractionGatePort) =>
          new PgMutualMaterialization(db, gate, parsePepper(config.iam.secretPepper)),
      },
    ];
    return {
      module: ConnectionModule,
      imports: [accountModule, eligibilityModule, verificationModule, safetyModule],
      controllers: [ConnectionController],
      providers,
      exports: [
        CONNECTION_RELATIONSHIP,
        PRIVATE_DELIVERY_CONNECTION,
        CONNECTION_GATE,
        ConnectionService,
        InteractionGateService,
        CONNECTION_MATERIALIZATION,
      ],
    };
  }
}
