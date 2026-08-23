import type {
  AgeModePolicyDecisionPort,
  AgePartitionDecisionPort,
  DecisionOutput,
  ModeDecisionInput,
  PartitionDecisionInput,
} from '@wai/contracts';
import { modeDecisionInputSchema, partitionDecisionInputSchema } from '@wai/contracts';
import { OpaDecisionClient } from './decision-client.js';
import { OpaAdapterError, OpaInputInvalidError } from './opa-errors.js';

/**
 * Fail-closed fallback returned by both ports whenever the engine cannot be
 * used or trusted. Callers receive a deny — never an exception — so an OPA
 * outage degrades into refusal, not into accidentally permissive behaviour.
 */
const FAIL_CLOSED_DENY: DecisionOutput = {
  decision: 'deny',
  reason_codes: [],
  obligations: [],
};

function toFailClosed(error: OpaAdapterError): DecisionOutput {
  return {
    ...FAIL_CLOSED_DENY,
    reason_codes: error.reasonCode === null ? [] : [error.reasonCode],
  };
}

/** Adapter for single-subject mode decisions (AgeModePolicyDecisionPort). */
export class OpaModeDecisionAdapter implements AgeModePolicyDecisionPort {
  private readonly client: OpaDecisionClient;

  constructor(baseUrl: string, timeoutMs: number) {
    this.client = new OpaDecisionClient(baseUrl, timeoutMs);
  }

  async decide(input: ModeDecisionInput): Promise<DecisionOutput> {
    const parsed = modeDecisionInputSchema.strict().safeParse(input);
    if (!parsed.success) {
      // Invalid input is a programming error in the caller — never fail the
      // engine for it. Throwing is correct here.
      throw new OpaInputInvalidError(`Invalid mode decision input: ${parsed.error.message}`);
    }
    try {
      return await this.client.evaluate<DecisionOutput>('mode_decision', parsed.data);
    } catch (err) {
      if (err instanceof OpaAdapterError) {
        return toFailClosed(err);
      }
      throw err;
    }
  }
}

/** Adapter for two-party partition decisions (AgePartitionDecisionPort). */
export class OpaPartitionDecisionAdapter implements AgePartitionDecisionPort {
  private readonly client: OpaDecisionClient;

  constructor(baseUrl: string, timeoutMs: number) {
    this.client = new OpaDecisionClient(baseUrl, timeoutMs);
  }

  async decide(input: PartitionDecisionInput): Promise<DecisionOutput> {
    const parsed = partitionDecisionInputSchema.strict().safeParse(input);
    if (!parsed.success) {
      throw new OpaInputInvalidError(`Invalid partition decision input: ${parsed.error.message}`);
    }
    try {
      return await this.client.evaluate<DecisionOutput>('partition_decision', parsed.data);
    } catch (err) {
      if (err instanceof OpaAdapterError) {
        return toFailClosed(err);
      }
      throw err;
    }
  }
}
