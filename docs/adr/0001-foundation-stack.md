# ADR 0001 — FND-01 Foundation Stack

- Status: accepted
- Date: 2026-08-15
- Deciders: FND-01 implementation engineer (Claude Code, DeepSeek model)
- Scope: engineering foundation only — no business features

## Context

The Women AI Network needs a production-shaped engineering foundation before
any business module can be built: a typed monorepo, two services plus a
worker, shared contracts, structured observability, containerized local
infrastructure, and CI gates. FND-01 must prove the Web → API → Queue →
Worker vertical with a single correlation id, without any business tables,
auth, or external providers.

## Decisions

### D1. pnpm workspace + Turborepo monorepo (TypeScript, CommonJS)

- `packageManager: pnpm@11.18.0` is pinned in `package.json`; every
  dependency version is exact (no ranges) and the lockfile is the source of
  truth (`--frozen-lockfile` in CI).
- Turbo provides build/typecheck caching with explicit outputs.
- CommonJS throughout (NestJS default, Next.js-compatible); internal imports
  use explicit `.js` extensions so emitted code runs unchanged.
- TypeScript 5.8 with `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`. Optional props are never written as
  `undefined`; index access is always null-checked.

### D2. Next.js App Router (Web), NestJS + Fastify (API), NestJS standalone (Worker)

- Web (`:3000`) is server-rendered only, no brand design: `/` describes the
  foundation, `/health` renders live API status + correlation Request ID.
- API (`:3100`) uses Fastify through the NestJS adapter (fast startup,
  light `inject` testing). All routes are under `/v1`. Error responses use a
  single envelope `{code, message, details?, request_id}` from
  `packages/contracts`; the `x-request-id` header is accepted (UUID v4) or
  generated, and echoed on every response.
- Worker is a NestJS standalone application context with a BullMQ worker
  (no HTTP listener). Job names are whitelisted; unknown names are logged
  loudly and skipped.
- OpenAPI 3.0.3 is generated from the Zod contracts (zod-to-openapi) and
  served only in non-production (production requires the explicit
  `ENABLE_OPENAPI=true` switch).

### D3. BullMQ on Valkey for the queue; Postgres for the database

- Valkey is the Redis-compatible cache/queue store; local dev creds are
  non-default (`wai_dev_valkey_9q2x`) and production rejects dev defaults.
- The BullMQ job id equals the envelope `event_id`, giving queue-level
  deduplication. On top of that, the worker claims event ownership via a
  Valkey `SET NX EX` before running any side effect — a retry of an already
  processed event logs a skip and does nothing.
- Foundation jobs retry with exponential backoff (attempts: 3); processor
  failures propagate to BullMQ (never swallowed) and land in the failed set.
- A short-lived result record (TTL 86400s by default) is stored in Valkey
  purely for the FND-01 smoke verification; it is not a business artifact.

### D4. Zod contracts as the single source of truth

- `packages/contracts` holds every cross-boundary shape (health, error
  envelope, foundation trace, job envelope, ids) with `.strict()` schemas,
  run-time validation and static types from one definition.
- The API validates request bodies with a Zod pipe and parses its own
  responses through the same schemas; the worker parses job payloads with
  `jobEnvelopeSchema`; the Web client parses every API response.
- Contract tests in `packages/contracts` cover invalid payloads.

### D5. Pino with deep redaction + W3C traceparent as the trace source of truth

- `packages/observability` wraps Pino with a recursive sanitizer: 16 key
  families (authorization, cookie, set-cookie, password, token,
  access_token, refresh_token, secret, email, phone, document, id_number,
  message_body, prompt, precise_location, …) are replaced with
  `[REDACTED]`, matched case-insensitively and separator-insensitively, at
  any nesting depth. Redaction is key-based; content is not scanned.
- An `AsyncLocalStorage` request context merges `request_id`/`trace_id`
  into every log line; context always wins over caller-supplied fields.
- The W3C `traceparent` string is the single cross-process trace source of
  truth (Web → API → Queue → Worker), independent of the OpenTelemetry SDK
  being on or off. When enabled, OTel consumes the same header via
  `W3CTraceContextPropagator`.

### D6. Testcontainers for integration; Vitest workspaces for unit/contract tests

- Integration tests run the real API and Worker in-process against real
  Postgres/Valkey containers (`postgres:17.5-alpine`, `valkey/valkey:8.1.1-alpine`),
  the same pinned images as compose.yaml. Containers are always stopped in
  `finally`.
- Unit tests use fakes (silent/capturing loggers, fake adapters); adapter
  interfaces keep business code free of vendor SDKs.
- E2E uses Playwright against a built Next.js app; the API and Web are
  started by the Playwright `webServer` entries.

### D7. Docker Compose with pinned images, healthchecks, named volumes

- `compose.yaml` pins image tags, defines healthchecks (pg_isready,
  valkey-cli ping), named volumes, and host ports 5433/6380 so local
  development never collides with host Postgres/Valkey instances.
- Env overridable, safe defaults documented in `.env.example`.

### D8. CI gates: quality, integration, e2e, security

- Format, lint, typecheck, unit, contract, build; integration against
  containers; e2e with compose + Playwright (separate job); dependency
  audit, gitleaks secret scan, cdxgen SBOM — each with an explicit failure
  policy (fail on high+ vulnerabilities, on any detected secret, on SBOM
  generation failure).
- All actions are pinned to commit SHAs; the workflow token has minimal
  permissions (`contents: read`); Node 22.23.2 and pnpm 11.18 are fixed.

## Consequences

- Adding a business module means extending `packages/contracts` first — the
  contracts are the integration contract between Web, API and Worker.
- Every new dependency must be pinned, justified, and survive
  `pnpm audit --prod --audit-level high`.
- Correlation ids are mandatory end to end: any new job must carry the
  envelope fields and be consumed idempotently (claim before side effect).
