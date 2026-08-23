# CIR-01 operational runbook

Apply `0019_circles.sql` only after the frozen baseline migrations. Verify fresh install, no-op replay, down, and up before production rollout. Keep the API, worker, PostgreSQL, and Valkey on isolated non-default ports in validation.

Circle notification handoffs are opaque and bounded. If NTF is unavailable, circle state remains authoritative and the handoff is reconciled by the notification worker; never edit circle rows manually. Revoke/blocks and IAM erasure are authority changes: confirm subsequent list/detail/member/note requests fail closed and do not reveal the blocked direction.

Topic catalog v1 is closed at both contract and PostgreSQL boundaries. Do not
hot-edit labels: an addition needs a reviewed new catalog version and
migration evidence. Scope stores only `online`, an ISO country, or a
normalized city label—never an exact address or coordinates. Circle/note
reports go to SAF's vault with identifier/version/state metadata only; inspect
private text only through established SAF controls.

Before a CIR downgrade, run the real report-evidence down/up check. Existing
circle/note SAF evidence is retained under an old-vocabulary `NOT VALID`
constraint; new retired target writes must fail until CIR is upgraded again.
Do not set `circles.erasure_account` or attempt manual deletes: it is not an
authorization channel and direct durable-row writes are rejected.
