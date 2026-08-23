import { z } from 'zod';

/**
 * Single, Zod-validated environment configuration for every app.
 *
 * `loadEnv` is a pure function over an env record so tests and apps can pass
 * `process.env` or a hand-built object. No file I/O, no side effects.
 *
 * Production guards (fail fast at startup, never silently degrade):
 * - development default credentials are rejected;
 * - CORS wildcard ('*') is rejected;
 * - OpenAPI is disabled unless explicitly switched on.
 */

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const OTEL_EXPORTERS = ['console', 'otlp'] as const;
const MEDIA_ADAPTERS = ['real', 'fake'] as const;
const MEDIA_CONTENT_MODERATION_ADAPTERS = ['doubao', 'fake'] as const;

/** Development-only defaults shared with compose.yaml and .env.example. */
export const DEV_DEFAULTS = {
  databaseUrl: 'postgres://wai_dev:wai_dev_pg_8f3k@127.0.0.1:5433/wai_dev',
  valkeyUrl: 'redis://:wai_dev_valkey_9q2x@127.0.0.1:6380',
  // IAM-01 secret material — development ONLY. Production startup REJECTS
  // these exact values (same guard as the database/valkey credentials above).
  iamSecretPepper: 'wai-dev-iam-pepper-do-not-use-in-production-01',
  // {"dev-key": "<base64 of 32 random bytes>"}
  iamPiiKeysJson: '{"dev-key":"dUnDePcXXLNeIe+ZDKq3MveXGJ611HjLHRIDvYlNcHM="}',
} as const;

/** Parses 'true'/'false' only — '1', 'yes' etc. are rejected, not coerced. */
const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const enabledByDefaultBoolean = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: booleanFromString,
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  API_BASE_URL: z.string().url().default('http://127.0.0.1:3100'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  ENABLE_OPENAPI: booleanFromString,
  DATABASE_URL: z.string().url().default(DEV_DEFAULTS.databaseUrl),
  VALKEY_URL: z.string().min(1).default(DEV_DEFAULTS.valkeyUrl),
  OTEL_ENABLED: booleanFromString,
  OTEL_EXPORTER: z.enum(OTEL_EXPORTERS).default('console'),
  OTEL_OTLP_ENDPOINT: z.string().url().optional(),
  FOUNDATION_TRACE_RESULT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  // IAM-01 session/cookie/secret/rate-limit configuration.
  IAM_SESSION_IDLE_SECONDS: z.coerce.number().int().positive().default(604_800),
  IAM_SESSION_ABSOLUTE_SECONDS: z.coerce.number().int().positive().default(2_592_000),
  IAM_COOKIE_SECURE: booleanFromString,
  IAM_SECRET_PEPPER: z.string().min(32).default(DEV_DEFAULTS.iamSecretPepper),
  IAM_PII_KEYS: z.string().min(1).default(DEV_DEFAULTS.iamPiiKeysJson),
  IAM_PII_KEY_ID: z.string().min(1).default('dev-key'),
  // IP dimension (per-route @fastify/rate-limit) and email-digest dimension
  // (RateLimiter port) — fixed per-route budgets, single shared windows.
  IAM_RATE_LIMIT_IP_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  IAM_RATE_LIMIT_IP_REGISTRATIONS_MAX: z.coerce.number().int().positive().default(30),
  IAM_RATE_LIMIT_IP_SESSIONS_MAX: z.coerce.number().int().positive().default(60),
  IAM_RATE_LIMIT_IP_MFA_MAX: z.coerce.number().int().positive().default(30),
  IAM_RATE_LIMIT_EMAIL_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  IAM_RATE_LIMIT_LOGIN_EMAIL_MAX: z.coerce.number().int().positive().default(10),
  IAM_RATE_LIMIT_REGISTRATION_EMAIL_MAX: z.coerce.number().int().positive().default(3),
  // Operational kill switch. Disabling uploads is a supported production
  // state while storage/scanning providers are being selected; requests fail
  // closed and no fake provider is composed.
  MEDIA_UPLOADS_ENABLED: enabledByDefaultBoolean,
  MEDIA_STORAGE_ADAPTER: z.enum(MEDIA_ADAPTERS).default('real'),
  MEDIA_SCANNER_ADAPTER: z.enum(MEDIA_ADAPTERS).default('real'),
  MEDIA_SANITIZER_ADAPTER: z.enum(MEDIA_ADAPTERS).default('real'),
  MEDIA_CONTENT_MODERATION_ADAPTER: z.enum(MEDIA_CONTENT_MODERATION_ADAPTERS).default('fake'),
  MEDIA_S3_ENDPOINT: z.string().url().optional(),
  MEDIA_S3_REGION: z.string().trim().min(1).max(100).optional(),
  MEDIA_S3_QUARANTINE_BUCKET: z.string().trim().min(3).max(63).optional(),
  MEDIA_S3_CLEAN_BUCKET: z.string().trim().min(3).max(63).optional(),
  MEDIA_S3_QUARANTINE_ACCESS_KEY: z.string().min(1).optional(),
  MEDIA_S3_QUARANTINE_SECRET_KEY: z.string().min(8).optional(),
  MEDIA_S3_CLEAN_ACCESS_KEY: z.string().min(1).optional(),
  MEDIA_S3_CLEAN_SECRET_KEY: z.string().min(8).optional(),
  CLAMAV_HOST: z.string().trim().min(1).max(253).default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  ARK_API_BASE_URL: z.string().url().default('https://ark.cn-beijing.volces.com/api/v3'),
  ARK_API_KEY: z.string().min(16).optional(),
  ARK_VISION_MODEL: z.string().trim().min(3).max(200).optional(),
  ARK_VISION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
});

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type OtelExporter = (typeof OTEL_EXPORTERS)[number];

