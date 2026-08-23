import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { PgGlobalizationRepository } from '@wai/db';
import type { Pool } from 'pg';
import { IAM_POOL } from '../tokens.js';
import { GlobalizationController } from './globalization.controller.js';
import { GlobalizationService } from './globalization.service.js';
import { GLOBALIZATION_REPOSITORY } from './globalization.tokens.js';

@Module({})
export class GlobalizationModule {
  static forRoot(config: AppConfig, accountModule: DynamicModule): DynamicModule {
    const providers: Provider[] = [
      {
        provide: GLOBALIZATION_REPOSITORY,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) => new PgGlobalizationRepository(pool),
      },
      GlobalizationService,
    ];
    return {
      module: GlobalizationModule,
      imports: [accountModule],
      controllers: [GlobalizationController],
      providers,
      exports: [GlobalizationService, GLOBALIZATION_REPOSITORY],
    };
  }
}
