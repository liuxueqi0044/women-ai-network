import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

/**
 * Explicit, forward/backward SQL migration runner.
 *
 * Each migrations/NNNN_*.sql file carries `-- +BEGIN UP` / `-- +END UP` and
 * `-- +BEGIN DOWN` / `-- +END DOWN` sections. Applied files are tracked in
 * iam.schema_migrations with a sha256 checksum of the whole file; a modified
 * applied file fails loudly instead of being silently re-applied.
 *
 * Up:  apply every not-yet-applied file in name order, each in its own
 *      transaction. Re-running is a no-op.
 * Down: roll back the most recently applied file.
 *
 * drizzle-kit is never invoked — the SQL here is the source of truth.
 *
 * The migrations directory is explicit (constructor argument): the CLI
 * resolves it via __dirname, tests via import.meta — the runner itself is
 * module-system agnostic.
 */

const BEGIN_UP = /^-- \+BEGIN UP\s*$/m;
const END_UP = /^-- \+END UP\s*$/m;
const BEGIN_DOWN = /^-- \+BEGIN DOWN\s*$/m;
const END_DOWN = /^-- \+END DOWN\s*$/m;

export interface MigrationFile {
  name: string;
  /** Whole-file sha256, used to detect post-apply tampering. */
  checksum: string;
  upSql: string;
  downSql: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt: Date;
}

function section(sql: string, begin: RegExp, end: RegExp, label: string): string {
  const beginMatch = sql.match(begin);
  const endMatch = sql.match(end);
  if (
    beginMatch === null ||
    endMatch === null ||
    endMatch.index === undefined ||
    beginMatch.index === undefined
  ) {
    throw new Error(
      `migration section ${label} not found (need '-- +BEGIN ${label}' / '-- +END ${label}')`,
    );
  }
  if (endMatch.index <= beginMatch.index + beginMatch[0].length) {
    throw new Error(`migration section ${label} is empty`);
  }
  return sql.slice(beginMatch.index + beginMatch[0].length, endMatch.index).trim();
}

export function loadMigrationFile(fileName: string, dir: string): MigrationFile {
  const raw = readFileSync(path.join(dir, fileName), 'utf8');
  return {
    name: fileName,
    checksum: createHash('sha256').update(raw, 'utf8').digest('hex'),
    upSql: section(raw, BEGIN_UP, END_UP, 'UP'),
    downSql: section(raw, BEGIN_DOWN, END_DOWN, 'DOWN'),
  };
}

export function loadMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error(`no migration files found in ${dir}`);
  }
  return files.map((name) => loadMigrationFile(name, dir));
}

export class MigrationRunner {
  constructor(
    private readonly pool: Pool,
    private readonly dir: string,
    private readonly options: { through?: string } = {},
  ) {}

  async up(): Promise<{ applied: string[]; skipped: string[] }> {
    const migrations = this.scopedMigrations();
    await this.bootstrap();
    const applied = new Map<string, AppliedMigration>(
      (await this.listApplied()).map((row) => [row.name, row]),
    );
    const result: { applied: string[]; skipped: string[] } = { applied: [], skipped: [] };
    for (const migration of migrations) {
      const existing = applied.get(migration.name);
      if (existing !== undefined) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `migration ${migration.name} was applied with a different checksum — file tampered`,
          );
        }
        result.skipped.push(migration.name);
        continue;
      }
      await this.applyOne(migration);
      result.applied.push(migration.name);
    }
    return result;
  }

  /** Rolls back the most recently applied migration. Returns its name or null when nothing is applied. */
  async down(): Promise<string | null> {
    await this.bootstrap();
    const applied = await this.listApplied();
    const scopedNames = new Set(this.scopedMigrations().map((migration) => migration.name));
    const latest = [...applied].reverse().find((migration) => scopedNames.has(migration.name));
    if (latest === undefined) {
      return null;
    }
    const migration = loadMigrationFile(latest.name, this.dir);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Delete the tracker row first: the DOWN section may drop the schema.
      await client.query('DELETE FROM iam.schema_migrations WHERE name = $1', [latest.name]);
      await client.query(migration.downSql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return migration.name;
  }

  private scopedMigrations(): MigrationFile[] {
    const migrations = loadMigrations(this.dir);
    if (this.options.through === undefined) return migrations;
    const index = migrations.findIndex((migration) => migration.name === this.options.through);
    if (index === -1) throw new Error(`migration scope not found: ${this.options.through}`);
    return migrations.slice(0, index + 1);
  }

  private async bootstrap(): Promise<void> {
    await this.pool.query(
      `CREATE SCHEMA IF NOT EXISTS iam;
       CREATE TABLE IF NOT EXISTS iam.schema_migrations (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       );`,
    );
  }

  private async listApplied(): Promise<AppliedMigration[]> {
    const { rows } = await this.pool.query<{
      name: string;
      checksum: string;
      applied_at: Date;
    }>('SELECT name, checksum, applied_at FROM iam.schema_migrations ORDER BY applied_at');
    return rows.map((row) => ({
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    }));
  }

  private async applyOne(migration: MigrationFile): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.upSql);
      await client.query('INSERT INTO iam.schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
