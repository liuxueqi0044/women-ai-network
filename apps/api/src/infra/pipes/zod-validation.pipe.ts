import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a request body against a @wai/contracts Zod schema and replaces
 * the raw body with the parsed, typed value. Invalid payloads become a
 * 400 VALIDATION_ERROR envelope with the Zod issues as details.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    // Fastify gives `undefined` for empty bodies; the schemas expect an object.
    const input = value === undefined ? {} : value;
    const result = this.schema.safeParse(input);
    if (!result.success) {
      // Throw the raw ZodError: the global exception filter maps it to the
      // VALIDATION_ERROR envelope and derives details from the issues.
      throw result.error;
    }
    return result.data;
  }
}
