import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import type { AppConfig } from '@wai/config';
import { parsePepper, parsePiiKeys, PgMessagingRepository } from '@wai/db';
import type { Pool } from 'pg';
import { IAM_POOL } from '../tokens.js';
import {
  MESSAGING_REPOSITORY,
  MESSAGING_AI_PROVIDER,
  MESSAGING_WAKEUP,
} from './messaging.tokens.js';
import {
  MessagingController,
  MessageController,
  AiDraftController,
} from './messaging.controller.js';
import { MessagingService, type AiSuggestionProvider } from './messaging.service.js';
import { JOB_NAMES, messagingWakeupJobSchema } from '@wai/contracts';
import { PRIVATE_DELIVERY_QUEUE_ADAPTER } from '../tokens.js';
import type { QueueProducerAdapter } from '../infra/adapters.js';
import { randomUUID } from 'node:crypto';

const unavailableAi: AiSuggestionProvider = {
  async suggest() {
    throw new Error('AI_PROVIDER_UNAVAILABLE');
  },
};
@Module({})
export class MessagingModule {
  static forRoot(
    config: AppConfig,
    accountModule: DynamicModule,
    connectionModule: DynamicModule,
    privateDeliveryModule: DynamicModule,
    safetyModule: DynamicModule,
  ): DynamicModule {
    const keys = parsePiiKeys(config.iam.piiKeysJson);
    const key = keys.get(config.iam.piiKeyId);
    if (!key) throw new Error('messaging_key_unavailable');
    const providers: Provider[] = [
      {
        provide: MESSAGING_REPOSITORY,
        inject: [IAM_POOL],
        useFactory: (pool: Pool) =>
          new PgMessagingRepository(pool, {
            keyId: config.iam.piiKeyId,
            key,
            keys,
            hmacKey: parsePepper(config.iam.secretPepper),
          }),
      },
      { provide: MESSAGING_AI_PROVIDER, useValue: unavailableAi },
      {
        provide: MESSAGING_WAKEUP,
        inject: [PRIVATE_DELIVERY_QUEUE_ADAPTER],
        useFactory: (queue: QueueProducerAdapter) => ({
          enqueue: (conversationId: string, messageId: string) => {
            const data = messagingWakeupJobSchema.parse({
              conversation_id: conversationId,
              message_id: messageId,
            });
            return queue.enqueue(JOB_NAMES.messagingWakeup, data, {
              jobId: `msg:${messageId}:${randomUUID()}`,
              attempts: 5,
              backoff: { type: 'exponential', delay: 1000 },
            });
          },
        }),
      },
      MessagingService,
    ];
    return {
      module: MessagingModule,
      imports: [accountModule, connectionModule, privateDeliveryModule, safetyModule],
      controllers: [MessagingController, MessageController, AiDraftController],
      providers,
      exports: [MessagingService, MESSAGING_REPOSITORY],
    };
  }
}
