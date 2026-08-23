import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { hmacDigest, parsePiiKeys, PgSafetyRepository } from '@wai/db';
import type { Pool } from 'pg';
import { IAM_POOL } from '../tokens.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import { EVIDENCE_PROVIDER, SAFETY_REPOSITORY } from './tokens.js';
import { SafetyController } from './safety.controller.js';
import { SafetyService } from './safety.service.js';
import { SAFETY_BLOCK_DECISION, type EvidenceSnapshotPort } from '@wai/contracts';

/** The source adapter is intentionally unavailable until each product surface
 * implements a trusted, authorization-aware EvidenceSnapshotPort. */
const unavailableEvidence: EvidenceSnapshotPort = {
  async capture() {
    return null;
  },
};

@Module({})
export class SafetyModule {
  static forRoot(config: AppConfig, accountModule: DynamicModule): DynamicModule {
    const providers: Provider[] = [
      { provide: EVIDENCE_PROVIDER, useValue: unavailableEvidence },
      {
        provide: SAFETY_REPOSITORY,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) => {
          const keys = [...parsePiiKeys(config.iam.piiKeysJson).values()];
          const source = keys[0];
          if (!source) throw new Error('safety_key_unavailable');
          const derived = Buffer.from(hmacDigest(source, 'safety-vault', 'v1'), 'hex');
          return new PgSafetyRepository(pool, { vaultKey: { keyId: 'safety-v1', key: derived } });
        },
      },
      { provide: SAFETY_BLOCK_DECISION, useExisting: SAFETY_REPOSITORY },
      SafetyService,
      OriginGuard,
      SessionAuthGuard,
    ];
    return {
      module: SafetyModule,
      imports: [accountModule],
      controllers: [SafetyController],
      providers,
      exports: [SAFETY_REPOSITORY, SAFETY_BLOCK_DECISION, EVIDENCE_PROVIDER, SafetyService],
    };
  }
}
