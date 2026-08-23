/**
 * IAM-01 error codes. Merged into the shared ERROR_CODES / error envelope
 * by ../errors.ts — every code here is a stable public API surface:
 * clients must never see internal messages, digests or reason codes.
 */
export const ACCOUNT_ERROR_CODES = {
  /** Anonymous login failure — deliberately uniform for every cause. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Request needs a valid session cookie. */
  SESSION_REQUIRED: 'SESSION_REQUIRED',
  /** A rotated session token was presented again; family compromised. */
  SESSION_REPLAY_DETECTED: 'SESSION_REPLAY_DETECTED',
  /** Account has MFA enabled; only a challenge was issued. */
  MFA_REQUIRED: 'MFA_REQUIRED',
  /** Wrong TOTP code, or challenge attempts exhausted. */
  MFA_INVALID: 'MFA_INVALID',
  /** The MFA challenge expired before completion. */
  MFA_CHALLENGE_EXPIRED: 'MFA_CHALLENGE_EXPIRED',
  /** Wrong, already-used, or stale recovery code. */
  RECOVERY_CODE_INVALID: 'RECOVERY_CODE_INVALID',
  /** Password re-verification failed on an MFA management action (enrolled session). */
  INVALID_PASSWORD: 'INVALID_PASSWORD',
  /** An enabled TOTP factor already exists — disable it before enrolling another. */
  MFA_ALREADY_ENABLED: 'MFA_ALREADY_ENABLED',
  /** A pending enrollment is already in flight — confirm or abandon it first. */
  MFA_ENROLLMENT_IN_PROGRESS: 'MFA_ENROLLMENT_IN_PROGRESS',
  /** Account state (suspended/deletion_pending/deleted) blocks auth. */
  ACCOUNT_STATE_DENIED: 'ACCOUNT_STATE_DENIED',
  /** Rate limit exceeded — stable response, never reveals account state. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Device resource does not exist for this account (uniform 404). */
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  /** Origin check failed for a state-changing request. */
  FORBIDDEN: 'FORBIDDEN',
} as const;

export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[keyof typeof ACCOUNT_ERROR_CODES];

export const accountErrorCodes = Object.values(ACCOUNT_ERROR_CODES) as AccountErrorCode[];
