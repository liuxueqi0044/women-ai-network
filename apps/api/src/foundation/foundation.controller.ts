import { Body, Controller, Inject, Post } from '@nestjs/common';
import {
  foundationTraceRequestSchema,
  type FoundationTraceRequest,
  type FoundationTraceResponse,
} from '@wai/contracts';
import { ZodValidationPipe } from '../infra/pipes/zod-validation.pipe.js';
// Value import, not `import type`: Nest reads the class from
// emitDecoratorMetadata's design:paramtypes, and a type-only import leaves
// no runtime binding (the metadata degrades to `Function`).
import { FoundationService } from './foundation.service.js';

@Controller('foundation')
export class FoundationController {
  // Explicit @Inject: vitest's esbuild transform cannot emit
  // design:paramtypes (esbuild dropped emitDecoratorMetadata), so class-typed
  // constructor params must declare their token at decoration time.
  constructor(@Inject(FoundationService) private readonly foundation: FoundationService) {}

  /**
   * Enqueues a `foundation.trace` smoke job. No business data involved —
   * this endpoint exists to prove the Web → API → Queue → Worker flow.
   */
  @Post('trace')
  trace(
    @Body(new ZodValidationPipe(foundationTraceRequestSchema)) body: FoundationTraceRequest,
  ): Promise<FoundationTraceResponse> {
    return this.foundation.acceptTrace(body);
  }
}
