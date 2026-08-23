import type { ReasonCode } from '@wai/contracts';

/**
 * Adapter error taxonomy (task book §7, adapter side). The public ports never
 * leak these — `decide()` converts them into a fail-closed deny carrying the
 * corresponding reason code. Throwing is reserved for programming errors the
 * caller must fix (invalid input), not for engine failures.
 */
export type OpaAdapterErrorKind = 'unavailable' | 'output_invalid' | 'input_invalid';

export class OpaAdapterError extends Error {
  readonly kind: OpaAdapterErrorKind;
  /** Fail-closed reason code the decision should carry. */
  readonly reasonCode: ReasonCode | null;

  constructor(kind: OpaAdapterErrorKind, message: string, reasonCode: ReasonCode | null = null) {
    super(message);
    this.name = 'OpaAdapterError';
    this.kind = kind;
    this.reasonCode = reasonCode;
  }
}

/** Engine unreachable: connect refused, timeout, non-2xx. → POLICY_ENGINE_UNAVAILABLE */
export class OpaUnavailableError extends OpaAdapterError {
  constructor(message: string) {
    super('unavailable', message, 'POLICY_ENGINE_UNAVAILABLE');
    this.name = 'OpaUnavailableError';
  }
}

/** Engine answered but the output failed strict validation. → POLICY_OUTPUT_INVALID */
export class OpaOutputInvalidError extends OpaAdapterError {
  constructor(message: string) {
    super('output_invalid', message, 'POLICY_OUTPUT_INVALID');
    this.name = 'OpaOutputInvalidError';
  }
}

/** The caller handed the adapter an invalid decision input — a programming error. */
export class OpaInputInvalidError extends OpaAdapterError {
  constructor(message: string) {
    super('input_invalid', message, null);
    this.name = 'OpaInputInvalidError';
  }
}
