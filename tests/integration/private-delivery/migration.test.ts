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
  runner = new MigrationRunner(pool, WAI_MIGRATIONS_DIR, { through: '0012_private_delivery.sql' });
}, 180_000);
afterAll(async () => {
  await pool?.end();
  await infra?.stop();
}, 180_000);

describe('PVL-01 PostgreSQL lifecycle', () => {
  it('fresh/no-op/down/up creates and removes only 0012 at the final step', async () => {
    const fresh = await runner.up();
    expect(fresh.applied.at(-1)).toBe('0012_private_delivery.sql');
    expect(
      (await pool.query("SELECT to_regclass('private_delivery.deliveries') AS name")).rows[0]?.name,
    ).toBe('private_delivery.deliveries');
    expect((await runner.up()).applied).toEqual([]);
    expect(await runner.down()).toBe('0012_private_delivery.sql');
    expect(
      (await pool.query("SELECT to_regclass('private_delivery.deliveries') AS name")).rows[0]?.name,
    ).toBeNull();
    expect((await runner.up()).applied).toEqual(['0012_private_delivery.sql']);
  });
});
