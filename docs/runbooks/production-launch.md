# Production launch readiness

This is the pre-deployment checklist for the free product. Payment and group
chat are explicitly deferred. A checked configuration template is available at
`deploy/production.env.template`; it contains placeholders, never credentials.

## Recommended domain layout

Use one registrable domain so credentialed browser requests remain same-site:

- `https://app.example.com` — Next.js Web;
- `https://api.example.com` — API, with `NEXT_PUBLIC_API_BASE_URL` set to
  `https://api.example.com/v1` at Web build time;
- `https://media.example.com` — private S3-compatible endpoint/CDN origin for
  signed media only;
- internal-only PostgreSQL, Valkey, OPA and ClamAV endpoints.

Create DNS records only after the hosting targets exist. Enforce TLS 1.2+,
redirect HTTP to HTTPS, configure certificate renewal and keep Web/API under
the same eTLD+1. Set API `CORS_ORIGINS` to the exact Web origin and enable
credentialed CORS. Object-store CORS must allow the exact Web origin, `PUT`,
`GET`/`HEAD`, and only the headers used by signed uploads. Never use `*` in
production.

## Supplier decisions

| Capability             | Current implementation                    | Production action                                                    | Launch impact                      |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| Web/API/worker hosting | portable images/Compose staging package   | choose region, scaling and private network                           | blocking for public launch         |
| Domain/DNS/TLS         | config contract and layout ready          | buy/assign domain and point DNS after hosting                        | blocking                           |
| PostgreSQL 17          | real integration coverage                 | managed PG, PITR backups, restore drill                              | blocking                           |
| Valkey/Redis           | BullMQ/session infrastructure             | managed private TLS service                                          | blocking                           |
| OPA                    | pinned policy runtime                     | private service with health/alerting                                 | blocking                           |
| Object storage         | S3-compatible adapter; fail-closed switch | private managed buckets, CORS, lifecycle, separate credentials       | deferred while photos disabled     |
| Malware scan           | real ClamAV proven locally                | private scanner service and signature update monitoring              | deferred while photos disabled     |
| Visual content review  | Doubao Ark adapter implemented            | rotate key, visual endpoint, DPA/retention review, real smoke        | blocking only for photo publishing |
| Identity verification  | fail-closed provider port only            | select and integrate reviewed provider                               | blocking for verified membership   |
| Email/push delivery    | durable outbox, no production adapter     | choose provider or launch in-app-only with explicit product approval | conditional                        |
| Translation/AI drafts  | provider-neutral, unavailable fallback    | optional provider and consent review                                 | not blocking manual/free flow      |
| Payments               | intentionally absent                      | later module and separate compliance review                          | not in this launch                 |
| Group chat             | intentionally absent                      | later messaging/circle transport module                              | not in this launch                 |

## Security and operations before go-live

1. Rotate every credential ever pasted into chat or a ticket. Store all secrets
   in the hosting secret manager; keep them out of images, `.env` files, build
   logs and client bundles.
2. Generate independent IAM pepper, PII AES keyring and Safety Vault AES key.
   Document key rotation and old-key decryption retention.
3. Run all migrations on a restored production-like snapshot, then a no-op
   rerun. Take a pre-migration backup and test restore.
4. Keep PostgreSQL, Valkey, OPA and ClamAV private. Restrict API/worker egress to
   approved providers and object storage.
5. Configure structured-log redaction, metrics, traces, uptime checks, queue
   depth/lease alarms, provider error-rate alarms and on-call ownership.
6. Add retention/deletion schedules for quarantine, clean media, provider
   artifacts, audit records and backups. Test account erasure and legal hold.
7. Publish privacy policy, terms, community rules, content appeal path, data
   export/deletion contact, age/jurisdiction policy and provider disclosures.
8. Complete accessibility, mobile-browser and real production-origin smoke;
   test registration, verification, profile/avatar, letters, connections,
   messaging, circles, blocking/reporting and notification recovery.
9. Use a staged rollout with seeded test accounts, low provider quotas and a
   kill switch for uploads/provider calls. Do not bypass fail-closed gates to
   make a demo pass.

The provider-independent local deployment, encrypted backup/restore, guarded
migration, health smoke and image rollback procedures are in
`docs/runbooks/staging-deployment.md`. The desktop/mobile acceptance matrix is
in `docs/uat/launch-uat.md`.

## Media provider acceptance

The local provider smoke must report `storage`, `browserCors`, `clamavClean`
and `clamavEicar` as `pass`. The Doubao result may be `skipped` until a newly
rotated secret is injected. Before photo publishing is enabled in production,
the same smoke must run against an HTTPS object-store URL with
`MEDIA_DOUBAO_SMOKE=true` and report `doubao: allow` for the safe fixture.
