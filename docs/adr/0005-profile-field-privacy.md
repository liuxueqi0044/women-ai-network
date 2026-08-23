# ADR 0005 — Profile facts and field-level privacy

- Status: proposed for principal review
- Scope: PRF-01 profile aggregate and field-level privacy

PRF keeps fact content, matching use, and member audience in separate
PostgreSQL tables. Low-sensitivity values use JSON only; sensitive and AI-only
values use the existing AES-256-GCM keyring. A database trigger enforces the
representation and rejects values that violate the fact definition.

Self serialization is an explicit owner view. Member and matching serializers
use a fail-closed relationship, community-access, and ELG partition decision;
they never infer age or gender and never serialize AI-only facts. Published
snapshots contain only confirmed low-sensitivity values, are immutable, and are
content-hash idempotent. Sensitive member access appends an audit row protected
by an immutable trigger.
