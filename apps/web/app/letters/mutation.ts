export type MutationAttempt = {
  key: string;
  payloadFingerprint: string;
  version: number | null;
};

export function payloadFingerprint(payload: unknown): string {
  return JSON.stringify(payload);
}

export function createLetterPayload(kind: string, content: Record<string, unknown>) {
  return { kind, ...content };
}

export function patchLetterPayload(content: Record<string, unknown>) {
  return { ...content };
}

/** Reuse a key only for the exact payload/version that may have an ambiguous result. */
export function bindMutationAttempt(
  previous: MutationAttempt | null,
  payload: unknown,
  version: number | null,
  makeKey: () => string,
): MutationAttempt {
  const fingerprint = payloadFingerprint(payload);
  if (
    previous !== null &&
    previous.payloadFingerprint === fingerprint &&
    previous.version === version
  ) {
    return previous;
  }
  return { key: makeKey(), payloadFingerprint: fingerprint, version };
}

/** Network ambiguity can safely retry; a server rejection needs a fresh key. */
export function shouldReuseAfterFailure(status: number | null): boolean {
  return status === null || status === 0 || status >= 500;
}
