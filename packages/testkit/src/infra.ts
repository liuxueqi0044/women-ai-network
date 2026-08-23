import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

/**
 * Containerized PostgreSQL/Valkey lifecycle for integration tests.
 *
 * - Images are pinned to the same exact versions as compose.yaml.
 * - Random host ports: tests never depend on (or collide with) developer
 *   machines or other suites.
 * - Containers are always stopped in `finally`, even when the test body
 *   throws — a failed test never leaks containers or connections.
 * - Postgres is started via the generic container API (no
 *   @testcontainers/postgres dependency) with explicit credentials, so the
 *   suite is portable across registries and mirrors.
 */

// Keep in sync with compose.yaml.
const POSTGRES_IMAGE = 'postgres:17.5-alpine';
const VALKEY_IMAGE = 'valkey/valkey:8.1.1-alpine';
const VALKEY_TEST_PASSWORD = 'wai_test_valkey';
const VALKEY_PORT = 6379;
const POSTGRES_PORT = 5432;
const POSTGRES_USER = 'wai_test';
const POSTGRES_PASSWORD = 'wai_test_pg';
const POSTGRES_DB = 'wai_test';

export interface ValkeyTestConnection {
  host: string;
  port: number;
  password: string;
}

export interface TestInfra {
  /** Full postgres:// URL with the container's ephemeral port. */
  databaseUrl: string;
  /** Connection parts for BullMQ/ioredis clients. */
  valkey: ValkeyTestConnection;
}

export interface WithInfraOptions {
  /** Skips container startup entirely (must never be used on real suites). */
  skip?: boolean;
}

export interface StartTestInfraOptions {
  /**
   * Overrides the valkey-server argv. Test seam: a negative test forces
   * Valkey to exit immediately (unknown flag) so the Postgres cleanup path
   * of a failed startup is exercised.
   */
  valkeyCommand?: string[];
}

const DEFAULT_VALKEY_COMMAND = [
  'valkey-server',
  '--requirepass',
  VALKEY_TEST_PASSWORD,
  '--appendonly',
  'no',
  '--save',
  '',
];

export interface StartedInfra {
  infra: TestInfra;
  /** Failure-safe cleanup — safe to call twice, never throws. */
  stop(): Promise<void>;
}

/**
 * Starts Postgres and Valkey and returns a stop handle. Use this for
 * beforeAll/afterAll suites that share one container pair across tests.
 *
 * Failure-safe: if Valkey fails to start after Postgres is up, the Postgres
 * container is stopped before the error is rethrown — no failure path leaks
 * containers (R1-07).
 */
export async function startTestInfra(options: StartTestInfraOptions = {}): Promise<StartedInfra> {
  const postgres = await new GenericContainer(POSTGRES_IMAGE)
    .withExposedPorts(POSTGRES_PORT)
    .withEnvironment({
      POSTGRES_USER: POSTGRES_USER,
      POSTGRES_PASSWORD: POSTGRES_PASSWORD,
      POSTGRES_DB: POSTGRES_DB,
    })
    // The official image logs "ready to accept connections" TWICE: once for
    // the init-phase server and once for the real one. Waiting for the first
    // occurrence races the container restart and Docker Desktop's port
    // forwarding, dropping connections on Windows. Require both.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/i, 2))
    .withStartupTimeout(60_000)
    .start();
  let valkey: StartedTestContainer;
  try {
    valkey = await new GenericContainer(VALKEY_IMAGE)
      .withExposedPorts(VALKEY_PORT)
      .withCommand(options.valkeyCommand ?? DEFAULT_VALKEY_COMMAND)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/i))
      .withStartupTimeout(60_000)
      .start();
  } catch (error) {
    // Best-effort: the Valkey error is the primary signal to rethrow; the
    // reaper removes anything left over at process exit.
    await postgres.stop().catch(() => undefined);
    throw error;
  }

  const databaseUrl = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${postgres.getHost()}:${postgres.getMappedPort(POSTGRES_PORT)}/${POSTGRES_DB}`;

  const infra: TestInfra = {
    databaseUrl,
    valkey: {
      host: valkey.getHost(),
      port: valkey.getMappedPort(VALKEY_PORT),
      password: VALKEY_TEST_PASSWORD,
    },
  };

  let stopped = false;
  return {
    infra,
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      await Promise.allSettled([postgres.stop(), valkey.stop()]);
    },
  };
}

/**
 * Starts Postgres and Valkey, runs `fn`, and always stops both containers.
 * Usage:
 *
 *   await withInfra(async (infra) => {
 *     const config = loadEnv({ ...process.env, DATABASE_URL: infra.databaseUrl, ... });
 *     ...
 *   });
 */
export async function withInfra<T>(fn: (infra: TestInfra) => Promise<T>): Promise<T> {
  const started = await startTestInfra();
  try {
    return await fn(started.infra);
  } finally {
    // Failure-safe cleanup: released even when the test body throws.
    await started.stop();
  }
}
