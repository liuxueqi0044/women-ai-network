import { defineConfig, devices } from '@playwright/test';

const apiPort = Number(process.env['WAI_E2E_API_PORT'] ?? 3187);
const webPort = Number(process.env['WAI_E2E_WEB_PORT'] ?? 3188);
const requestedProject = process.env['WAI_E2E_PROJECT'];
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.real.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', testMatch: '**/*.real.spec.ts', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'introductions-mobile',
      testMatch: '**/introductions.real.spec.ts',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'notifications-mobile',
      testMatch: '**/notifications.real.spec.ts',
      use: { ...devices['Pixel 5'] },
    },
  ].filter((project) => !requestedProject || project.name === requestedProject),
  webServer: [
    {
      command: 'node --env-file-if-exists=../../.env dist/main.js',
      cwd: '../api',
      url: `http://127.0.0.1:${apiPort}/v1/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `next start -p ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @wai/worker build && node e2e/worker-process.mjs',
      cwd: '../web',
      url: `http://127.0.0.1:${process.env['WAI_E2E_WORKER_HEALTH_PORT'] ?? 3190}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
