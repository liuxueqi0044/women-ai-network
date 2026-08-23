# Messaging runbook

Before dispatching a wake, re-read the conversation and exact connection id/epoch through the
InteractionGate. On block, disconnect, policy expiry or account disable, drop the wake and close
the client subscription; clients recover with a signed history cursor. Queue payloads contain only
opaque IDs. Never log decrypted message, letter or AI context. Key rotation is handled by the
existing `key_id` map; unknown keys fail closed. Expired AI drafts are unavailable and may only be
marked deleted without changing encrypted content.

Reporting historical messages is intentionally allowed after disconnect or block. The API calls
the repository's transactional reportable-evidence port, not the normal InteractionGate: it
checks that the reporter was a conversation participant and was not the sender, then passes only
version and moderation metadata to SAF. Never copy message, translation, letter, or AI text into
the report/audit payload. Own-message withdrawal remains live-gated and is rejected after
contact ends.

## Inbox operations

- `GET /v1/conversations` returns only currently authorized conversations. Each item includes the
  decrypted `last_message` projection and its PostgreSQL-derived `unread_count`.
- `GET /v1/conversations/unread-count` is the mobile navigation badge source. It returns a count
  capped at 99 plus a `capped` flag.
- `POST /v1/conversations/:id/read` requires an allowed Origin and the strict body
  `{ "through_message_id": "<uuid>" }`. Never accept a client sequence or sender-selected account.
- The mobile inbox refreshes summaries every eight seconds and the global navigation badge every
  fifteen seconds. These intervals are reconnect fallbacks, not authorization or persistence.
- Opening a conversation recovers authoritative history, then advances the read boundary to the
  newest visible incoming message. Failed read updates remain retryable and must not be cached as
  successful.

When investigating a badge mismatch, compare the incoming active messages with
`messaging.receipts.read_at` for that viewer. Do not repair counts by writing a cached counter. Check
the current connection epoch, blocks and GrowthGate inputs first; revoked conversations must be
suppressed rather than counted. Message bodies, inbox previews and notification text must never be
written to logs, queues or browser storage.
