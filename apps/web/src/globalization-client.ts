import {
  errorEnvelopeSchema,
  globalizationPreferencesRequestSchema,
  globalizationPreferencesSchema,
  type GlobalizationPreferences,
  type GlobalizationPreferencesRequest,
} from '@wai/contracts';
import { getWebApiBaseUrl } from './lib/web-api-base';

export class GlobalizationHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GlobalizationHttpError';
  }
}

export function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(32);
  if (!cryptoApi?.getRandomValues) throw new Error('secure randomness unavailable');
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function parseResponse(response: Response): Promise<unknown> {
  const raw = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorEnvelopeSchema.safeParse(raw);
    throw new GlobalizationHttpError(
      response.status,
      parsed.success ? parsed.data.code : 'BAD_REQUEST',
      parsed.success ? parsed.data.message : 'Request failed',
    );
  }
  return raw;
}

export async function getGlobalizationPreferences(
  fetchImpl: typeof fetch = fetch,
): Promise<GlobalizationPreferences> {
  const response = await fetchImpl(`${getWebApiBaseUrl()}/globalization/preferences`, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  return globalizationPreferencesSchema.parse(await parseResponse(response));
}

export async function putGlobalizationPreferences(
  value: GlobalizationPreferencesRequest,
  version: number,
  options: { fetchImpl?: typeof fetch; origin?: string; idempotencyKey?: string } = {},
): Promise<GlobalizationPreferences> {
  const parsed = globalizationPreferencesRequestSchema.parse(value);
  const idempotencyKey = options.idempotencyKey ?? createIdempotencyKey();
  const response = await (options.fetchImpl ?? fetch)(
    `${getWebApiBaseUrl()}/globalization/preferences`,
    {
      method: 'PUT',
      credentials: 'include',
      body: JSON.stringify(parsed),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'if-match': `"${version}"`,
        'idempotency-key': idempotencyKey,
        origin: options.origin ?? (typeof window === 'undefined' ? '' : window.location.origin),
      },
    },
  );
  return globalizationPreferencesSchema.parse(await parseResponse(response));
}
