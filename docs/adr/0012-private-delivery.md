# ADR 0012: private-letter delivery is a durable, revision-bound snapshot

## Decision

PVL stores one encrypted snapshot per owner-initiated delivery. The sender is
the authenticated session, while recipient, accepted connection id, accepted
epoch/version, letter revision and purpose are server-derived and stored as
immutable identity fields. The queue carries only `delivery_id`; PostgreSQL
claims leases and decides whether a delivery may become `delivered`.

The worker rechecks the accepted connection, safety block state and the shared
interaction policy before completing a lease and again before dispatching the
opaque notification outbox event. A block, disconnect, epoch rollover,
expired lease or stale worker token produces no inbox or notification. Inbox
and sent surfaces are separate actor-bound queries with signed, expiring
cursors.

AES-256-GCM encrypts title, body and metadata with a key id. The keyring keeps
old keys readable during rotation; missing keys, authentication failures and
schema-invalid plaintext fail closed. Evidence capture is append-only and
encrypted; ordinary hide/withdraw changes only the relevant viewer surface and
does not destroy captured evidence. Account erasure remains allowed through
the normal cascade; this implementation claims evidence retention across
ordinary hide/withdraw, not across account erasure.

## Rejected alternatives

- Reading the mutable current letter at delivery time: this would violate the
  explicit revision consent and allow later edits to change a sent message.
- Putting title/body or policy state in BullMQ: queue payloads are observable
  operational data, not an authorization boundary.
- Treating a delivery as a connection or chat message: PVL never creates,
  resurrects or extends a connection and has no follow-up send primitive.
