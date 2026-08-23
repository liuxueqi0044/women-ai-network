# ADR NTF-01: data-only notification outbox

Status: proposed for principal review.

Notifications persist a closed event key, version and strict safe parameters. PostgreSQL owns
in-app visibility and provider intent state. BullMQ carries only an opaque provider-intent UUID.
Providers receive a generic localized-safe preview and an intent-stable idempotency key; private
content is never rendered into persistence, queue data, payloads or logs.

The account state, SAF block check and resource gate are evaluated immediately before list/send.
Expired leases are reclaimed, each takeover increments a fence and gets a fresh random token, and
terminal writes require the exact token/fence/state. A disabled provider remains pending/retryable
or terminally failed; it is never reported as sent. Critical-safety may bypass quiet/digest only,
never account, block or resource gates.
