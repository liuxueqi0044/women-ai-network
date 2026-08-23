import { createHash } from 'node:crypto';
import { ELIGIBILITY_ENGINE_VERSION, reasonCodes, type ReasonCode } from '@wai/contracts';

/**
 * ELG-01 decision model. `decisionReasonOrder` is the documented, stable
 * evaluation order (task book §5) — first applicable reason wins.
 */
export const decisionReasonOrder: readonly ReasonCode[] = reasonCodes;

/** Snapshot schema version stamped on every mode/partition decision. */
export const ENGINE_VERSION: number = ELIGIBILITY_ENGINE_VERSION;

/**
 * The horizon within which a decision snapshot remains reliable — the
 * earlier of the credential and policy windows (both open-ended when both
 * are). Postgres 'infinity' is the number Infinity in the repository rows.
 */
export function decisionValidUntil(
  credentialValidUntil: Date | number,
  policyEffectiveUntil: Date | number,
): Date | number {
  const toMs = (value: Date | number): number =>
    typeof value === 'number' ? value : value.getTime();
  const horizon = Math.min(toMs(credentialValidUntil), toMs(policyEffectiveUntil));
  return Number.isFinite(horizon) ? new Date(horizon) : Infinity;
}

/** Deterministic primary reason for a deny result (first applicable in the fixed order). */
export function primaryReason(codes: readonly ReasonCode[]): ReasonCode {
  for (const code of decisionReasonOrder) {
    if (codes.includes(code)) {
      return code;
    }
  }
  throw new Error('deny decision without any known reason code');
}

export interface DecisionIdFields {
  account_id: string;
  mode: string;
  effective_at: string;
  policy_id: string;
  credential_id: string;
  input_hash: string;
  idempotency_key: string;
}

/**
 * Deterministic decision id: sha256 over the full input tuple, encoded as
 * RFC 4122 UUID v5. Identical inputs (including the idempotency key)
 * always yield the same id, so retries reuse the stored snapshot. Every
 * field is a fixed-shape value (UUID / enum / ISO datetime / hex digest /
 * bounded key string), so the `\n` join cannot collide.
 */
export function deriveDecisionId(fields: DecisionIdFields): string {
  return sha256UuidV5(
    [
      fields.account_id,
      fields.mode,
      fields.effective_at,
      fields.policy_id,
      fields.credential_id,
      fields.input_hash,
      fields.idempotency_key,
    ].join('\n'),
  );
}

export interface PartitionDecisionIdFields {
  actor_account_id: string;
  subject_account_id: string;
  capability: string;
  effective_at: string;
  actor_policy_id: string;
  subject_policy_id: string;
  actor_credential_id: string;
  subject_credential_id: string;
  input_hash: string;
}

/**
 * Deterministic two-party decision id. The tuple fixes both accounts, the
 * capability, the effective instant, both policy selections and both
 * credentials — the same evaluation replayed (or repeated downstream, e.g.
 * by Matching/Chat/Events) always resolves to the same snapshot. There is no
 * idempotency key: this port has no HTTP surface, the tuple is the key.
 */
export function derivePartitionDecisionId(fields: PartitionDecisionIdFields): string {
  return sha256UuidV5(
    [
      fields.actor_account_id,
      fields.subject_account_id,
      fields.capability,
      fields.effective_at,
      fields.actor_policy_id,
      fields.subject_policy_id,
      fields.actor_credential_id,
      fields.subject_credential_id,
      fields.input_hash,
    ].join('\n'),
  );
}

/** sha256 of a canonical tuple, encoded as RFC 4122 UUID v5. */
function sha256UuidV5(canonical: string): string {
  const digest = createHash('sha256').update(canonical, 'utf8').digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50; // version 5
  digest[8] = (digest[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
