import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

export default defineConfig({
  // NOTE: esbuild (vitest's transform pipeline) no longer emits
  // design:paramtypes even with emitDecoratorMetadata in tsconfig — Nest
  // classes must use explicit @Inject() on class-typed constructor params.
  // The tsconfig flags still make esbuild PARSE decorators; only the
  // metadata emission is unavailable, so @Inject is mandatory in tests.
  resolve: {
    alias: [
      // zod-to-openapi patches the zod PROTOTYPE, which only works when every
      // module sees ONE zod instance. Vitest loads node_modules natively, so
      // zod splits into an ESM copy (import) and a CJS copy (require), and the
      // symlinked @wai/* packages resolve as node_modules paths — loaded
      // natively as CJS, they build the contracts schemas with a different
      // instance than this app patches. Aliasing unifies both problems:
      {
        // Force the workspace packages through vite's transform pipeline —
        // their real paths contain no node_modules segment, so they are
        // inlined like regular source instead of native-loaded as CJS.
        find: /^@wai\/(contracts|config|observability|db|testkit)$/,
        replacement: path.resolve(import.meta.dirname, '../../packages/$1/src/index.ts'),
      },
      {
        // Unify on zod's CJS entry: transformed modules import it natively and
        // Node shares the CJS cache with require(), so the prototype patch is
        // visible to every module in the graph.
        find: 'zod',
        replacement: require.resolve('zod'),
      },
    ],
  },
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
