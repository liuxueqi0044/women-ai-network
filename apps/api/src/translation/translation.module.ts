import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { parsePepper, parsePiiKeys, PgTranslationRepository } from '@wai/db';
import type { TranslationProvider, TranslationSourcePort } from '@wai/contracts';
import type { Pool } from 'pg';
import { IAM_POOL, APP_CONFIG } from '../tokens.js';
import { LettersService } from '../letters/letters.service.js';
import { TranslationController } from './translation.controller.js';
import { TranslationService } from './translation.service.js';
import {
  TRANSLATION_PROVIDERS,
  TRANSLATION_REPOSITORY,
  TRANSLATION_SOURCE,
} from './translation.tokens.js';

@Module({})
export class TranslationModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    lettersModule: DynamicModule,
  ): DynamicModule {
    const keys = parsePiiKeys(config.iam.piiKeysJson);
    const key = keys.get(config.iam.piiKeyId);
    if (key === undefined) throw new Error('translation_key_unavailable');
    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      {
        provide: TRANSLATION_REPOSITORY,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) =>
          new PgTranslationRepository(pool, {
            keyId: config.iam.piiKeyId,
            key,
            keys,
            hmacKey: parsePepper(config.iam.secretPepper),
          }),
      },
      {
        provide: TRANSLATION_SOURCE,
        useFactory: (service: LettersService): TranslationSourcePort => ({
          readPublicSource: (viewerId, letterId) => service.readPublishedSource(viewerId, letterId),
          readPrivateSource: (ownerId, letterId, revision) =>
            service.readPrivateSource(ownerId, letterId, revision),
        }),
        inject: [LettersService],
      },
      { provide: TRANSLATION_PROVIDERS, useValue: new Map<string, TranslationProvider>() },
      TranslationService,
    ];
    return {
      module: TranslationModule,
      imports: [accountModule, lettersModule],
      controllers: [TranslationController],
      providers,
      exports: [TranslationService],
    };
  }
}
