import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

/**
 * Integration tests: real Postgres/Valkey containers (via @wai/testkit),
 * real in-process API and Worker apps, real queue round-trips.
 * Generous timeouts because containers take tens of seconds to start.
 *
 * The resolve aliases mirror apps/api/vitest.config.ts — this suite imports
 * the api/worker SOURCES, so it inherits their module-graph constraints:
 *  - @wai/* packages must go through vite's transform pipeline (real source
 *    paths contain no node_modules segment) instead of native CJS loading;
 *  - zod must resolve to its CJS entry so every module (transformed or
 *    native) shares ONE zod instance — the openapi prototype patch depends
 *    on it.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@wai\/(contracts|config|observability|testkit|db|authz)$/,
        replacement: path.resolve(import.meta.dirname, '../../packages/$1/src/index.ts'),
      },
      {
        find: 'zod',
        replacement: require.resolve('zod'),
      },
    ],
  },
  define: {
    // SQL migrations live here; the constant is injected because import.meta
    // is invalid under the CommonJS settings tests typecheck with.
    WAI_MIGRATIONS_DIR: JSON.stringify(
      path.resolve(import.meta.dirname, '../../packages/db/migrations'),
    ),
    // Rego policy files live here; used to bind-mount a real OPA container.
    WAI_POLICIES_DIR: JSON.stringify(
      path.resolve(import.meta.dirname, '../../packages/authz/policies'),
    ),
  },
  test: {
    name: 'integration',
    environment: 'node',
    include: ['**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
