import { defineConfig, devices } from '@playwright/test';

const apiPort = Number(process.env['WAI_E2E_API_PORT'] ?? 3100);
const webPort = Number(process.env['WAI_E2E_WEB_PORT'] ?? 3000);
const reuseExistingServer = !process.env['CI'] && process.env['WAI_E2E_REUSE_EXISTING'] !== 'false';

/**
 * E2E smoke for the FND-01 foundation. Infra (Postgres/Valkey) is expected
 * to be up via docker compose before this runs — see the root test:e2e
 * script and the CI workflow. The API and Web servers are started here.
 * The Worker is not required for the browser smoke (trace enqueue happens
 * through the API; cross-process correlation is covered by integration tests).
 */
export default defineConfig({
  testDir: './e2e',
  // The globalization real spec owns isolated API/Web/Testcontainers through
  // playwright.real.config.ts. The default suite must never discover it a
  // second time. Mock-only runs also omit foundation, whose contract requires
  // the real API started by the normal root E2E environment.
  testIgnore: process.env['ONBOARDING_MOCK_API']
    ? ['**/*.real.spec.ts', '**/foundation.spec.ts']
    : '**/*.real.spec.ts',
  fullyParallel: false,
  ...(process.env['WAI_E2E_STABLE'] ? { workers: 4 } : {}),
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/mobile-native.spec.ts', '**/*.real.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-native',
      testMatch: '**/mobile-native.spec.ts',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'onboarding-mobile',
      testMatch: '**/onboarding.spec.ts',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'notifications-mobile',
      testMatch: '**/notifications.spec.ts',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: [
    ...(process.env['ONBOARDING_MOCK_API']
      ? []
      : [
          {
            command: 'node --env-file-if-exists=../../.env dist/main.js',
            cwd: '../api',
            url: `http://127.0.0.1:${apiPort}/v1/health/live`,
            reuseExistingServer,
            timeout: 30_000,
          },
        ]),
    {
      command: `next start -p ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer,
      timeout: 60_000,
    },
  ],
});
