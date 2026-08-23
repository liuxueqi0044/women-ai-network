# ADR-0007 — CON-01 explicit consent graph

## Decision

CON-01 owns a PostgreSQL `connection.connections` graph. Account pairs are
canonicalized (`account_a < account_b`) and only one pending/accepted epoch may
exist at a time. Terminal epochs remain immutable history; after the seven-day
cooldown a new explicit request may create a new epoch.

Requests and accepts recheck the composite InteractionGate: both community
access decisions, the ELG two-party partition decision and the symmetric
active-block SAF decision. Decline, cancel and disconnect are safety-escape
transitions: they require session ownership and a valid current state, but do
not require the peer to remain eligible or the policy providers to be
available. The gate is synchronous and never trusts queue, cache or client
state.

An accepted edge is invalidated by any later safety block through a PostgreSQL
trigger. Revoking the block cannot restore the prior edge; only a new request
and explicit recipient acceptance can create a new edge after cooldown.

## Consequences

- Profile relationship reads use the real connection graph adapter.
- Reciprocal requests serialize on a pair advisory lock and idempotency is
  owner/operation/key scoped with payload conflict detection.
- A rate limiter is required for the account and pair request dimensions;
  the default production-less adapter fails closed.
- Connection bodies and errors contain no policy, age, membership or block
  direction details.
- CON consumes SAF's active-block decision only. SAF reports, evidence and
  operator action execution remain owned by SAF and are not claimed by this
  graph module.
