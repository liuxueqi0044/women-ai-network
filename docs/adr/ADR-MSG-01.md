# ADR MSG-01: PostgreSQL conversations with opaque realtime wakeups

PostgreSQL owns connection epochs, message sequence, receipts, encrypted content and evidence
references. A conversation is unique only within one accepted connection epoch. Realtime and
queue consumers receive opaque conversation/message IDs and are never used for authorization or
history; a signed cursor is the recovery mechanism after reconnect. AI suggestions are encrypted,
short-lived drafts and have no send or safety tools.

Safety reporting is an explicit historical-data exception to the live connection gate.
`getReportableMessageEvidence` takes the pair advisory lock, locks the message and conversation,
and authorizes only a conversation participant reporting the other participant's message. It
returns only `message_version` and `moderation_state`; the SAF vault owns the encrypted,
immutable snapshot. This remains available after disconnect, block, or withdrawal so a safety
report cannot be defeated by ending contact.

Withdrawal is not a reporting exception: it remains connection-bound and is rejected after
disconnect/block. Its tombstone is minimal and immutable; separate report evidence remains
available to authorized safety operators.

## Inbox projection and read boundary

The inbox is a PostgreSQL projection over the existing encrypted message and receipt rows. It does
not introduce a second message store or treat a realtime transport as message authority. Each
visible conversation is checked through the current InteractionGate before its latest message is
decrypted, then checked again before the response is returned. Unread counts include only active
messages sent by the other participant whose monotonic receipt has no `read_at` value.

Clients mark a conversation read through an opaque `through_message_id`, never through a
caller-supplied sequence. The repository derives the server sequence from that immutable message,
takes the canonical pair lock, revalidates the current conversation and advances all incoming
receipts through that boundary with a monotonic upsert. Replays and concurrent reads therefore
converge on the same unread result.

The navigation count and inbox refresh use bounded polling over the same API projection. Polling is
only a delivery hint and reconnect mechanism; PostgreSQL remains authoritative. Aggregate scans are
bounded to 1,000 conversations and the public navigation count is capped at `99`, avoiding an
unbounded policy-query workload or a relationship-count side channel.
