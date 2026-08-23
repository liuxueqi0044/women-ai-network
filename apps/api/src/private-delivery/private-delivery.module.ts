import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@wai/config';
import { parsePepper, parsePiiKeys, PgPrivateDeliveryRepository } from '@wai/db';
import type { Pool } from 'pg';
import { IAM_POOL, PRIVATE_DELIVERY_QUEUE_ADAPTER } from '../tokens.js';
import type { QueueProducerAdapter } from '../infra/adapters.js';
import { JOB_NAMES, type PrivateDeliveryWakeupPort } from '@wai/contracts';
import { PRIVATE_DELIVERY_REPOSITORY, PRIVATE_DELIVERY_WAKEUP } from './private-delivery.tokens.js';
import { PrivateDeliveryController } from './private-delivery.controller.js';
import { PrivateDeliveryService } from './private-delivery.service.js';

class PrivateDeliveryWakeup implements PrivateDeliveryWakeupPort {
  constructor(private readonly queue: QueueProducerAdapter) {}
  enqueue(deliveryId: string): Promise<void> {
    return this.queue.enqueue(
      JOB_NAMES.privateDeliveryWakeup,
      { delivery_id: deliveryId },
      // Wakeups are hints, not the durable identity. A fresh generation lets
      // an API replay recover a queued PG delivery after an exhausted/retained
      // BullMQ job without requiring queue-admin deletion.
      {
        jobId: `pvl:${deliveryId}:${randomUUID()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
      },
    );
  }
}

@Module({})
export class PrivateDeliveryModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    connectionModule: DynamicModule,
    lettersModule: DynamicModule,
  ): DynamicModule {
    const keys = parsePiiKeys(config.iam.piiKeysJson);
    const key = keys.get(config.iam.piiKeyId);
    if (!key) throw new Error('private_delivery_key_unavailable');
    const providers: Provider[] = [
      {
        provide: PRIVATE_DELIVERY_REPOSITORY,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) =>
          new PgPrivateDeliveryRepository(pool, {
            keyId: config.iam.piiKeyId,
            key,
            keys,
            hmacKey: parsePepper(config.iam.secretPepper),
          }),
      },
      {
        provide: PRIVATE_DELIVERY_WAKEUP,
        inject: [PRIVATE_DELIVERY_QUEUE_ADAPTER],
        useFactory: (queue: QueueProducerAdapter) => new PrivateDeliveryWakeup(queue),
      },
      PrivateDeliveryService,
    ];
    return {
      module: PrivateDeliveryModule,
      imports: [accountModule, connectionModule, lettersModule],
      controllers: [PrivateDeliveryController],
      providers,
      exports: [PrivateDeliveryService],
    };
  }
}
