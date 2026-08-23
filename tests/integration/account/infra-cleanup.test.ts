import { describe, expect, it } from 'vitest';
import {
  getContainerRuntimeClient,
  getReaper,
  LABEL_TESTCONTAINERS_SESSION_ID,
} from 'testcontainers';
import { startTestInfra, type StartedInfra } from '@wai/testkit';

/**
 * R1-07 negative evidence over real containers (repair plan §9): when Valkey
 * fails to start, startTestInfra() must stop the Postgres container it
 * already started and rethrow — a failed suite never leaks containers. The
 * valkeyCommand seam forces Valkey to exit immediately (unknown flag), so the
 * wait strategy rejects in seconds; the docker check proves no
 * postgres:17.5-alpine container survives the failed start.
 *
 * Every integration file in the suite (14 files, each with its own container
 * pair) uses the same postgres image, so a daemon-wide diff would misreport
 * a parallel peer's container as a leak. The check is scoped to THIS
 * worker's testcontainers session id; Ryuk is disabled for this worker so
 * its session id is unique to the file — without that, testcontainers reuses
 * one suite-wide reaper (and therefore one session id) for every worker and
 * the scoping collapses back to a daemon-wide diff.
 */
// Must be set before this worker's first container creation (module scope).
process.env['TESTCONTAINERS_RYUK_DISABLED'] = 'true';

const POSTGRES_IMAGE = 'postgres:17.5-alpine';

describe('testkit infrastructure lifecycle (R1-07)', () => {
  it('stops Postgres when Valkey fails to start; nothing is leaked', async () => {
    const client = await getContainerRuntimeClient();
    // Every container started by THIS worker process is labeled with its
    // session id — peers in other workers carry different ids (see header).
    const sessionId = (await getReaper(client)).sessionId;
    const postgresIds = async (): Promise<string[]> =>
      (await client.container.list())
        .filter(
          (container) =>
            container.Image === POSTGRES_IMAGE &&
            container.Labels?.[LABEL_TESTCONTAINERS_SESSION_ID] === sessionId,
        )
        .map((container) => container.Id);
    const before = new Set(await postgresIds());

    let started: StartedInfra | undefined;
    let failure: unknown;
    try {
      started = await startTestInfra({
        valkeyCommand: ['valkey-server', '--no-such-option'],
      });
    } catch (error) {
      failure = error;
    }
    await started?.stop();

    if (started !== undefined) {
      expect.unreachable('an invalid valkey flag must make startTestInfra reject');
    }
    expect(failure).toBeInstanceOf(Error);

    const leftover = (await postgresIds()).filter((id) => !before.has(id));
    expect(leftover).toEqual([]);
  }, 120_000);
});
