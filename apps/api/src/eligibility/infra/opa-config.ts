import { z } from 'zod';

/**
 * ELG-01 policy-engine configuration.
 *
 * NOTE (recorded deviation): packages/config/src/index.ts is outside the
 * ELG-01 allowed-modification list, so OPA settings live here — same
 * philosophy as loadEnv: a pure zod-validated function over an env record,
 * with production rejecting the development default. The api app module
 * injects the parsed config; nothing else reads process.env.
 */

const OPA_DEV_URL = 'http://127.0.0.1:8181';
const OPA_DEV_TIMEOUT_MS = 3000;

export interface OpaConfig {
  baseUrl: string;
  queryTimeoutMs: number;
}

export function loadOpaConfig(source: NodeJS.ProcessEnv): OpaConfig {
  const raw = z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      ELG_OPA_URL: z.string().url().default(OPA_DEV_URL),
      ELG_OPA_QUERY_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .positive()
        .max(60_000)
        .default(OPA_DEV_TIMEOUT_MS),
    })
    .parse(source);

  if (raw.NODE_ENV === 'production' && raw.ELG_OPA_URL === OPA_DEV_URL) {
    throw new Error(
      'production configuration must not use the development OPA URL; set ELG_OPA_URL explicitly',
    );
  }

  return { baseUrl: raw.ELG_OPA_URL, queryTimeoutMs: raw.ELG_OPA_QUERY_TIMEOUT_MS };
}
