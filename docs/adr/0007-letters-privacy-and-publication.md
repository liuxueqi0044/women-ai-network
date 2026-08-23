# ADR 0007: Letters privacy and publication boundary

Status: accepted for LTR-01 implementation

Letter drafts and private letters are stored as encrypted revisions. Title,
body, pen name, locale, country, topics, and reminders are encrypted together
with AES-256-GCM; source and request equality use context-separated keyed HMAC
digests. Revisions and published projections are immutable. A public projection
contains only member-safe letter fields and is visible only after the
membership, age, and global safety decisions are re-evaluated. Withdrawal
removes it from the readable publication path.

The API accepts structured paragraphs only. It does not accept or render HTML.
Private letters cannot publish at the contract/service/repository and database
constraint/trigger layers. Optimistic version checks and digest-bound
idempotency keys prevent lost autosaves and payload-conflicting replays.
