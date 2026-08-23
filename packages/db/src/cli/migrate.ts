import path from 'node:path';
import { MigrationRunner } from '../migrate.js';
import { createPool } from '../client.js';

/**
 * `pnpm --filter @wai/db db:migrate` / `db:rollback`.
 * DATABASE_URL comes from the environment (dev default mirrors config DEV_DEFAULTS).
 */

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://wai_dev:wai_dev_pg_8f3k@127.0.0.1:5433/wai_dev';

// dist/cli/migrate.js → packages/db/migrations
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down') {
    console.error('usage: migrate.ts up|down');
    process.exit(2);
  }
  const pool = createPool(DATABASE_URL);
  try {
    const runner = new MigrationRunner(pool, MIGRATIONS_DIR);
    if (command === 'up') {
      const result = await runner.up();
      console.log(
        `applied: ${result.applied.length === 0 ? '(none)' : result.applied.join(', ')}; ` +
          `skipped (already applied): ${result.skipped.length === 0 ? '(none)' : result.skipped.join(', ')}`,
      );
    } else {
      const rolledBack = await runner.down();
      console.log(rolledBack === null ? 'nothing to roll back' : `rolled back: ${rolledBack}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('migration failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
