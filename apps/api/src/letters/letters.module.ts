import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { parsePepper, parsePiiKeys, PgLetterRepository } from '@wai/db';
import type { Pool } from 'pg';
import { IAM_POOL } from '../tokens.js';
import { LettersController } from './letters.controller.js';
import { LettersService } from './letters.service.js';
import { LETTER_REPOSITORY } from './letters.tokens.js';

@Module({})
export class LettersModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    eligibilityModule: DynamicModule,
    verificationModule: DynamicModule,
    safetyModule: DynamicModule,
  ): DynamicModule {
    const keys = parsePiiKeys(config.iam.piiKeysJson);
    const key = keys.get(config.iam.piiKeyId);
    if (key === undefined) throw new Error('letters_key_unavailable');
    const providers: Provider[] = [
      {
        provide: LETTER_REPOSITORY,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) =>
          new PgLetterRepository(pool, {
            keyId: config.iam.piiKeyId,
            key,
            keys,
            hmacKey: parsePepper(config.iam.secretPepper),
          }),
      },
      LettersService,
    ];
    return {
      module: LettersModule,
      imports: [accountModule, eligibilityModule, verificationModule, safetyModule],
      controllers: [LettersController],
      providers,
      exports: [LettersService, LETTER_REPOSITORY],
    };
  }
}
