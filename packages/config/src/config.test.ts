import { describe, expect, it } from 'vitest';
import { DEV_DEFAULTS, loadEnv, webApiBaseUrl } from './index.js';

const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  LOG_PRETTY: 'false',
  API_HOST: '127.0.0.1',
  API_PORT: '3100',
  API_BASE_URL: 'http://127.0.0.1:3100',
  CORS_ORIGINS: 'http://localhost:3000',
  ENABLE_OPENAPI: 'false',
  DATABASE_URL: DEV_DEFAULTS.databaseUrl,
  VALKEY_URL: DEV_DEFAULTS.valkeyUrl,
  OTEL_ENABLED: 'false',
  OTEL_EXPORTER: 'console',
  FOUNDATION_TRACE_RESULT_TTL_SECONDS: '86400',
};

describe('loadEnv — development defaults', () => {
  it('loads safe development defaults', () => {
    const config = loadEnv(BASE);
    expect(config.nodeEnv).toBe('development');
    expect(config.isProduction).toBe(false);
    expect(config.apiPort).toBe(3100);
    expect(config.corsOrigins).toEqual(['http://localhost:3000']);
    // OpenAPI enabled by default outside production.
    expect(config.openapiEnabled).toBe(true);
    expect(config.otel.enabled).toBe(false);
    expect(config.media.enabled).toBe(true);
  });

  it('loads IAM development defaults (session/cookie/rate-limit)', () => {
    const config = loadEnv(BASE);
    expect(config.iam.sessionIdleSeconds).toBe(604_800);
    expect(config.iam.sessionAbsoluteSeconds).toBe(2_592_000);
    // Dev cookies are non-Secure so http://localhost works; production guards reject this.
    expect(config.iam.cookieSecure).toBe(false);
    expect(config.iam.secretPepper).toBe(DEV_DEFAULTS.iamSecretPepper);
    expect(config.iam.piiKeyId).toBe('dev-key');
    expect(JSON.parse(config.iam.piiKeysJson)).toHaveProperty('dev-key');
    expect(config.iam.rateLimit).toEqual({
      ipWindowSeconds: 900,
      ipRegistrationsMax: 30,
      ipSessionsMax: 60,
      ipMfaMax: 30,
      emailWindowSeconds: 900,
      loginEmailMax: 10,
      registrationEmailMax: 3,
    });
  });

  it('parses complete S3, ClamAV and Doubao visual-review configuration without exposing secrets', () => {
    const config = loadEnv({
      ...BASE,
      MEDIA_CONTENT_MODERATION_ADAPTER: 'doubao',
      MEDIA_S3_ENDPOINT: 'https://s3.example.com:9443',
      MEDIA_S3_REGION: 'cn-test-1',
      MEDIA_S3_QUARANTINE_BUCKET: 'wai-private-quarantine',
      MEDIA_S3_CLEAN_BUCKET: 'wai-private-clean',
      MEDIA_S3_QUARANTINE_ACCESS_KEY: 'quarantine-access',
      MEDIA_S3_QUARANTINE_SECRET_KEY: 'quarantine-secret',
      MEDIA_S3_CLEAN_ACCESS_KEY: 'clean-access',
      MEDIA_S3_CLEAN_SECRET_KEY: 'clean-secret',
      CLAMAV_HOST: 'clamav.internal',
      CLAMAV_PORT: '3311',
      ARK_API_KEY: 'ark-test-key-not-real',
      ARK_VISION_MODEL: 'ep-vision-test',
      ARK_VISION_TIMEOUT_MS: '9000',
    });
    expect(config.media.storage).toMatchObject({
      endpointHost: 's3.example.com',
      endpointPort: 9443,
      useSsl: true,
      quarantineBucket: 'wai-private-quarantine',
      cleanBucket: 'wai-private-clean',
    });
    expect(config.media.scanner).toEqual({ host: 'clamav.internal', port: 3311 });
    expect(config.media.contentModeration).toMatchObject({
      model: 'ep-vision-test',
      timeoutMs: 9000,
    });
  });

  it('parses the media upload kill switch as a strict boolean', () => {
    expect(loadEnv({ ...BASE, MEDIA_UPLOADS_ENABLED: 'false' }).media.enabled).toBe(false);
    expect(() => loadEnv({ ...BASE, MEDIA_UPLOADS_ENABLED: 'off' })).toThrow();
  });

  it('does not compose or validate dormant provider secrets when media is disabled', () => {
    const config = loadEnv({
      ...BASE,
      MEDIA_UPLOADS_ENABLED: 'false',
      ARK_API_KEY: 'stale-but-never-composed-key',
      MEDIA_S3_ENDPOINT: 'https://partial.example.test',
    });
    expect(config.media.enabled).toBe(false);
    expect(config.media.storage).toBeUndefined();
    expect(config.media.contentModeration).toBeUndefined();
  });

  it('rejects partial provider configuration instead of silently degrading', () => {
    expect(() => loadEnv({ ...BASE, MEDIA_S3_ENDPOINT: 'https://s3.example.com' })).toThrow(
      /incomplete/,
    );
    expect(() => loadEnv({ ...BASE, ARK_API_KEY: 'ark-test-key-not-real' })).toThrow(
      /both ARK_API_KEY and ARK_VISION_MODEL/,
    );
  });

  it('parses IAM session timeouts and rate limits from env', () => {
    const config = loadEnv({
      ...BASE,
      IAM_SESSION_IDLE_SECONDS: '900',
      IAM_SESSION_ABSOLUTE_SECONDS: '86400',
      IAM_RATE_LIMIT_LOGIN_EMAIL_MAX: '3',
      IAM_RATE_LIMIT_IP_SESSIONS_MAX: '12',
      IAM_RATE_LIMIT_IP_WINDOW_SECONDS: '300',
    });
    expect(config.iam.sessionIdleSeconds).toBe(900);
    expect(config.iam.sessionAbsoluteSeconds).toBe(86_400);
    expect(config.iam.rateLimit.loginEmailMax).toBe(3);
    expect(config.iam.rateLimit.ipSessionsMax).toBe(12);
    expect(config.iam.rateLimit.ipWindowSeconds).toBe(300);
  });

  it('rejects non-positive IAM session timeouts', () => {
    expect(() => loadEnv({ ...BASE, IAM_SESSION_IDLE_SECONDS: '0' })).toThrow();
    expect(() => loadEnv({ ...BASE, IAM_SESSION_ABSOLUTE_SECONDS: '-1' })).toThrow();
  });

  it('rejects an idle timeout longer than the absolute timeout (R1-02)', () => {
    expect(() =>
      loadEnv({
        ...BASE,
        IAM_SESSION_IDLE_SECONDS: '86401',
        IAM_SESSION_ABSOLUTE_SECONDS: '86400',
      }),
    ).toThrow(/idle/i);
    // Equal timeouts are legal — the idle window then always caps at absolute.
    expect(() =>
      loadEnv({
        ...BASE,
        IAM_SESSION_IDLE_SECONDS: '86400',
        IAM_SESSION_ABSOLUTE_SECONDS: '86400',
      }),
    ).not.toThrow();
  });

  it('parses IAM_COOKIE_SECURE as a strict boolean', () => {
    expect(loadEnv({ ...BASE, IAM_COOKIE_SECURE: 'true' }).iam.cookieSecure).toBe(true);
    expect(() => loadEnv({ ...BASE, IAM_COOKIE_SECURE: 'yes' })).toThrow();
  });

  it('parses the Valkey URL into ioredis/BullMQ connection parts', () => {
    const config = loadEnv(BASE);
    expect(config.valkey).toEqual({
      host: '127.0.0.1',
      port: 6380,
      password: 'wai_dev_valkey_9q2x',
      db: 0,
      tls: false,
    });
  });

  it('handles a Valkey URL with database index and no password', () => {
    const config = loadEnv({ ...BASE, VALKEY_URL: 'redis://127.0.0.1:6379/3' });
    expect(config.valkey.db).toBe(3);
    expect(config.valkey.password).toBeUndefined();
  });

  it('rejects non-numeric and out-of-range ports', () => {
    expect(() => loadEnv({ ...BASE, API_PORT: 'not-a-port' })).toThrow();
    expect(() => loadEnv({ ...BASE, API_PORT: '70000' })).toThrow();
  });

  it('rejects ambiguous boolean strings instead of silently coercing', () => {
    expect(() => loadEnv({ ...BASE, LOG_PRETTY: '1' })).toThrow();
    expect(() => loadEnv({ ...BASE, OTEL_ENABLED: 'yes' })).toThrow();
  });

  it('rejects an invalid Valkey URL scheme', () => {
    expect(() => loadEnv({ ...BASE, VALKEY_URL: 'http://127.0.0.1:6380' })).toThrow();
  });

  it('never echoes the Valkey password in configuration errors', () => {
    const secret = 's3cr3t-p4ss';
    const attempt = () =>
      loadEnv({ ...BASE, VALKEY_URL: `redis://:${secret}@127.0.0.1:6380//bad` });
    expect(attempt).toThrow(/invalid database index/);
    // The thrown message must not contain the password (or the raw userinfo).
    try {
      attempt();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(secret);
      expect(String((error as Error).message)).toContain('***@');
    }
  });
});

