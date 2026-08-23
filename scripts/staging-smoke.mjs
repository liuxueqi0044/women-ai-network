import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_ENV_FILE,
  ROOT,
  cliOption,
  composeArgs,
  loadEnvFile,
  run,
  validateStagingEnv,
} from './staging-lib.mjs';

const envFile = path.resolve(ROOT, cliOption('env-file', path.relative(ROOT, DEFAULT_ENV_FILE)));
process.env['STAGING_RUNTIME_ENV_FILE'] = envFile;

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function requireRunning(project, service) {
  const { stdout } = await run(
    'docker',
    composeArgs(envFile, project, ['ps', '--status', 'running', '-q', service]),
    { capture: true },
  );
  if (!stdout.trim()) throw new Error(`${service} is not running`);
}

try {
  const env = await loadEnvFile(envFile);
  const summary = validateStagingEnv(env);
  for (const service of ['postgres', 'valkey', 'opa', 'api', 'worker', 'web']) {
    await requireRunning(summary.project, service);
  }
  const live = await fetchJson(`${summary.apiUrl}/v1/health/live`);
  if (live.status !== 'alive') throw new Error('API liveness contract failed');
  const ready = await fetchJson(`${summary.apiUrl}/v1/health/ready`);
  if (ready.status !== 'ready') throw new Error('API readiness contract failed');
  const web = await fetch(summary.webUrl, {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!web.ok || !(await web.text()).includes('<html')) throw new Error('Web shell smoke failed');

  const migrationFiles = (await readdir(path.join(ROOT, 'packages', 'db', 'migrations'))).filter(
    (name) => /^\d{4}_.+\.sql$/u.test(name),
  ).length;
  const query = 'SELECT count(*) FROM iam.schema_migrations;';
  const result = await run(
    'docker',
    composeArgs(envFile, summary.project, [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      env.POSTGRES_USER,
      '-d',
      env.POSTGRES_DB,
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      query,
    ]),
    { capture: true },
  );
  const applied = Number(result.stdout.trim());
  if (applied !== migrationFiles) {
    throw new Error(`migration count mismatch: database=${applied}, workspace=${migrationFiles}`);
  }
  console.log(`staging smoke passed: 6 services, live+ready+web, ${applied} migrations`);
} catch (error) {
  console.error(`[staging-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
