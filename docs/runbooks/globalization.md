# Globalization runbook

## Deploy

Run the normal migration runner through `0015_globalization.sql`; it is
transactional and records a checksum. A second `up` is a no-op. Roll back only
the latest migration with the normal database rollback command after confirming
no later migration depends on GLO-01.

## Verify

Run the isolated, no-mock browser proof with
`pnpm exec tsx apps/web/e2e/run-globalization-real.ts`; assign unique
`WAI_E2E_API_PORT` and `WAI_E2E_WEB_PORT` values when another stack is active.

Check `GET /v1/globalization/catalog` for version 1 and all four locales. For an
enabled test account, read defaults (version 0), then replace with
`If-Match: 0` and a unique `Idempotency-Key`; replay the same request and confirm
the same version 1 response. Repeat with a stale version and a changed payload
under the same key to confirm conflicts. Try a non-existent timezone and confirm
`VALIDATION_ERROR`; do not log the timezone, locale list or request body.

## Incident response

If PostgreSQL timezone data is unavailable, writes fail closed. If the account is
disabled/deleted, the IAM session guard and repository account join return the
uniform account-state denial/not-found behavior. Audit inspection may use codes
and hashes only; never export preference payloads or idempotency response JSON.