export interface ValkeyConnection {
  host: string;
  port: number;
  /** Present when the URL carries a password (ioredis/BullMQ connection option). */
  password?: string;
  db: number;
  tls: boolean;
}

export interface IamRateLimitConfig {
  /** IP dimension — applied per account route by @fastify/rate-limit. */
  ipWindowSeconds: number;
  ipRegistrationsMax: number;
  ipSessionsMax: number;
  ipMfaMax: number;
  /** Email-digest dimension — consumed by the RateLimiter port in services. */
  emailWindowSeconds: number;
  loginEmailMax: number;
  registrationEmailMax: number;
}

export interface IamConfig {
  sessionIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  /** Session cookie Secure flag; production REQUIRES true (startup guard). */
  cookieSecure: boolean;
  /** Raw secret pepper (>= 32 bytes, parsed by @wai/db at startup). */
  secretPepper: string;
  /** Raw JSON map of { keyId: base64-32-byte-key } (parsed by @wai/db). */
  piiKeysJson: string;
  /** Key id used for NEW ciphertexts (must exist in piiKeys). */
  piiKeyId: string;
  rateLimit: IamRateLimitConfig;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  isProduction: boolean;
  logLevel: LogLevel;
  logPretty: boolean;
  apiHost: string;
  apiPort: number;
  apiBaseUrl: string;
  corsOrigins: string[];
  /** OpenAPI document enabled in non-production by default; in production only via explicit switch. */
  openapiEnabled: boolean;
  databaseUrl: string;
  valkeyUrl: string;
  valkey: ValkeyConnection;
  otel: {
    enabled: boolean;
    exporter: OtelExporter;
    otlpEndpoint?: string;
  };
  foundationTraceResultTtlSeconds: number;
  iam: IamConfig;
  media: {
    enabled: boolean;
    storageAdapter: 'real' | 'fake';
    scannerAdapter: 'real' | 'fake';
    sanitizerAdapter: 'real' | 'fake';
    contentModerationAdapter: 'doubao' | 'fake';
    storage?: {
      endpointHost: string;
      endpointPort: number;
      useSsl: boolean;
      region?: string;
      quarantineBucket: string;
      cleanBucket: string;
      quarantineAccessKey: string;
      quarantineSecretKey: string;
      cleanAccessKey: string;
      cleanSecretKey: string;
    };
    scanner: { host: string; port: number };
    contentModeration?: {
      apiBaseUrl: string;
      apiKey: string;
      model: string;
      timeoutMs: number;
    };
  };
}

/** Safe summary for error messages — never echoes userinfo (password). */
function describeUrl(raw: string): string {
  return raw.replace(/^([a-z]+):\/\/[^@/]*@/i, '$1://***@');
}

function parseValkeyUrl(raw: string): ValkeyConnection {
  const shown = describeUrl(raw);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`VALKEY_URL is not a valid URL: ${shown}`);
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`VALKEY_URL must use redis:// or rediss://, got: ${shown}`);
  }
  if (!url.hostname) {
    throw new Error(`VALKEY_URL has no host: ${shown}`);
  }
  const dbRaw = url.pathname.replace(/^\//, '');
  const db = dbRaw === '' ? 0 : Number(dbRaw);
  if (!Number.isInteger(db) || db < 0) {
    throw new Error(`VALKEY_URL has an invalid database index: ${shown}`);
  }
  const connection: ValkeyConnection = {
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'rediss:' ? 6380 : 6379,
    db,
    tls: url.protocol === 'rediss:',
  };
  // ioredis URL convention: password lives in the userinfo (redis://:password@host).
  if (url.password) {
    connection.password = decodeURIComponent(url.password);
  }
  return connection;
}

