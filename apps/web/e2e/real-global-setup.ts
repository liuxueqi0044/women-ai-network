import path from 'node:path';
import { fileURLToPath } from 'node:url';

declare const WAI_MIGRATIONS_DIR: string;

export default async function globalSetup() {
  const [{ createPool, MigrationRunner }, { startTestInfra, startOpaTestContainer }] =
    await Promise.all([import('@wai/db'), import('@wai/testkit')]);
  const started = await startTestInfra();
  const opa = await startOpaTestContainer(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/authz/policies'),
  );
  const pool = createPool(started.infra.databaseUrl);
  try {
    const migrations =
      typeof WAI_MIGRATIONS_DIR === 'string'
        ? WAI_MIGRATIONS_DIR
        : path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            '../../../packages/db/migrations',
          );
    await new MigrationRunner(pool, migrations).up();
  } catch (error) {
    await Promise.allSettled([started.stop(), opa.stop()]);
    throw error;
  } finally {
    await pool.end();
  }
  const apiPort = Number(process.env['WAI_E2E_API_PORT'] ?? 3187);
  const webPort = Number(process.env['WAI_E2E_WEB_PORT'] ?? 3188);
  process.env['API_HOST'] = '127.0.0.1';
  process.env['API_PORT'] = String(apiPort);
  process.env['DATABASE_URL'] = started.infra.databaseUrl;
  process.env['VALKEY_URL'] =
    `redis://:${started.infra.valkey.password}@${started.infra.valkey.host}:${started.infra.valkey.port}`;
  process.env['CORS_ORIGINS'] = `http://127.0.0.1:${webPort}`;
  (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'warn';
  process.env['LOG_PRETTY'] = 'false';
  // Keep this provider-independent real journey hermetic even when the host
  // shell contains a partial Ark/S3 configuration.
  process.env['MEDIA_UPLOADS_ENABLED'] = 'false';
  process.env['WAI_E2E_API_URL'] = `http://127.0.0.1:${apiPort}`;
  process.env['ELG_OPA_URL'] = opa.baseUrl;
  return async () => Promise.allSettled([started.stop(), opa.stop()]).then(() => undefined);
}
