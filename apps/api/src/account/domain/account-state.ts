import { accountStateSchema } from '@wai/contracts';

/**
 * Account operational state machine (IAM-01 task book §4).
 *
 * State means ONLY "is IAM allowed to authenticate this account" — it never
 * implies adult, identity-verified, or membership status:
 *
 *   enabled -> suspended -> enabled
 *   enabled -> deletion_pending -> enabled
 *   enabled | suspended -> deletion_pending -> deleted
 *   deleted -> (no transition)
 *
 * Pure functions: no I/O, so every legal/illegal transition is table-testable
 * without a database. Persistence + optimistic CAS live in the services.
 */

export const ACCOUNT_STATES = ['enabled', 'suspended', 'deletion_pending', 'deleted'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/** Stable public reason codes for account state transitions. */
export const ACCOUNT_STATE_REASONS = [
  'admin_suspend',
  'admin_unsuspend',
  'user_deletion_request',
  'user_deletion_cancel',
  'deletion_completed',
] as const;
export type AccountStateReason = (typeof ACCOUNT_STATE_REASONS)[number];

export const ACCOUNT_ACTOR_TYPES = ['system', 'user', 'admin'] as const;
export type AccountActorType = (typeof ACCOUNT_ACTOR_TYPES)[number];

const REASONS: Readonly<
  Record<AccountState, Readonly<Partial<Record<AccountState, AccountStateReason>>>>
> = {
  enabled: {
    suspended: 'admin_suspend',
    deletion_pending: 'user_deletion_request',
  },
  suspended: {
    enabled: 'admin_unsuspend',
    deletion_pending: 'user_deletion_request',
  },
  deletion_pending: {
    enabled: 'user_deletion_cancel',
    deleted: 'deletion_completed',
  },
  deleted: {},
};

/** True when the transition is legal — regardless of the reason supplied. */
export function canTransition(from: AccountState, to: AccountState): boolean {
  return REASONS[from][to] !== undefined;
}

/** The reason code allowed for this transition, or undefined. */
export function transitionReason(
  from: AccountState,
  to: AccountState,
): AccountStateReason | undefined {
  return REASONS[from][to];
}

/**
 * Throws a DomainStateError when the transition is illegal (including any
 * transition out of `deleted`). Reason codes are validated per transition,
 * so a wrong reason can never be recorded.
 */
export function assertTransition(
  from: AccountState,
  to: AccountState,
  reason: AccountStateReason,
): void {
  const expected = REASONS[from][to];
  if (expected === undefined) {
    throw new DomainStateError(`illegal account state transition: ${from} -> ${to}`);
  }
  if (expected !== reason) {
    throw new DomainStateError(
      `reason code ${reason} is not valid for transition ${from} -> ${to} (expected ${expected})`,
    );
  }
}

/** Stable domain error — services map it to 409/400 without leaking internals. */
export class DomainStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainStateError';
  }
}

export function parseAccountState(value: string): AccountState {
  return accountStateSchema.parse(value);
}

export const ACCOUNT_STATE_VALUES: readonly AccountState[] = ACCOUNT_STATES;
