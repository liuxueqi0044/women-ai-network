import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@wai\/contracts$/,
        replacement: path.resolve(import.meta.dirname, '../../packages/contracts/src/index.ts'),
      },
      {
        find: 'zod',
        replacement: require.resolve('zod'),
      },
    ],
  },
  test: {
    name: 'authz',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
