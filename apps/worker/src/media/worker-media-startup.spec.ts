import { describe, expect, it } from 'vitest';
import { loadEnv } from '@wai/config';
import { WorkerModule } from '../worker.module.js';

describe('MED-01 worker adapter refusal', () => {
  const productionBase = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://real.example/app',
    VALKEY_URL: 'redis://real.example',
    IAM_COOKIE_SECURE: 'true',
    IAM_SECRET_PEPPER: 'x'.repeat(40),
    IAM_PII_KEYS: '{"prod-key":"dUnDePcXXLNeIe+ZDKq3MveXGJ611HjLHRIDvYlNcHM="}',
    IAM_PII_KEY_ID: 'prod-key',
    MEDIA_STORAGE_ADAPTER: 'real',
    MEDIA_SCANNER_ADAPTER: 'real',
    MEDIA_SANITIZER_ADAPTER: 'real',
    MEDIA_CONTENT_MODERATION_ADAPTER: 'doubao',
  } satisfies NodeJS.ProcessEnv;

  const productionProviders = {
    MEDIA_S3_ENDPOINT: 'https://s3.example.com',
    MEDIA_S3_REGION: 'cn-test-1',
    MEDIA_S3_QUARANTINE_BUCKET: 'wai-private-quarantine',
    MEDIA_S3_CLEAN_BUCKET: 'wai-private-clean',
    MEDIA_S3_QUARANTINE_ACCESS_KEY: 'quarantine-access',
    MEDIA_S3_QUARANTINE_SECRET_KEY: 'quarantine-secret',
    MEDIA_S3_CLEAN_ACCESS_KEY: 'clean-access',
    MEDIA_S3_CLEAN_SECRET_KEY: 'clean-secret',
    CLAMAV_HOST: 'clamav.internal',
    CLAMAV_PORT: '3310',
    ARK_API_KEY: 'ark-test-key-not-real',
    ARK_VISION_MODEL: 'ep-vision-test',
  } satisfies NodeJS.ProcessEnv;

  it('fails closed before boot when production providers are incomplete', () => {
    const config = loadEnv({
      ...productionBase,
    });
    expect(() => WorkerModule.forRoot(config)).toThrow(
      'production_media_provider_configuration_incomplete',
    );
  });

  it('boots production with fail-closed media when uploads are explicitly disabled', () => {
    const config = loadEnv({
      ...productionBase,
      MEDIA_UPLOADS_ENABLED: 'false',
    });
    expect(() => WorkerModule.forRoot(config)).not.toThrow();
  });

  it('composes the production media worker when reviewed providers are complete', () => {
    const config = loadEnv({ ...productionBase, ...productionProviders });
    expect(() => WorkerModule.forRoot(config)).not.toThrow();
  });

  it('rejects plaintext object storage in production', () => {
    const config = loadEnv({
      ...productionBase,
      ...productionProviders,
      MEDIA_S3_ENDPOINT: 'http://s3.example.com',
    });
    expect(() => WorkerModule.forRoot(config)).toThrow('production_media_provider_tls_required');
  });
});
