import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { PgMediaRepository } from '@wai/db';
import { IAM_POOL, MEDIA_QUEUE_ADAPTER } from '../tokens.js';
import { MediaController } from './media.controller.js';
import { MediaAccessTokenService, MediaService } from './media.service.js';
import {
  MEDIA_ACCESS,
  MEDIA_AUTHORIZATION,
  MEDIA_REPOSITORY,
  MEDIA_STORAGE,
} from './media.tokens.js';
import {
  MemoryMediaStorage,
  OwnerMediaAuthorization,
  UnavailableMediaStorage,
} from './media.adapters.js';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import type { ObjectStoragePort, MediaAuthorizationPort } from '@wai/contracts';
import type { QueueProducerAdapter } from '../infra/adapters.js';
import { createS3CompatibleClient, S3MediaStorage } from '@wai/media-infra';

@Module({})
export class MediaModule {
  static forRoot(
    config: AppConfig,
    accountModule?: DynamicModule,
    options: { allowUnavailableStorage?: boolean } = {},
  ): DynamicModule {
    const allowIncomplete = options.allowUnavailableStorage === true;
    if (
      config.isProduction &&
      config.media.enabled &&
      !allowIncomplete &&
      (config.media.storageAdapter !== 'real' ||
        config.media.scannerAdapter !== 'real' ||
        config.media.sanitizerAdapter !== 'real' ||
        config.media.contentModerationAdapter !== 'doubao')
    )
      throw new Error('production_media_fake_adapter_refused');
    if (
      config.isProduction &&
      config.media.enabled &&
      !allowIncomplete &&
      config.media.storageAdapter === 'real' &&
      (config.media.storage === undefined || config.media.contentModeration === undefined)
    )
      throw new Error('production_media_provider_configuration_incomplete');
    if (
      config.isProduction &&
      config.media.enabled &&
      !allowIncomplete &&
      (config.media.storage?.useSsl !== true ||
        !config.media.contentModeration?.apiBaseUrl.startsWith('https://'))
    )
      throw new Error('production_media_provider_tls_required');

    const storageConfig = config.media.enabled ? config.media.storage : undefined;
    const realStorage =
      storageConfig === undefined
        ? new UnavailableMediaStorage()
        : new S3MediaStorage(
            {
              quarantine: createS3CompatibleClient({
                endPoint: storageConfig.endpointHost,
                port: storageConfig.endpointPort,
                useSSL: storageConfig.useSsl,
                ...(storageConfig.region === undefined ? {} : { region: storageConfig.region }),
                accessKey: storageConfig.quarantineAccessKey,
                secretKey: storageConfig.quarantineSecretKey,
              }),
              clean: createS3CompatibleClient({
                endPoint: storageConfig.endpointHost,
                port: storageConfig.endpointPort,
                useSSL: storageConfig.useSsl,
                ...(storageConfig.region === undefined ? {} : { region: storageConfig.region }),
                accessKey: storageConfig.cleanAccessKey,
                secretKey: storageConfig.cleanSecretKey,
              }),
            },
            {
              quarantineBucket: storageConfig.quarantineBucket,
              cleanBucket: storageConfig.cleanBucket,
            },
          );
    const secret = new TextEncoder().encode(config.iam.secretPepper);
    const providers: Provider[] = [
      {
        provide: MEDIA_REPOSITORY,
        useFactory: (pool: Pool) => new PgMediaRepository(pool),
        inject: [IAM_POOL],
      },
      {
        provide: MEDIA_STORAGE,
        useValue:
          config.media.enabled && config.media.storageAdapter === 'fake'
            ? new MemoryMediaStorage()
            : realStorage,
      },
      { provide: MEDIA_AUTHORIZATION, useClass: OwnerMediaAuthorization },
      { provide: MEDIA_ACCESS, useValue: new MediaAccessTokenService(secret) },
      {
        provide: MediaService,
        useFactory: (
          repository: PgMediaRepository,
          storage: ObjectStoragePort,
          authorization: MediaAuthorizationPort,
          access: MediaAccessTokenService,
          queue: QueueProducerAdapter,
        ) =>
          new MediaService(
            repository,
            storage,
            authorization,
            access,
            (assetId) =>
              `quarantine/${createHmac('sha256', secret).update(`quarantine:${assetId}`).digest('hex')}`,
            (value) => createHmac('sha256', secret).update(value).digest('hex'),
            (assetId) =>
              `clean/${createHmac('sha256', secret).update(`rendition:clean:${assetId}`).digest('hex')}`,
            queue,
            config.media.enabled,
          ),
        inject: [
          MEDIA_REPOSITORY,
          MEDIA_STORAGE,
          MEDIA_AUTHORIZATION,
          MEDIA_ACCESS,
          MEDIA_QUEUE_ADAPTER,
        ],
      },
    ];
    return {
      module: MediaModule,
      imports: accountModule === undefined ? [] : [accountModule],
      controllers: [MediaController],
      providers,
      exports: [MediaService],
    };
  }
}
