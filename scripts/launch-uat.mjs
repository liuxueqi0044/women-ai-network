import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, run, writeJson } from './staging-lib.mjs';

const project = 'wai-launch-uat';
const composeEnv = {
  POSTGRES_USER: 'wai_dev',
  POSTGRES_PASSWORD: 'wai_dev_pg_8f3k',
  POSTGRES_DB: 'wai_dev',
  VALKEY_PASSWORD: 'wai_dev_valkey_9q2x',
  POSTGRES_HOST_PORT: '25433',
  VALKEY_HOST_PORT: '26380',
  OPA_HOST_PORT: '28181',
};
const testEnv = {
  ...composeEnv,
  DATABASE_URL: 'postgres://wai_dev:wai_dev_pg_8f3k@127.0.0.1:25433/wai_dev',
  VALKEY_URL: 'redis://:wai_dev_valkey_9q2x@127.0.0.1:26380/0',
  ELG_OPA_URL: 'http://127.0.0.1:28181',
  API_HOST: '127.0.0.1',
  API_PORT: '3087',
  CORS_ORIGINS: 'http://127.0.0.1:3088',
  NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3087/v1',
  MEDIA_UPLOADS_ENABLED: 'false',
  WAI_E2E_API_PORT: '3087',
  WAI_E2E_WEB_PORT: '3088',
  WAI_E2E_REUSE_EXISTING: 'false',
  WAI_E2E_STABLE: 'true',
};
const pnpmCli = process.env['npm_execpath'];
if (!pnpmCli) {
  throw new Error('launch UAT must be invoked through `pnpm launch:uat`');
}
const pnpm = process.execPath;
const pnpmArgs = (args) => [pnpmCli, ...args];
const phases = [
  ['deployment contract tests', 'node', ['--test', 'scripts/staging-lib.test.mjs'], {}],
  ['format', pnpm, pnpmArgs(['format:check']), {}],
  ['lint', pnpm, pnpmArgs(['lint']), {}],
  ['typecheck', pnpm, pnpmArgs(['typecheck']), {}],
  ['unit and contract regression', pnpm, pnpmArgs(['test']), {}],
  ['real database integration regression', pnpm, pnpmArgs(['test:integration']), {}],
  ['dedicated safety database acceptance', pnpm, pnpmArgs(['test:saf:real']), {}],
  ['production build', pnpm, pnpmArgs(['build']), {}],
];
const results = [];
let failure;

try {
  for (const [name, command, args, options] of phases) {
    const started = Date.now();
    console.log(`[launch-uat] starting ${name}`);
    await run(command, args, options);
    results.push({ name, status: 'passed', duration_ms: Date.now() - started });
  }

  await run('docker', ['compose', '-p', project, 'up', '-d', '--wait'], { env: composeEnv });
  let started = Date.now();
  await run(pnpm, pnpmArgs(['test:e2e']), { env: testEnv });
  results.push({
    name: 'desktop and mobile browser regression',
    status: 'passed',
    duration_ms: Date.now() - started,
  });

  started = Date.now();
  await run(pnpm, pnpmArgs(['exec', 'tsx', 'apps/web/e2e/run-globalization-real.ts']));
  results.push({
    name: 'real API dual-member desktop/mobile journey',
    status: 'passed',
    duration_ms: Date.now() - started,
  });

  started = Date.now();
  await run(pnpm, pnpmArgs(['exec', 'tsx', 'apps/web/e2e/run-onboarding-real.ts']));
  results.push({
    name: 'real onboarding browser journey',
    status: 'passed',
    duration_ms: Date.now() - started,
  });
} catch (error) {
  failure = error;
  results.push({
    name: 'run',
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  await run('docker', ['compose', '-p', project, 'down', '-v', '--remove-orphans'], {
    env: composeEnv,
  }).catch((error) => {
    results.push({
      name: 'isolated cleanup',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    failure ??= error;
  });
  const report = path.join(ROOT, 'test-results', 'launch-uat-summary.json');
  await mkdir(path.dirname(report), { recursive: true });
  await writeJson(report, { completed_at: new Date().toISOString(), project, results });
  console.log(`[launch-uat] report: ${path.relative(ROOT, report)}`);
}

if (failure) {
  console.error(`[launch-uat] ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exitCode = 1;
} else {
  console.log('[launch-uat] all automated launch phases passed');
}
