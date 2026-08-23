import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { parsePepper, PgNotificationRepository, PgNotificationResourceGate } from '@wai/db';
import { IAM_POOL } from '../tokens.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { NOTIFICATION_GATE, NOTIFICATION_REPOSITORY } from './notifications.tokens.js';
import type { Pool } from 'pg';

@Module({})
export class NotificationsModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    globalizationModule: DynamicModule,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: NOTIFICATION_REPOSITORY,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) =>
          new PgNotificationRepository(pool, parsePepper(config.iam.secretPepper)),
      },
      {
        provide: NOTIFICATION_GATE,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) => new PgNotificationResourceGate(pool),
      },
      NotificationsService,
    ];
    return {
      module: NotificationsModule,
      imports: [accountModule, globalizationModule],
      controllers: [NotificationsController],
      providers,
      exports: [NotificationsService, NOTIFICATION_REPOSITORY],
    };
  }
}
