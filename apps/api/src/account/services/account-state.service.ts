import { Injectable } from '@nestjs/common';
import type { AccountState } from '@wai/db';

/**
 * IAM-01 account operational-state checks shared by auth paths.
 *
 * Only `enabled` accounts may authenticate — for NEW logins (CP3) the caller
 * maps a denied state to the uniform INVALID_CREDENTIALS response with an
 * internal per-state reason code in the security event; for EXISTING sessions
 * (CP4) the same check revokes the session and returns ACCOUNT_STATE_DENIED.
 */
@Injectable()
export class AccountStateService {
  /** States allowed to start or continue an authenticated session. */
  canAuthenticate(state: AccountState): boolean {
    return state === 'enabled';
  }

  /** Stable internal reason code for security events — never public. */
  deniedLoginReason(state: AccountState): string {
    return `ACCOUNT_STATE_DENIED_${state.toUpperCase()}`;
  }
}
