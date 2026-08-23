# ADR-0013: PostgreSQL candidate recall with synchronous final gates

Status: proposed for principal review

The world shelf stores a minimal PostgreSQL projection populated when a public
publication is created. PostgreSQL FTS and `pg_trgm` only recall bounded raw
candidates; the repository joins the current publication, revision, source hash,
enabled author account and published state. The API applies a dedicated discovery
gate for each author: current community membership/verification, current ELG
credential and policy partition, and SAF block state. It does not require an
accepted connection. A final current-publication recheck runs immediately before
returning or mutating, so withdrawals, blocks, member expiry and policy changes
cannot be bypassed by stale index rows. Cursors are HMAC signed and bind viewer,
normalized filters, algorithm version, as-of timestamp, raw boundary and expiry.

Bookmarks use `(viewer_id, publication_id)` as the durable owner boundary and an
optional owner-scoped idempotency record. No popularity score or public count is
stored or returned.

The final PostgreSQL recheck (or the bookmark `INSERT ... SELECT` statement) is
the operation's linearization point: it is the point at which current
publication/revision/hash, enabled accounts and the viewer/owner SAF block
predicate are evaluated. A state change committed after that statement can
still race the response or a later read; this design promises no stale row at
the statement point, not an impossible zero-time post-commit window.

Raw recall is deliberately bounded. The repository uses at most 120 candidates
(the normal `limit=20` path uses at most 80, while larger requests cap at 120),
and the service scans that ordered look-ahead until a diversity-capped page is
filled. This preserves bounded database/authorization cost and never falls
back to offset or unbounded scanning.

Content locales intentionally use the shared canonical-casing grammar from
LTR/TRL: lowercase language, optional title-case script, and optional uppercase
alpha-2 or numeric-3 region, capped at 32 characters. Extensions, variants,
private-use tags, and CLDR/IANA registry alias canonicalization are out of
product scope; this is not a claim to implement the complete BCP-47 registry.
