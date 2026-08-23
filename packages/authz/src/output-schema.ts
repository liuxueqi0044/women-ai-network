import { z } from 'zod';
import { decisionOutputSchema } from '@wai/contracts';

/**
 * OPA Data API envelope (POST /v1/data/<path>). Strict: any field outside
 * `decision_id` + `result` invalidates the response. The output contract
 * itself is whitelist-constrained (decision/reason_codes/obligations), so an
 * OPA that starts emitting account IDs, birthdays or any unknown code fails
 * closed as POLICY_OUTPUT_INVALID — nothing unknown may ever pass through.
 */
export const opaEnvelopeSchema = z
  .object({
    decision_id: z.string().optional(),
    result: decisionOutputSchema,
  })
  .strict();

export type OpaEnvelope = z.infer<typeof opaEnvelopeSchema>;
