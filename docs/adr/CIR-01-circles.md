# ADR: CIR-01 bounded circles

Status: implementation checkpoint; independent acceptance remains required.

CIR owns circle state, membership admission, encrypted notes, immutable audit, and a durable opaque notification handoff. The API only obtains the actor from the authenticated session. IAM, VER, ELG, SAF, CON, and NTF remain authorities for their own state; a narrow CIR GrowthGate composes current authority snapshots and fails closed on missing or stale evidence.

Circle writes use deterministic advisory locking and payload-bound idempotency. A circle is never a feed: note pagination is chronological keyset pagination with a bounded page and signed actor/filter cursor. NTF receives an invitation-id resource and the closed role parameter only after the circle transaction commits; delivery failure cannot roll back circle correctness.

## Existing infrastructure and open-source reuse

- PostgreSQL remains the only authority for Circle state, locks, encrypted
  records, audit and the durable handoff; no secondary store is introduced.
- Existing Valkey/BullMQ notification wakeup/reconciliation is reused only as
  a delivery mechanism. The worker receives opaque IDs and rechecks the NTF
  resource gate before delivery.
- Description, join message and note encryption use the existing AES-256-GCM
  keyring and historical-key decryption helpers; CIR adds no cryptographic
  primitive.
- IAM/VER/ELG/SAF and the NTF resource-gate contract remain the owning
  authorities. CIR's transaction composition is product-domain logic needed to
  bind a Circle mutation to the same PostgreSQL authority snapshot; it is not
  a replacement authorization framework.
- Signed cursor envelopes reuse the existing HMAC helper. Their Circle/surface
  binding is domain-specific pagination state, not a new cursor dependency.

No runtime dependency is added by CIR-01.

## R1 vocabulary, scope and report escape

Topic catalog v1 is closed and versioned. Future vocabulary additions require a
new catalog version and migration/contract review, never a free-text label.
Scope is only `online`, ISO country, or normalized city label under an ISO
country; CIR has no exact-address or coordinate field. Detail and pending
join-request plaintext is decrypted only after its final role/growth gate.

SAF remains the evidence-vault authority. CIR registers opaque `circle` and
`note` targets and supplies only target/version/lifecycle-or-moderation
metadata. Historical membership binds the report escape path so a later block
or revocation cannot erase it. An active member may report notes visible in
the circle's chronological history; after `left` or `removed`, that exception
is bounded to notes created no later than the terminal membership timestamp.
No body ciphertext or plaintext leaves CIR.

## R2 integrity boundaries

Content AES keys encrypt/decrypt private fields only. Cursors, idempotency and
opaque handoff HMACs derive from IAM's stable secret pepper, so a content-key
rotation cannot duplicate a write or invalidate a valid cursor. Nullable patch
location/description fields mean explicit removal; the repository validates the
fully merged state before SQL. `0019` downgrade retains append-only SAF
circle/note evidence using the prior report vocabulary as `NOT VALID`, which
blocks new retired targets without rewriting old evidence; re-up restores the
expanded valid check.

Circle durable-row erasure guards never trust session GUCs. They distinguish
direct SQL from database-maintained foreign-key cascade trigger depth and keep
ordinary direct deletes/actor rewrites rejected.
