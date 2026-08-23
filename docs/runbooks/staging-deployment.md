# Portable staging deployment

This package starts PostgreSQL, Valkey, OPA, migration, API, worker and Web from one repository.
It does not require a domain, paid provider or cloud account. It also does not enable payments,
circle group transport or image uploads.

## Prerequisites and first start

Use Node 22, pnpm 11.18 and a current Docker Desktop/Compose. Install the browser once with
`pnpm --filter @wai/web exec playwright install chromium`.

```text
pnpm install --frozen-lockfile
pnpm staging:env
pnpm staging:preflight
pnpm staging:deploy
pnpm staging:smoke
```

`staging:env` creates ignored `deploy/staging.env` with independent random database, Valkey, IAM,
PII, Safety Vault and backup keys. It never prints them. It refuses to overwrite an existing file
unless `--force` is deliberately passed. `staging:preflight` rejects placeholders, fake production
adapters, wildcard CORS, insecure cookie settings, malformed keys and incomplete media providers.

Web is exposed only on `127.0.0.1:13000`; API is exposed only on `127.0.0.1:13100`. Database,
Valkey and OPA remain on the private Compose network. Images run as the unprivileged `node` user,
services use pinned dependency images, and the one-shot migrator must finish before API/worker start.

The portable stack runs production process settings, including Secure session cookies. Its plain
localhost ports are therefore for build, health, migration and operational smoke—not manual login.
The automated UAT runner uses isolated non-production origins to exercise login safely. Once a real
domain is available, terminate TLS at the reviewed ingress and use the production origin contract.

## Media-disabled launch mode

`MEDIA_UPLOADS_ENABLED=false` is a supported fail-closed production state. API and worker boot, but
media calls return unavailable and no fake storage, scanner, sanitizer or reviewer is selected. To
enable images, configure the complete HTTPS S3-compatible, ClamAV and Doubao settings, rotate the Ark
key that was previously pasted into chat, run `pnpm test:media:providers`, then change the switch.

## Encrypted backup, migration and restore

```text
pnpm staging:backup
pnpm staging:migrate
pnpm staging:restore -- --input=backups/wai-TIMESTAMP.dump.enc \
  --confirm-overwrite=wai-staging
```

Backups are PostgreSQL custom archives encrypted with AES-256-GCM. The adjacent manifest records the
ciphertext checksum, byte count, source project and Git SHA without secrets. Plaintext temporary
archives are removed in `finally` paths. `staging:migrate` always creates an encrypted recovery point
first. Restore verifies the manifest and authenticated encryption, requires the exact project name
before overwriting a non-empty database, stops application writers, restores, reapplies current
migrations and restarts health-checked services.

For disaster recovery into a replacement Compose project, also pass the manifest's exact source as
`--accept-source-project=<source>`. Backup inputs and outputs are restricted to the workspace
`backups/` directory.

## Rollback and cleanup

`pnpm staging:deploy` records current and previous immutable image tags in ignored
`deploy/staging.release.json`. `pnpm staging:rollback` restores the previous API/worker/Web images
without destructively downgrading the database; pass `-- --tag=<known-tag>` when no previous release
is recorded. Use the encrypted pre-migration recovery point when data rollback is necessary.

To inspect state, use `pnpm staging:status`. Manual teardown must always name this exact file/project:

```text
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yaml -p wai-staging down
```

Add `-v` only when the staging database and Valkey data are intentionally disposable and a verified
backup exists.
