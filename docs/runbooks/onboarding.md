# ONB-01 onboarding runbook

Apply migrations with the repository runner (`pnpm --filter @wai/db db:migrate`)
against an isolated PostgreSQL database. `0016_onboarding.sql` is explicit UP /
DOWN and may be applied directly after `0014` when a parallel `0015` is absent.
Re-run is a no-op; rollback the latest migration and run UP again to verify the
reversible lifecycle. The real PostgreSQL lifecycle test checks that DOWN
removes the onboarding schema and a subsequent UP is clean. Do not stop or
reset shared development containers; use isolated test infrastructure only.

The default provider is `UnavailableOnboardingProvider`. Configure a provider
only through `OnboardingProvider`; it must accept the minimized prompt and return
strict criteria. Never add raw answers, DOB, documents, identity evidence,
hidden preferences or provider payloads to logs, traces, queues or analytics.

For incidents, disable provider consent first (the account's session and final
write gates also check enabled state and ELG). Members can always continue the
manual path. Proposal expiry is fail-closed and requires a new extraction.
Provider dispatch has a final fenced account/ELG/community/receipt check. A
dispatch already handed to an external adapter cannot be retroactively
withdrawn; no false cancellation is promised.

R2 persistence and recovery notes:

- `onboarding.idempotency_keys.result_ciphertext`, `result_nonce`, and
  `result_key_id` are encrypted with the existing AES-GCM keyring. Do not add
  a JSON result column or log a replay payload. Replaying the same key and
  payload returns the frozen typed result; reusing the key for another payload
  is a conflict.
- `normalized_json` is only the closed, purpose-bound projection
  (`mode`, criterion, strength, deal-breaker). Full preference values remain
  encrypted. The database trigger rejects extra keys, unknown vocabulary,
  invalid modes, and value-bearing projection items.
- Provider dispatch locks the enabled IAM account and exact current consent
  row until the adapter call has started. A withdrawal or account disable that
  commits first causes zero adapter calls; a withdrawal racing after handoff
  waits and is recorded as a later boundary. Dating never enters the provider
  path.
- `/onboarding/state?purpose=...` is the browser resume source. Local storage
  may contain only purpose, selected modes, Dating confirmation, importance,
  and step; answers, sessions, proposals, preferences, and consent receipts
  must remain server-side.

R3 operations and capacity:

- The API uses a shared PostgreSQL pool of 10 connections. Provider dispatch
  has an in-process capacity of 2 and fails fast with `503` when saturated;
  extraction is additionally limited to 5 requests per account per 60
  seconds (`429`). The adapter handoff is bounded to 10 seconds. Alert on
  repeated `503 PROVIDER_UNAVAILABLE`, pool exhaustion, or Valkey reconnects.
- Dispatch holds the IAM account and exact consent row locks through the last
  enabled/provider/receipt/ELG check and the adapter handoff. A withdrawal or
  disable committed first yields zero adapter calls; a withdrawal that waits
  behind an already-started external call is recorded as the honest
  non-cancellable boundary.
- `closeApiApp` must be used by standalone API runners. Nest's health shutdown
  owns DB/cache/foundation, and the close helper owns media/private-delivery/
  translation. Do not close the same adapter before `app.close()` or BullMQ
  can reconnect after Valkey stops.
- For browser evidence, set `WAI_E2E_API_PORT` and `WAI_E2E_WEB_PORT` to a
  unique pair and run
  `pnpm --filter @wai/web exec tsx e2e/run-onboarding-real.ts`. The real runner
  builds `NEXT_PUBLIC_API_BASE_URL`, registers a fresh account per viewport,
  checks credentialed preflight and forbidden origins, and always tears down
  its own containers in `finally`. Never reuse or stop `astrbot` containers.

Capacity and teardown are intentionally conservative: external provider work
cannot be retroactively cancelled, and manual onboarding remains available
when the provider is unconfigured, rate-limited, saturated, or unavailable.
