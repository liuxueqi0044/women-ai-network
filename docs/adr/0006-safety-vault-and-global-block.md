# ADR-0006: global safety control plane

SAF state is PostgreSQL-owned. A block decision checks both directions
synchronously and returns only the stable `ACTIVE_BLOCK` reason. Reports capture
a provider-authorized canonical snapshot before encryption; the snapshot is
immutable and source deletion cannot change it. Vault access authorizes before
decryption and records both allow and deny events. High-risk actions remain
proposed until a distinct second principal approves them; execution is a
replay-safe outbox boundary and does not itself claim that IAM enforcement has
completed.
