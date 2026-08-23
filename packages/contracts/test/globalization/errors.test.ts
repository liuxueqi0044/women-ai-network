import { describe, expect, it } from 'vitest';
import { ERROR_CODES, errorEnvelopeSchema } from '../../src/errors.js';

describe('GLO-01 stable HTTP errors', () => {
  it('publishes precondition, conflict and timezone codes in the strict envelope', () => {
    for (const code of [
      'PRECONDITION_REQUIRED',
      'IDEMPOTENCY_CONFLICT',
      'VERSION_CONFLICT',
      'INVALID_TIME_ZONE',
    ]) {
      expect(ERROR_CODES).toHaveProperty(code, code);
      expect(() =>
        errorEnvelopeSchema.parse({
          code,
          message: 'stable',
          request_id: 'f0b4f0b4-6b2a-4e12-9a1c-2d3e4f5a6b7c',
        }),
      ).not.toThrow();
    }
  });
});
