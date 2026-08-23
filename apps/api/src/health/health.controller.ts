import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthLiveResponse, HealthReadyResponse } from '@wai/contracts';
// Value import, not `import type`: Nest reads the class from
// emitDecoratorMetadata's design:paramtypes, and a type-only import leaves
// no runtime binding (the metadata degrades to `Function`).
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  // Explicit @Inject: vitest's esbuild transform cannot emit
  // design:paramtypes (esbuild dropped emitDecoratorMetadata), so class-typed
  // constructor params must declare their token at decoration time.
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Process liveness only — no dependency checks. */
  @Get('live')
  live(): HealthLiveResponse {
    return this.health.live();
  }

  /** Dependency readiness (PostgreSQL, Valkey, queue) with a stable DTO. */
  @Get('ready')
  async ready(): Promise<HealthReadyResponse> {
    return this.health.ready();
  }
}
