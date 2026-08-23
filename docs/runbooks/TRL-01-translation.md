# TRL-01 translation operations

Run `pnpm test:trl:unit`, `pnpm test:trl:contracts`, and
`pnpm test:trl:migration` before operating a deployment. A translation wake-up
contains only `{task_id}`; workers claim a PostgreSQL lease and re-authorize
the source before and after provider execution. A stale lease token cannot
complete or fail a newer lease.

The worker reconciler first reaps expired PostgreSQL leases. An expired lease
is moved transactionally to `retry_wait` (or terminal `failed` when the
attempt cap is reached) and receives a durable `retry_wakeups` row before any
queue hint is published. A normal claim never bypasses this reaper by taking
an expired `leased` row directly. BullMQ/Valkey is therefore only a wake-up
accelerator; restarting the worker and running the reconciler recovers the
database-owned task even when the previous process died after claiming it.

Provider outages leave the canonical letter readable. Inspect only task IDs,
states, hashes, and error codes in logs. Never log source text, provider
payloads, decrypted results, consent statements, or queue bodies.

Key rotation keeps old translation key IDs in the read keyring until all
results have been re-encrypted. Removing an old key intentionally makes those
results unreadable while the canonical source remains available.
