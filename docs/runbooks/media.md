# MED-01 secure media runbook

Media is always uploaded to the private quarantine store. The API creates an
authenticated, expiring upload intent; completion performs a server-side stat,
bounded read, hash and magic check. A worker then claims the PostgreSQL job with
a random lease token, scans with ClamAV, fully decodes and re-encodes with
sharp/libvips, writes the clean rendition, and atomically publishes `clean`.

Only a `clean` asset with a clean rendition and a fresh authorization decision
can receive the one-minute opaque access capability. Tokens, object keys,
original names, EXIF/GPS, bytes and provider errors are not logged or persisted.

Production must configure real storage, scanner, sanitizer and content-review
adapters. The S3-compatible storage adapter supports separate quarantine and
clean clients; ClamAV is used for malware detection; sharp/libvips performs the
decode/re-encode; and Doubao/Volcengine Ark performs the final, narrow visual
content classification. `MemoryMediaStorage`, `DeterministicMalwareScanner`
and `AllowAllMediaContentModerator` are test/dev-only and production startup
rejects them.

The Doubao boundary is deliberately narrow. It may classify sexual content,
sexualized minors, graphic violence, self-harm, hate/extremism, illegal goods,
personal documents, and contact/QR spam. It must not infer identity, gender,
age, ethnicity, nationality, health, disability, religion, sexual orientation,
attractiveness, relationship intent, or membership eligibility. Identity and
membership remain VER/ELG decisions. A model outage, malformed response, prose
response, unknown reason code, or timeout is `unavailable` and fails closed.

Doubao receives only a short-lived signed HTTPS URL for the sanitized clean
rendition. Buckets remain private. Confirm data region, retention/no-training
terms and cross-border transfer requirements with legal/procurement before a
production key is enabled.

## Local provider smoke

```powershell
$env:MINIO_API_HOST_PORT='19000'
$env:MINIO_CONSOLE_HOST_PORT='19001'
$env:CLAMAV_HOST_PORT='13310'
docker compose -p wai-media-smoke --profile media up -d

# Point MEDIA_S3_* and CLAMAV_* at those ports, then:
pnpm test:media:providers
docker compose -p wai-media-smoke --profile media down -v
```

The smoke performs a real presigned browser CORS preflight, upload/download,
private-bucket stat/read, clean ClamAV scan and EICAR detection. Doubao is
skipped by default. After rotating an exposed key, inject the new key through a
secret manager or local process environment (never `.env.example` or chat),
set an Ark endpoint that supports image input, use an HTTPS object-store URL,
and opt in with `MEDIA_DOUBAO_SMOKE=true`.

Operational checks:

- inspect `media.processing_jobs` for queued/retryable jobs and expired leases;
- reclaim only through `claimJob`, which changes the lease token atomically;
- never manually mark an asset `clean`; the DB trigger rejects skipped states;
- legal-held assets are terminal and ordinary delete is refused;
- quarantine and clean object stores use separate credentials/prefixes;
- object-store CORS allows only the Web origin and required methods/headers;
- Doubao egress is limited to the Ark API and receives a short-lived clean URL;
- rotate/revoke provider keys without committing them or logging them;
- run `pnpm test:med:unit`, `test:med:contracts`, `test:med:migration`,
  `test:med:integration`, `test:med:security`, and the provider smoke before
  deployment.

## Dependency and license note

`sharp@0.35.3` is pinned in `apps/worker/package.json` for actual libvips
decode/re-encode and metadata stripping (Apache-2.0; its bundled libvips is
LGPL-3.0-or-later). `minio@8.0.7` (Apache-2.0) is the mature S3-compatible JS
client; the development object store is pinned Community MinIO and production
may use a reviewed S3-compatible managed service. Existing `pg`, `zod`, Nest
and BullMQ dependencies retain their repository-pinned licenses. ClamAV is an
external runtime service. Alternatives considered were ImageMagick (larger
attack surface), a bespoke S3 signer (unnecessary security risk), and a remote
malware SaaS (would disclose quarantine bytes); none is used.