describe('loadEnv — production guards', () => {
  const PROD_PEPPER = 'prod-iam-pepper-9f2K1q8m7gH4s2pLxY3wV5nBzC0aD4eF';
  const PROD_PII_KEYS = '{"prod-key":"eG5wV2sQ7mF3tK9pL1nC8rD4bJ6yH0aZ"}';
  const PROD: NodeJS.ProcessEnv = {
    ...BASE,
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://app:9f2K1q8m@db.internal:5432/app',
    VALKEY_URL: 'rediss://:7gH4s2pL@valkey.internal:6380/0',
    CORS_ORIGINS: 'https://app.example.com',
    IAM_COOKIE_SECURE: 'true',
    IAM_SECRET_PEPPER: PROD_PEPPER,
    IAM_PII_KEYS: PROD_PII_KEYS,
  };

  it('loads a valid production configuration', () => {
    const config = loadEnv(PROD);
    expect(config.isProduction).toBe(true);
    expect(config.openapiEnabled).toBe(false);
    expect(config.valkey.tls).toBe(true);
    expect(config.valkey.password).toBe('7gH4s2pL');
    expect(config.iam.cookieSecure).toBe(true);
    expect(config.iam.secretPepper).toBe(PROD_PEPPER);
    expect(config.iam.piiKeysJson).toBe(PROD_PII_KEYS);
  });

  it('allows production to disable uploads without composing fake providers', () => {
    const config = loadEnv({
      ...PROD,
      MEDIA_UPLOADS_ENABLED: 'false',
      MEDIA_STORAGE_ADAPTER: 'real',
      MEDIA_SCANNER_ADAPTER: 'real',
      MEDIA_SANITIZER_ADAPTER: 'real',
    });
    expect(config.media.enabled).toBe(false);
  });

  it('rejects non-Secure IAM cookies in production', () => {
    expect(() => loadEnv({ ...PROD, IAM_COOKIE_SECURE: 'false' })).toThrow(/Secure/);
    expect(() => loadEnv({ ...PROD, IAM_COOKIE_SECURE: undefined })).toThrow(/Secure/);
  });

  it('rejects the development IAM secret pepper in production', () => {
    expect(() => loadEnv({ ...PROD, IAM_SECRET_PEPPER: DEV_DEFAULTS.iamSecretPepper })).toThrow(
      /development/,
    );
  });

  it('rejects the development IAM PII keys in production', () => {
    expect(() => loadEnv({ ...PROD, IAM_PII_KEYS: DEV_DEFAULTS.iamPiiKeysJson })).toThrow(
      /development/,
    );
  });

  it('accepts the dev IAM secret material outside production', () => {
    expect(loadEnv({ ...BASE, IAM_COOKIE_SECURE: 'true' }).iam.cookieSecure).toBe(true);
  });

  it('enables OpenAPI in production only with the explicit switch', () => {
    expect(loadEnv({ ...PROD, ENABLE_OPENAPI: 'true' }).openapiEnabled).toBe(true);
  });

  it('rejects development default credentials in production', () => {
    expect(() => loadEnv({ ...PROD, DATABASE_URL: DEV_DEFAULTS.databaseUrl })).toThrow(
      /development/,
    );
    expect(() => loadEnv({ ...PROD, VALKEY_URL: DEV_DEFAULTS.valkeyUrl })).toThrow(/development/);
  });

  it('rejects the CORS wildcard in production', () => {
    expect(() => loadEnv({ ...PROD, CORS_ORIGINS: '*' })).toThrow(/wildcard|must not/);
  });

  it('accepts the CORS wildcard in development only', () => {
    expect(loadEnv({ ...BASE, CORS_ORIGINS: '*' }).corsOrigins).toEqual(['*']);
  });

  it('rejects malformed CORS origin entries', () => {
    expect(() => loadEnv({ ...BASE, CORS_ORIGINS: 'http://localhost:3000/some/path' })).toThrow();
    expect(() => loadEnv({ ...BASE, CORS_ORIGINS: 'not a url' })).toThrow();
  });

  it('rejects pretty logging in production', () => {
    expect(() => loadEnv({ ...PROD, LOG_PRETTY: 'true' })).toThrow(/LOG_PRETTY/);
  });
});

describe('webApiBaseUrl — the Web-only config surface', () => {
  it('returns the configured API base URL', () => {
    expect(webApiBaseUrl({ API_BASE_URL: 'http://127.0.0.1:9999' })).toBe('http://127.0.0.1:9999');
  });

  it('defaults to the local API when unset', () => {
    expect(webApiBaseUrl({})).toBe('http://127.0.0.1:3100');
  });

  it('rejects an invalid URL instead of rendering it', () => {
    expect(() => webApiBaseUrl({ API_BASE_URL: 'not a url' })).toThrow();
  });

  it('works under next start (NODE_ENV=production) without credentials — the Web never touches them', () => {
    // Regression: `next start` forces NODE_ENV=production, and the full
    // loadEnv schema rejects its development-default credentials there; the
    // Web only reads API_BASE_URL, so it must not run that guard at all.
    expect(webApiBaseUrl({ NODE_ENV: 'production', API_BASE_URL: 'http://api.internal' })).toBe(
      'http://api.internal',
    );
  });

  it('ignores unrelated env keys', () => {
    expect(webApiBaseUrl({ DATABASE_URL: 'postgres://x@y/z', API_BASE_URL: 'http://h:1' })).toBe(
      'http://h:1',
    );
  });
});
