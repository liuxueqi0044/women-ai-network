# ADR-TRL-01: Revision-bound derived translations

Translation is a derived, provider-neutral projection. LTR remains the only
canonical source: a job stores immutable revision identity (letter, revision
UUID/number, source hash, and locales), while PostgreSQL owns task state,
idempotency, encrypted result bytes, leases, and consent. Queue messages carry
only an opaque task UUID.

Every request rechecks the LTR publication/owner snapshot, community,
partition, and SAF decision. Private translation requires a consent bound to
the exact revision/hash/provider and an explicit no-training capability.
Provider output is a strict plain-text schema with target-locale and schema
version; malformed or instruction-like output is failed closed. Original
content is returned when no provider is configured and is never overwritten.

Lease recovery is PostgreSQL-authoritative. A worker reconciler reaps expired
leases under row locks, applies the existing bounded retry backoff and attempt
cap, and writes a durable wake intent before queue delivery. Expired leased
rows are not directly claimable, so a stalled BullMQ job cannot bypass that
backoff or create an extra business attempt.
