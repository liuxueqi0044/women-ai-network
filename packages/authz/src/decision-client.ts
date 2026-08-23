import { opaEnvelopeSchema, type OpaEnvelope } from './output-schema.js';
import { OpaOutputInvalidError, OpaUnavailableError } from './opa-errors.js';

/**
 * Minimal OPA Data API client (POST /v1/data/eligibility/<path>). Fail-closed
 * taxonomy: connection/timeout/non-2xx → OpaUnavailableError; body that is
 * not JSON or fails the strict envelope schema → OpaOutputInvalidError. The
 * strict whitelist envelope is what guarantees an OPA emitting account IDs,
 * birthdays or unknown reason codes can never surface to callers.
 */
export class OpaDecisionClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async evaluate<T extends { decision: 'allow' | 'deny' }>(
    policyPath: string,
    input: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/v1/data/eligibility/${policyPath}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new OpaUnavailableError(
          `OPA request timed out after ${this.timeoutMs}ms: ${message}`,
        );
      }
      throw new OpaUnavailableError(`OPA request failed: ${message}`);
    }

    if (!response.ok) {
      throw new OpaUnavailableError(
        `OPA responded ${response.status} ${response.statusText} for ${policyPath}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpaOutputInvalidError(`OPA response was not JSON for ${policyPath}: ${message}`);
    }

    const parsed = opaEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new OpaOutputInvalidError(
        `OPA response failed strict validation for ${policyPath}: ${parsed.error.message}`,
      );
    }
    const envelope: OpaEnvelope = parsed.data;
    // Schema already guarantees the DecisionOutput shape; the intermediate
    // unknown keeps the cast honest for generic callers.
    return envelope.result as unknown as T;
  }
}
