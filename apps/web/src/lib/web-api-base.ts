/**
 * Browser API contract: NEXT_PUBLIC_API_BASE_URL is the versioned v1 base,
 * never the API origin. Keeping this rule in one helper prevents callers from
 * accidentally producing /v1/v1 or an unversioned request.
 */
const DEFAULT_WEB_API_BASE = 'http://127.0.0.1:3100/v1';
const runtimePublicApiBase = (process.env as { NEXT_PUBLIC_API_BASE_URL?: string })
  .NEXT_PUBLIC_API_BASE_URL;
type WebEnv = { NEXT_PUBLIC_API_BASE_URL?: string; [key: string]: string | undefined };

export function getWebApiBaseUrl(env: WebEnv = process.env): string {
  const raw =
    (env === process.env ? runtimePublicApiBase : env['NEXT_PUBLIC_API_BASE_URL']) ??
    DEFAULT_WEB_API_BASE;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('NEXT_PUBLIC_API_BASE_URL must be an absolute URL ending in /v1');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname !== '/v1') {
    throw new Error('NEXT_PUBLIC_API_BASE_URL must be the versioned /v1 base');
  }
  parsed.pathname = pathname;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}
