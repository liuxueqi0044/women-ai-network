import { z } from 'zod';

/**
 * Health DTOs shared by API and Web.
 * Stable by design: no connection strings, hostnames, versions or
 * implementation details may leak through these shapes.
 */

/** GET /v1/health/live — process liveness only, no dependency checks. */
export const healthLiveResponseSchema = z
  .object({
    status: z.literal('alive'),
    timestamp: z.string().datetime(),
  })
  .strict();

export type HealthLiveResponse = z.infer<typeof healthLiveResponseSchema>;

const dependencyStateSchema = z.enum(['up', 'down']);

/**
 * GET /v1/health/ready — dependency readiness.
 * `status: 'ready'` only when every dependency is up; any failure yields
 * `'degraded'` with per-dependency state in `checks`.
 */
export const healthReadyResponseSchema = z
  .object({
    status: z.enum(['ready', 'degraded']),
    checks: z
      .object({
        postgres: dependencyStateSchema,
        valkey: dependencyStateSchema,
        queue: dependencyStateSchema,
      })
      .strict(),
    timestamp: z.string().datetime(),
  })
  .strict();

export type HealthReadyResponse = z.infer<typeof healthReadyResponseSchema>;
export type DependencyState = z.infer<typeof dependencyStateSchema>;