function parseMediaEndpoint(raw: string): {
  endpointHost: string;
  endpointPort: number;
  useSsl: boolean;
} {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MEDIA_S3_ENDPOINT must use http:// or https://');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('MEDIA_S3_ENDPOINT must be a bare origin without path, query or fragment');
  }
  return {
    endpointHost: url.hostname,
    endpointPort: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
    useSsl: url.protocol === 'https:',
  };
}

export function loadEnv(source: NodeJS.ProcessEnv): AppConfig {
  const raw = envSchema.parse(source);

  const storageValues = [
    raw.MEDIA_S3_ENDPOINT,
    raw.MEDIA_S3_QUARANTINE_BUCKET,
    raw.MEDIA_S3_CLEAN_BUCKET,
    raw.MEDIA_S3_QUARANTINE_ACCESS_KEY,
    raw.MEDIA_S3_QUARANTINE_SECRET_KEY,
    raw.MEDIA_S3_CLEAN_ACCESS_KEY,
    raw.MEDIA_S3_CLEAN_SECRET_KEY,
  ];
  const hasAnyStorageValue = storageValues.some((value) => value !== undefined);
  const hasAllStorageValues = storageValues.every((value) => value !== undefined);
  if (raw.MEDIA_UPLOADS_ENABLED && hasAnyStorageValue && !hasAllStorageValues) {
    throw new Error('media S3 configuration is incomplete');
  }
  if (
    raw.MEDIA_UPLOADS_ENABLED &&
    (raw.ARK_API_KEY === undefined) !== (raw.ARK_VISION_MODEL === undefined)
  ) {
    throw new Error('Doubao visual review requires both ARK_API_KEY and ARK_VISION_MODEL');
  }

  // R1-02: an idle window longer than the absolute lifetime can never be
  // honored — every touch would violate `idle_expires_at <= absolute_expires_at`.
  // Fail fast at startup; the message carries no secrets.
  if (raw.IAM_SESSION_IDLE_SECONDS > raw.IAM_SESSION_ABSOLUTE_SECONDS) {
    throw new Error(
      'IAM_SESSION_IDLE_SECONDS must not exceed IAM_SESSION_ABSOLUTE_SECONDS (the idle window is capped at the absolute expiry)',
    );
  }

  const isProduction = raw.NODE_ENV === 'production';

  if (isProduction) {
    if (
      raw.DATABASE_URL === DEV_DEFAULTS.databaseUrl ||
      raw.VALKEY_URL === DEV_DEFAULTS.valkeyUrl
    ) {
      throw new Error(
        'production configuration must not use development default credentials; set DATABASE_URL/VALKEY_URL explicitly',
      );
    }
    if (raw.LOG_PRETTY) {
      throw new Error('production configuration must not enable LOG_PRETTY');
    }
    // IAM-01: session cookies must be Secure in production; the dev pepper
    // and PII keys are local-only and must never reach a production build.
    if (!raw.IAM_COOKIE_SECURE) {
      throw new Error(
        'production configuration must set IAM_COOKIE_SECURE=true (session cookies require Secure)',
      );
    }
    if (raw.IAM_SECRET_PEPPER === DEV_DEFAULTS.iamSecretPepper) {
      throw new Error(
        'production configuration must not use the development IAM secret pepper; set IAM_SECRET_PEPPER explicitly',
      );
    }
    if (raw.IAM_PII_KEYS === DEV_DEFAULTS.iamPiiKeysJson) {
      throw new Error(
        'production configuration must not use the development IAM PII keys; set IAM_PII_KEYS explicitly',
      );
    }
    if (
      raw.MEDIA_UPLOADS_ENABLED &&
      (raw.MEDIA_STORAGE_ADAPTER === 'fake' ||
        raw.MEDIA_SCANNER_ADAPTER === 'fake' ||
        raw.MEDIA_SANITIZER_ADAPTER === 'fake')
    ) {
      throw new Error(
        'production media configuration must use real storage, scanner and sanitizer adapters',
      );
    }
  }

  const corsOrigins = raw.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  for (const origin of corsOrigins) {
    if (origin === '*') {
      if (isProduction) {
        throw new Error("production CORS_ORIGINS must not contain '*'");
      }
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS entry is not a valid origin: ${origin}`);
    }
    if (parsed.origin !== origin) {
      throw new Error(`CORS_ORIGINS entry must be a bare origin (scheme://host[:port]): ${origin}`);
    }
  }

  // OpenAPI: enabled in non-production by default; in production only when the
  // explicit switch is set.
  const openapiEnabled = !isProduction || raw.ENABLE_OPENAPI;

  const otel: AppConfig['otel'] = {
    enabled: raw.OTEL_ENABLED,
    exporter: raw.OTEL_EXPORTER,
    ...(raw.OTEL_OTLP_ENDPOINT === undefined ? {} : { otlpEndpoint: raw.OTEL_OTLP_ENDPOINT }),
  };

  let mediaStorage: AppConfig['media']['storage'];
  if (raw.MEDIA_UPLOADS_ENABLED && hasAllStorageValues) {
    const endpoint = parseMediaEndpoint(raw.MEDIA_S3_ENDPOINT!);
    mediaStorage = {
      ...endpoint,
      ...(raw.MEDIA_S3_REGION === undefined ? {} : { region: raw.MEDIA_S3_REGION }),
      quarantineBucket: raw.MEDIA_S3_QUARANTINE_BUCKET!,
      cleanBucket: raw.MEDIA_S3_CLEAN_BUCKET!,
      quarantineAccessKey: raw.MEDIA_S3_QUARANTINE_ACCESS_KEY!,
      quarantineSecretKey: raw.MEDIA_S3_QUARANTINE_SECRET_KEY!,
      cleanAccessKey: raw.MEDIA_S3_CLEAN_ACCESS_KEY!,
      cleanSecretKey: raw.MEDIA_S3_CLEAN_SECRET_KEY!,
    };
  }

  const contentModeration: AppConfig['media']['contentModeration'] =
    !raw.MEDIA_UPLOADS_ENABLED ||
    raw.ARK_API_KEY === undefined ||
    raw.ARK_VISION_MODEL === undefined
      ? undefined
      : {
          apiBaseUrl: raw.ARK_API_BASE_URL,
          apiKey: raw.ARK_API_KEY,
          model: raw.ARK_VISION_MODEL,
          timeoutMs: raw.ARK_VISION_TIMEOUT_MS,
        };

  return {
    nodeEnv: raw.NODE_ENV,
    isProduction,
    logLevel: raw.LOG_LEVEL,
    logPretty: raw.LOG_PRETTY,
    apiHost: raw.API_HOST,
    apiPort: raw.API_PORT,
    apiBaseUrl: raw.API_BASE_URL,
    corsOrigins,
    openapiEnabled,
    databaseUrl: raw.DATABASE_URL,
    valkeyUrl: raw.VALKEY_URL,
    valkey: parseValkeyUrl(raw.VALKEY_URL),
    otel,
    foundationTraceResultTtlSeconds: raw.FOUNDATION_TRACE_RESULT_TTL_SECONDS,
    iam: {
      sessionIdleSeconds: raw.IAM_SESSION_IDLE_SECONDS,
      sessionAbsoluteSeconds: raw.IAM_SESSION_ABSOLUTE_SECONDS,
      cookieSecure: raw.IAM_COOKIE_SECURE,
      secretPepper: raw.IAM_SECRET_PEPPER,
      piiKeysJson: raw.IAM_PII_KEYS,
      piiKeyId: raw.IAM_PII_KEY_ID,
      rateLimit: {
        ipWindowSeconds: raw.IAM_RATE_LIMIT_IP_WINDOW_SECONDS,
        ipRegistrationsMax: raw.IAM_RATE_LIMIT_IP_REGISTRATIONS_MAX,
        ipSessionsMax: raw.IAM_RATE_LIMIT_IP_SESSIONS_MAX,
        ipMfaMax: raw.IAM_RATE_LIMIT_IP_MFA_MAX,
        emailWindowSeconds: raw.IAM_RATE_LIMIT_EMAIL_WINDOW_SECONDS,
        loginEmailMax: raw.IAM_RATE_LIMIT_LOGIN_EMAIL_MAX,
        registrationEmailMax: raw.IAM_RATE_LIMIT_REGISTRATION_EMAIL_MAX,
      },
    },
    media: {
      enabled: raw.MEDIA_UPLOADS_ENABLED,
      storageAdapter: raw.MEDIA_STORAGE_ADAPTER,
      scannerAdapter: raw.MEDIA_SCANNER_ADAPTER,
      sanitizerAdapter: raw.MEDIA_SANITIZER_ADAPTER,
      contentModerationAdapter: raw.MEDIA_CONTENT_MODERATION_ADAPTER,
      ...(mediaStorage === undefined ? {} : { storage: mediaStorage }),
      scanner: { host: raw.CLAMAV_HOST, port: raw.CLAMAV_PORT },
      ...(contentModeration === undefined ? {} : { contentModeration }),
    },
  };
}

/**
 * API base URL for the Web app — the only config surface the Web consumes.
 *
 * Deliberately does NOT run the full `loadEnv` schema: the Web needs no
 * database/valkey credentials, and `next start` forces NODE_ENV=production,
 * which would otherwise trip the production-credential guard on the schema's
 * development defaults even though the Web never touches them.
 */
export function webApiBaseUrl(source: NodeJS.ProcessEnv = process.env): string {
  return z.string().url().default('http://127.0.0.1:3100').parse(source['API_BASE_URL']);
}
