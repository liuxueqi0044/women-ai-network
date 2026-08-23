import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'media-infra',
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
