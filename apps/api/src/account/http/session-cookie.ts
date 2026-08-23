import type { CookieSerializeOptions } from '@fastify/cookie';
import type { AppConfig } from '@wai/config';

/**
 * IAM-01 cookie policy (task book §6, plan D6). Session tokens travel ONLY in
 * the HttpOnly cookie; the token itself is the opaque 256-bit value and is
 * never signed or readable by client code.
 *
 * - Production: `__Host-wai_session` — the __Host- prefix makes browsers
 *   REJECT the cookie unless Secure, Path=/ and no Domain are set, so the
 *   deployment cannot silently weaken it.
 * - Dev/test: `wai_session_dev` — no Secure flag (http://localhost), same
 *   digest/rotation semantics.
 */

export const SESSION_COOKIE_PRODUCTION = '__Host-wai_session';
export const SESSION_COOKIE_DEV = 'wai_session_dev';
export const MFA_CHALLENGE_COOKIE = 'wai_mfa_challenge';
/** Server-issued opaque device identity — long-lived (365 days), HttpOnly. */
export const DEVICE_COOKIE = 'wai_device';

export function sessionCookieName(config: AppConfig): string {
  return config.isProduction ? SESSION_COOKIE_PRODUCTION : SESSION_COOKIE_DEV;
}

/** Path-scoped to the login routes so only the MFA completion flow sees it. */
export const MFA_CHALLENGE_COOKIE_PATH = '/v1/account/sessions';

export function sessionCookieOptions(config: AppConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.iam.cookieSecure,
    path: '/',
  };
}

export function mfaChallengeCookieOptions(config: AppConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.iam.cookieSecure,
    path: MFA_CHALLENGE_COOKIE_PATH,
    maxAge: 300,
  };
}

/** Task book §9: server-random opaque device cookie, 365-day lifetime. */
export function deviceCookieOptions(config: AppConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.iam.cookieSecure,
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
  };
}
