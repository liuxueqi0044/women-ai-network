# ADR 0014 — manual-first onboarding and optional provider drafts

Status: proposed for ONB-01 R1 review.

Onboarding is an account-scoped state machine. The member selects relationship
modes, answers questions, edits any suggested criteria, and explicitly confirms
the resulting preference set. Dating is a separate mode and requires both a
session selection and a confirmation payload; ELG is evaluated again before every
final write.

Answer revisions, proposal payloads, corrections and preference values use the
existing AES-256-GCM/key-id primitives. The preference table stores only a
purpose-bound normalized projection (criterion, strength and deal-breaker flag)
for future bounded discovery; values remain encrypted. Provider adapters receive
only a minimized in-process prompt after provider/retention consent. The
production default is an unavailable adapter, so manual onboarding remains fully
usable and provider work fails closed on account disable or consent withdrawal.

The repository serializes idempotent preference results with a stable snake-case
JSON schema and restores `confirmed_at` to a `Date` at the boundary. Final
mutations lock the IAM account row, and proposals/corrections are purpose,
session, mode, answer-revision and modes-version scoped. Correction appends an
encrypted, corrected pending proposal rather than mutating the old proposal.

AI output is a short-lived editable proposal. It cannot confirm identity, age,
gender, membership, Dating, connections, notifications or publication.

R2 closes the idempotency and dispatch boundaries. Frozen mutation responses
are AES-GCM encrypted with the existing key-id/nonce format and are restored
through strict response schemas, including `Date` conversion at the repository
boundary. The only searchable preference data is a closed, mode-bearing
projection; full values and replay responses never occupy JSON columns.
Provider dispatch locks the IAM account and exact receipt row through the final
check and adapter handoff. A previously-started external call is not claimed
to be cancellable. Dating is rejected at the provider boundary, and prompt
minimization conservatively drops a whole answer containing identity, age,
document, evidence, numeric, Dating, or reviewer-canary content.
The web resume endpoint reads current server state after authentication; local
storage is limited to non-sensitive UI choices and never stores an answer,
proposal, preference value, session identifier, or consent receipt.

R3 lifecycle and capacity decisions:

- `closeApiApp` lets Nest's `HealthService` close the database, cache, and
  foundation queue, then closes the media, private-delivery, and translation
  queues exactly once. This ownership split prevents BullMQ reconnect loops
  after Valkey teardown while preserving normal `app.close()` behavior.
- Provider dispatch is bounded to two concurrent handoffs on the shared
  ten-connection pool. A third request fails fast with 503; each account is
  also rate-limited to five extractions per minute and each adapter call has a
  ten-second timeout. The lock is held until the external handoff starts; an
  already-started external call is not represented as cancellable.
- The browser uses an active-mode server state, not a first-selected array
  entry. Empty manual edits preserve the server's current mode projection,
  while Dating remains manual-only and requires the two explicit selections.
  The real runner builds with a configurable non-default API/Web port pair,
  starts isolated Testcontainers, and drives credentialed CORS with no route
  mocks.
