# Runbook — Local Development (FND-01)

This runbook is written for **Windows 11 + PowerShell** (also works in Git
Bash). All commands are copy-paste ready.

## Prerequisites

| Tool           | Version         | Check                                           |
| -------------- | --------------- | ----------------------------------------------- |
| Node.js        | `>=22.23.2 <23` | `node --version`                                |
| pnpm           | `11.18.0`       | `pnpm --version`                                |
| Docker Desktop | recent          | `docker --version` and `docker compose version` |

Docker Desktop must be **running** (Linux containers) before the
integration/e2e steps.

## First-time setup

```powershell
cd women-ai-network
pnpm install --frozen-lockfile
Copy-Item .env.example .env   # optional: defaults already match compose.yaml
```

> If `pnpm install` fails with an `ERR_PNPM_OUTDATED_LOCKFILE`, the lockfile
> and package.json disagree — fix the manifest, never `--no-frozen-lockfile`.

## Start the infrastructure (Postgres + Valkey)

```powershell
docker compose up -d --wait
docker compose ps          # both services must show (healthy)
```

Ports: Postgres `5433`, Valkey `6380` (mapped to avoid conflicts with local
installs). Data lives in **project-scoped** named volumes — with the default
project name (`women-ai-network`, the directory name) they are
`women-ai-network_pgdata` / `women-ai-network_valkeydata`.
compose.yaml deliberately sets no top-level `name:`, no `container_name:` and
no global volume `name:`, so every resource is scoped by the Compose project.
Reset everything with:

```powershell
docker compose down -v
```

### Running several workspaces in parallel

Several copies of this repo (or a CI runner) can run on one machine at the
same time: each gets its own containers, network and volumes
via the Compose project name, and its own host ports via `.env`. **Never run
`docker compose down -v` without `-p`** — it would stop the default project
and could destroy volumes another workspace relies on.

```powershell
# First workspace (its own .env with the ports below)
docker compose -p wai-dev-a up -d --wait
# Second workspace, in its own directory with its own .env
docker compose -p wai-dev-b up -d --wait
# Tear down only ONE project (never without -p):
docker compose -p wai-dev-a down
```

Each workspace's `.env` sets distinct host ports (also usable as one-shot
overrides):

```powershell
# wai-dev-a .env
POSTGRES_HOST_PORT=15433
VALKEY_HOST_PORT=16380
# wai-dev-b .env
POSTGRES_HOST_PORT=25433
VALKEY_HOST_PORT=26380
```

The same works with `COMPOSE_PROJECT_NAME` instead of `-p` (in `.env` or the
shell), e.g. `$env:COMPOSE_PROJECT_NAME = 'wai-dev-a'`.

## Run the apps

Three terminals (or `pnpm dev` to run all in parallel):

```powershell
pnpm --filter @wai/api dev      # http://127.0.0.1:3100  (OpenAPI: /v1/docs)
pnpm --filter @wai/worker dev   # BullMQ consumer, logs to stdout
pnpm --filter @wai/web dev      # http://127.0.0.1:3000
```

Check the vertical smoke in the browser:

1. Open `http://127.0.0.1:3000/health` — shows API readiness, an accepted
   foundation trace, and the Request ID / trace ID used for both calls.
2. Watch the worker terminal: the `foundation.trace.processed` line carries
   the **same** `request_id` and `trace_id`.
3. `http://127.0.0.1:3100/v1/docs` serves the OpenAPI document (non-production
   only — gated by `ENABLE_OPENAPI` in production).

## Verification commands (self-check order)

Run from the repo root, infrastructure up:

```powershell
pnpm install --frozen-lockfile
docker compose config --quiet
docker compose up -d --wait
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test              # unit + contract suites (builds packages first)
pnpm test:contracts
pnpm test:integration  # needs Docker Desktop (Testcontainers)
pnpm build
pnpm test:e2e          # builds web/api/worker, starts them via Playwright
pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org
pnpm licenses list --prod --json
git diff --check
git status --short
```

All must exit with code `0`. `test:integration` spins up its own containers
(random ports, `wai_test_valkey` password) and always tears them down — you
do not need compose for it, only the Docker daemon.

The audit line above uses the npmjs registry explicitly. Dependency advisories
change over time, so report the current command output rather than copying a
historical vulnerability count into release notes.

## Troubleshooting

| Symptom                                     | Fix                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up -d` port conflict        | Free ports 5433/6380, or override `POSTGRES_HOST_PORT` / `VALKEY_HOST_PORT` in `.env`                                                                 |
| `/v1/health/ready` reports `degraded`       | `docker compose ps` — wait for `(healthy)`; check `docker compose logs postgres valkey`                                                               |
| Worker never processes                      | Valkey password mismatch: `.env` `VALKEY_URL` must match compose (`wai_dev_valkey_9q2x`)                                                              |
| `pnpm test:e2e` fails to start API          | The Playwright `webServer` reads the repo-root `.env`; stop any dev server already holding `:3100`/`:3000` first                                      |
| `ERR_OSSL_EVP_UNSUPPORTED` or engine errors | Wrong Node: must be `>=22.23.2 <23`                                                                                                                   |
| Integration test "timed out waiting for…"   | Docker daemon slow on first image pull; rerun once — images are cached after                                                                          |
| Log lines show `[REDACTED]`                 | That is the redaction layer working (see ADR 0001 §D5) — do not "fix" it                                                                              |
| `pnpm install` warns about `cpu-features`   | Optional native module (ssh2 build dependency) without a Windows prebuild; the install still exits `0` and nothing in FND-01 uses it — safe to ignore |
| `pnpm audit` reports an advisory            | Confirm the affected dependency and execution path, then record or remediate it explicitly; do not silently suppress it                               |

## Environment variables

See `.env.example` for the full list. Highlights:

- `DATABASE_URL`, `VALKEY_URL` — dev defaults match compose; **production
  rejects these defaults at startup** (fail fast).
- `POSTGRES_HOST_PORT` / `VALKEY_HOST_PORT` — compose host ports (defaults
  `5433` / `6380`); the only way to run two workspaces in parallel.
- `COMPOSE_PROJECT_NAME` — alternative to `docker compose -p` for scoping
  containers/volumes to one workspace.
- `CORS_ORIGINS` — comma-separated origins; `*` is rejected in production.
- `ENABLE_OPENAPI` — `true`/`false` only; in production OpenAPI is off
  unless this is explicitly `true`.
- `OTEL_ENABLED` / `OTEL_EXPORTER` (`console` | `otlp`) /
  `OTEL_OTLP_ENDPOINT` — tracing is optional; the `traceparent` header flows
  regardless.
- `LOG_PRETTY=true` pretty-prints logs (development only — rejected in
  production).

## CI

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs the quality,
integration, browser, staging-package, security, and SBOM gates on GitHub.
Local verification remains the fastest pre-push signal.
