# Letters runbook

Run the focused gates with:

```text
pnpm test:ltr:unit
pnpm test:ltr:contracts
pnpm test:ltr:migration
pnpm test:ltr:integration
pnpm test:ltr:privacy
```

The integration suites start an isolated PostgreSQL container. They cover
encrypted-at-rest drafts/private text, immutable revisions, concurrent
optimistic autosaves, frozen idempotency replay, minimal publication
projections, withdrawal visibility, private-letter publication denial, and
the fresh/no-op/down/up migration lifecycle. A decrypt or schema validation
failure is intentionally fail-closed.

Do not query or log decrypted letter content in operational diagnostics. Use
the letter id, revision, and audit event type only.
