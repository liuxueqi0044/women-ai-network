import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBase64Key, validateStagingEnv } from './staging-lib.mjs';

function valid() {
  const key = randomBase64Key();
  return {
    COMPOSE_PROJECT_NAME: 'wai-staging-test',
    WAI_IMAGE_REPOSITORY: 'wai-local',
    WAI_IMAGE_TAG: 'test',
    STAGING_WEB_PORT: '13000',
    STAGING_API_PORT: '13100',
    POSTGRES_USER: 'wai_app',
    POSTGRES_PASSWORD: 'a'.repeat(32),
    POSTGRES_DB: 'wai_app',
    VALKEY_PASSWORD: 'b'.repeat(32),
    NODE_ENV: 'production',
    LOG_PRETTY: 'false',
    API_BASE_URL: 'http://127.0.0.1:13100',
    NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:13100/v1',
    CORS_ORIGINS: 'http://127.0.0.1:13000',
    ENABLE_OPENAPI: 'false',
    IAM_COOKIE_SECURE: 'true',
    IAM_SECRET_PEPPER: 'c'.repeat(40),
    IAM_PII_KEYS: JSON.stringify({ 'staging-1': key }),
    IAM_PII_KEY_ID: 'staging-1',
    SAFETY_VAULT_KEY: randomBase64Key(),
    STAGING_BACKUP_KEY: randomBase64Key(),
    MEDIA_UPLOADS_ENABLED: 'false',
    MEDIA_STORAGE_ADAPTER: 'real',
    MEDIA_SCANNER_ADAPTER: 'real',
    MEDIA_SANITIZER_ADAPTER: 'real',
    MEDIA_CONTENT_MODERATION_ADAPTER: 'doubao',
  };
}

test('accepts provider-independent production staging', () => {
  assert.equal(validateStagingEnv(valid()).mediaEnabled, false);
});

test('rejects placeholders and unsafe production switches', () => {
  assert.throws(
    () => validateStagingEnv({ ...valid(), POSTGRES_PASSWORD: 'REPLACE_ME' }),
    /placeholder|short/u,
  );
  assert.throws(
    () => validateStagingEnv({ ...valid(), IAM_COOKIE_SECURE: 'false' }),
    /must be true/u,
  );
  assert.throws(
    () => validateStagingEnv({ ...valid(), MEDIA_STORAGE_ADAPTER: 'fake' }),
    /must remain real/u,
  );
});

test('requires complete HTTPS providers before uploads can be enabled', () => {
  assert.throws(
    () => validateStagingEnv({ ...valid(), MEDIA_UPLOADS_ENABLED: 'true' }),
    /MEDIA_S3_ENDPOINT/u,
  );
});
