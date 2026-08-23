import { GenericContainer, Wait } from 'testcontainers';

/**
 * Containerized OPA for eligibility integration tests.
 *
 * - Image pinned to the same version as compose.yaml (1.17.0-static — never
 *   `latest`).
 * - The policy directory is bind-mounted read-only; the static image has no
 *   shell and cannot write anything anywhere.
 * - Readiness waits on BOTH the server log line and an HTTP GET of
 *   /v1/data/eligibility — 200 is only returned once the policy packages
 *   actually resolved, so tests never race a half-loaded engine.
 */

// Keep in sync with compose.yaml.
const OPA_IMAGE = 'openpolicyagent/opa:1.17.0-static';
const OPA_PORT = 8181;

export interface StartedOpa {
  baseUrl: string;
  /** Failure-safe cleanup — safe to call twice, never throws. */
  stop(): Promise<void>;
}

export async function startOpaTestContainer(policiesDir: string): Promise<StartedOpa> {
  const container = await new GenericContainer(OPA_IMAGE)
    .withExposedPorts(OPA_PORT)
    .withBindMounts([{ source: policiesDir, target: '/policy', mode: 'ro' }])
    .withCommand(['run', '--server', '--addr', ':8181', '/policy'])
    .withWaitStrategy(Wait.forLogMessage(/Initializing server/i, 1))
    // 200 only once the eligibility packages actually resolved — never race a
    // half-loaded engine.
    .withWaitStrategy(
      Wait.forHttp('/v1/data/eligibility', OPA_PORT)
        .withMethod('GET')
        .forResponsePredicate((body) => body.includes('"result"')),
    )
    .withStartupTimeout(60_000)
    .start();

  const baseUrl = `http://${container.getHost()}:${container.getMappedPort(OPA_PORT)}`;

  let stopped = false;
  return {
    baseUrl,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await container.stop();
    },
  };
}
