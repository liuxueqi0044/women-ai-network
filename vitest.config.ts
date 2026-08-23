import { defineConfig } from 'vitest/config';

// Project list replaces the deprecated vitest.workspace.ts (removed in the
// next vitest major). Project names stay stable — the root package.json
// scripts select individual suites with `--project <name>`.
export default defineConfig({
  test: {
    projects: [
      'packages/authz/vitest.config.ts',
      'packages/contracts/vitest.config.ts',
      'packages/config/vitest.config.ts',
      'packages/db/vitest.config.ts',
      'packages/observability/vitest.config.ts',
      'packages/media-infra/vitest.config.ts',
      'apps/web/vitest.config.ts',
      'apps/api/vitest.config.ts',
      'apps/worker/vitest.config.ts',
      'tests/integration/vitest.config.ts',
    ],
  },
});
