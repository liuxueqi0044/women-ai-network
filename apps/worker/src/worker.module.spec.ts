import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@wai/config';
import {
  TRANSLATION_AUTHORIZATION,
  TRANSLATION_PIPELINE,
  TRANSLATION_POOL,
  TRANSLATION_PROVIDERS,
  TRANSLATION_QUEUE,
  TRANSLATION_WORKER_INSTANCE,
} from './tokens.js';
import { WorkerModule } from './worker.module.js';

describe('production translation worker composition', () => {
  it('registers a dedicated queue, repository pipeline, and worker consumer', () => {
    const module = WorkerModule.forRoot(
      {
        isProduction: false,
        nodeEnv: 'test',
        logLevel: 'silent',
        logPretty: false,
        databaseUrl: 'postgres://test.invalid/test',
        otel: { enabled: false, exporter: 'none' },
        valkey: { host: '127.0.0.1', port: 6379, db: 0, tls: false },
        media: { storageAdapter: 'fake', scannerAdapter: 'fake' },
        iam: {
          secretPepper: Buffer.alloc(32, 1).toString('base64'),
          piiKeyId: 'translation-v1',
          piiKeysJson: JSON.stringify({ 'translation-v1': Buffer.alloc(32, 2).toString('base64') }),
        },
      } as unknown as AppConfig,
      {
        tracer: {} as never,
        logger: {} as never,
        resultStore: { close: async () => undefined } as never,
      },
    );
    const providers = module.providers ?? [];
    const registered = new Set(
      providers.flatMap((provider) =>
        typeof provider === 'function'
          ? [provider]
          : 'provide' in provider
            ? [provider.provide]
            : [],
      ),
    );
    expect(registered.has(TRANSLATION_POOL)).toBe(true);
    expect(registered.has(TRANSLATION_AUTHORIZATION)).toBe(true);
    expect(registered.has(TRANSLATION_PROVIDERS)).toBe(true);
    expect(registered.has(TRANSLATION_PIPELINE)).toBe(true);
    expect(registered.has(TRANSLATION_QUEUE)).toBe(true);
    expect(registered.has(TRANSLATION_WORKER_INSTANCE)).toBe(true);
  });
});
