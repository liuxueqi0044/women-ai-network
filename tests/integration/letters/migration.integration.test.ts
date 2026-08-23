import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { MigrationRunner, createPool } from '@wai/db';
import { startTestInfra, type StartedInfra } from '@wai/testkit';

declare const WAI_MIGRATIONS_DIR: string;

let infra: StartedInfra;
let pool: Pool;
let runner: MigrationRunner;

beforeAll(async () => {
  infra = await startTestInfra();
  pool = createPool(infra.infra.databaseUrl);
  runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR, { through: '0010_letters.sql' });
});

afterAll(async () => {
  await pool?.end();
  await infra?.stop();
});

describe('LTR-01 real PostgreSQL migration lifecycle', () => {
  it('fresh applies 0010, second up is no-op, down removes it, and up reapplies', async () => {
    const fresh = await runner.up();
    expect(fresh.applied.at(-1)).toBe('0010_letters.sql');
    expect(fresh.skipped).toEqual([]);
    expect((await pool.query("SELECT to_regclass('letters.letters') AS name")).rows[0]?.name).toBe(
      'letters.letters',
    );

    const noop = await runner.up();
    expect(noop.applied).toEqual([]);
    expect(noop.skipped.at(-1)).toBe('0010_letters.sql');

    expect(await runner.down()).toBe('0010_letters.sql');
    expect(
      (await pool.query("SELECT to_regclass('letters.letters') AS name")).rows[0]?.name,
    ).toBeNull();

    const reapplied = await runner.up();
    expect(reapplied.applied).toEqual(['0010_letters.sql']);
    expect(
      (await pool.query("SELECT to_regclass('letters.letter_revisions') AS name")).rows[0]?.name,
    ).toBe('letters.letter_revisions');
  });
});
