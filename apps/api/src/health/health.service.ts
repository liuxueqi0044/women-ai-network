import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  type HealthLiveResponse,
  type HealthReadyResponse,
} from '@wai/contracts';
import { CACHE_ADAPTER, DATABASE_ADAPTER, QUEUE_ADAPTER } from '../tokens.js';
import type { CacheAdapter, DatabaseAdapter, QueueProducerAdapter } from '../infra/adapters.js';

// Bounded, but generous enough for first connects to containers on
// Windows/Docker (NAT warm-up can push past 3s); the endpoint can delay
// this long but can never hang longer.
const CHECK_TIMEOUT_MS = 8000;

/**
 * Health checks with bounded timeouts — a hung dependency can delay but
 * never hang the readiness endpoint.
 */
@Injectable()
export class HealthService implements OnModuleDestroy {
  constructor(
    @Inject(DATABASE_ADAPTER) private readonly database: DatabaseAdapter,
    @Inject(CACHE_ADAPTER) private readonly cache: CacheAdapter,
    @Inject(QUEUE_ADAPTER) private readonly queue: QueueProducerAdapter,
  ) {}

  live(): HealthLiveResponse {
    return healthLiveResponseSchema.parse({ status: 'alive', timestamp: new Date().toISOString() });
  }

  async ready(): Promise<HealthReadyResponse> {
    const [postgres, valkey, queue] = await Promise.all([
      this.withTimeout(() => this.database.ping()),
      this.withTimeout(() => this.cache.ping()),
      this.withTimeout(() => this.queue.check()),
    ]);
    return healthReadyResponseSchema.parse({
      status: postgres && valkey && queue ? 'ready' : 'degraded',
      checks: {
        postgres: postgres ? 'up' : 'down',
        valkey: valkey ? 'up' : 'down',
        queue: queue ? 'up' : 'down',
      },
      timestamp: new Date().toISOString(),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.database.close(), this.cache.close(), this.queue.close()]);
  }

  private async withTimeout(check: () => Promise<boolean>): Promise<boolean> {
    try {
      return await Promise.race([
        check(),
        new Promise<boolean>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error('health check timed out')),
            CHECK_TIMEOUT_MS,
          );
          timer.unref();
        }),
      ]);
    } catch {
      return false;
    }
  }
}
