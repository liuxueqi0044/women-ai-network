# ADR-0014: Globalization preference authority

## Decision

GLO-01 stores one account-bound preference row in PostgreSQL. UI locale is a
closed checked-in v1 catalog (`en`, `zh-Hans-CN`, `es-419`, `fr`); content locale
identifiers remain the existing bounded BCP-47 grammar. Time zones are accepted
only after a PostgreSQL `pg_timezone_names` lookup, while instants remain UTC.
The API requires the IAM session, `If-Match` version and payload-bound
`Idempotency-Key` for replacement.

The first write moves a default version 0 to version 1. Idempotent replay returns
the frozen JSON response, while a reused key with another payload and stale
versions fail with stable conflicts. Audit rows contain old/new codes and hashes,
never raw private values, and are append-only.

## Consequences

The Web shell can render without a browser locale guess and can deterministically
fall back to English. New UI languages require a catalog version change and
completeness tests. A disabled or deleted account cannot use the preference
surface. External localization providers are intentionally out of scope.
