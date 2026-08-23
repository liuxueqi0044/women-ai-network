# NTF-01 notifications runbook

Apply migrations with the normal `@wai/db` runner. Verify `0018_notifications.sql` on an isolated
PostgreSQL instance with fresh, repeated up, down, and up again. Do not create or edit `0017` on
this branch; integration supplies it when the Wave 5 branches are merged.

If email or push is unavailable, inspect `notifications.provider_intents` and
`notifications.provider_attempts`. `pending`/`retrying` rows are expected and are safe to replay;
`failed` rows reached the bounded attempt cap. Re-running the worker is safe because completion,
retry and suppression are fenced by intent id, lease token and lease fence.

Provider payloads must remain generic. Any suspected plaintext in a queue, provider request or log
is a privacy incident: stop the worker, retain only hashes/opaque identifiers, and rotate the
affected adapter credentials through the normal operations process.
