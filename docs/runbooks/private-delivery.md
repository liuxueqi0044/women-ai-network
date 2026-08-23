# PVL private-delivery runbook

`private-delivery` jobs are opaque wake-ups only. PostgreSQL deliveries and
leases remain authoritative. If Valkey is unavailable, a queued row remains
recoverable and replaying the same idempotency key can wake it again; do not
delete queue jobs manually.

Expired leases are reclaimed with `FOR UPDATE SKIP LOCKED`. A stale lease
token cannot complete or cancel a newer lease. Inspect `attempts`,
`last_error_code`, connection state/epoch, and the notification outbox as one
unit. Terminal cancelled deliveries are never revived.

Deploy a new active AES key while retaining old key ids in the keyring. GCM
authentication or content-schema failures are tamper signals: fail closed and
preserve ciphertext for review. Evidence snapshots are encrypted append-only
legal-hold records for ordinary hide/withdraw; this implementation does not
claim survival across account-erasure cascades.

Verification commands: `pnpm test:pvl:unit`, `pnpm test:pvl:contracts`,
`pnpm test:pvl:migration`, `pnpm test:pvl:integration`, and
`pnpm test:pvl:privacy`. Notification payloads must contain opaque ids only,
never title, body, metadata, or pen name.
