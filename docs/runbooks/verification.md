# Verification runbook

Do not set `VERIFICATION_PROVIDER=mock` in production. Until a reviewed
provider adapter is installed, the production adapter returns
`verification_provider_not_configured` and no account can be verified. Local
and CI may set `VERIFICATION_MOCK_SECRET` to a random value of at least 32
characters.

Provider webhooks must send the exact original request bytes in
`x-verification-signature`; do not parse and re-serialize JSON before HMAC.
Events are at-least-once and may arrive out of order. The inbox key is
`(provider, provider_event_id)` and a conflicting digest is a security review
condition. Never copy provider payloads, DOB, document numbers, subject IDs
or client tokens into tickets or logs.

## Local validation

1. Set a unique Compose project name and non-conflicting Postgres, Valkey and
   OPA ports.
2. Apply the explicit migrations with `pnpm --filter @wai/db db:migrate`.
3. Run `pnpm test:ver:unit`, `test:ver:contracts`, `test:ver:migration`,
   `test:ver:provider`, `test:ver:integration`, and `test:ver:privacy`.
4. Run the root regression, E2E, format, lint, typecheck, build, audit and
   `git diff --check` commands.
5. Stop only the named Compose project with `docker compose -p <name> down -v`
   and verify it left no container, volume or network.

## Inbox operations

- `processing` with a future `lease_until` means another worker owns the
  event; duplicate delivery is acknowledged without another side effect.
- `retryable` before `next_retry_at` must return a non-success response. This
  repository has no background inbox poller, so acknowledging it would strand
  the event.
- After `next_retry_at`, a new processing token may reclaim it. A completion
  carrying an old token must update zero rows.
- `conflict` means one provider event ID arrived with different raw bytes. It
  is terminal and requires provider/security investigation; never reopen it by
  replaying either payload.
- `ignored` is a valid terminal result for an older or state-invalid event.

Only safe allow-listed error codes belong in `last_error_safe`. Provider or DB
exception text must never be copied there.

## Privacy and redaction

The user endpoint records an idempotent redaction request. Legal hold changes
it to `held`; otherwise an authorized operations workflow must call the real
provider adapter, redact the encrypted session material, and record completion.
Do not hard-delete an identity case while Eligibility evidence references it.
Appeal text is encrypted; reviewer principals must be opaque operator IDs, not
emails. Retention periods are deployment/legal configuration and are not
silently invented by this module.

## Incident checks

- Signature failures: confirm secret rotation and raw-byte forwarding; never
  paste the body into logs or tickets.
- Subject collision: leave both IAM accounts enabled, keep the new identity in
  `needs_review`, and route to authorized human investigation.
- Provider outage: session creation fails closed. Do not switch production to
  the mock adapter.
- Age issuer failure: the event stays retryable and identity/age do not become
  verified/attested until Eligibility commits the encrypted credential.
