import path from 'node:path';
import { ROOT, run } from './staging-lib.mjs';

const pnpmCli = process.env['npm_execpath'];
if (!pnpmCli) throw new Error('safety real acceptance must be invoked through pnpm');

const [{ createPool, MigrationRunner }, { startTestInfra }] = await Promise.all([
  import('@wai/db'),
  import('@wai/testkit'),
]);
const started = await startTestInfra();

try {
  const pool = createPool(started.infra.databaseUrl);
  try {
    await new MigrationRunner(pool, path.join(ROOT, 'packages', 'db', 'migrations')).up();
  } finally {
    await pool.end();
  }
  await run(
    process.execPath,
    [
      pnpmCli,
      'exec',
      'vitest',
      'run',
      '--project',
      'integration',
      'tests/integration/safety/real.test.ts',
      'tests/integration/safety/privacy.test.ts',
      '--no-file-parallelism',
    ],
    { env: { DATABASE_URL: started.infra.databaseUrl } },
  );
  console.log('safety real acceptance passed against isolated migrated PostgreSQL');
} finally {
  await started.stop();
}
