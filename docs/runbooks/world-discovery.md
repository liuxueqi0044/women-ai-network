# World discovery runbook

Apply migrations through `0013_world_discovery.sql` using the normal migration
runner. Re-running `up` is a no-op; rollback removes only the WLD schema and its
publication trigger. Private letters cannot be published and are never indexed.
If the discovery projection is stale, rebuild it from current
`letters.publications`; stale rows are safe because API reads still join current
publication/revision/account state, apply the dedicated discovery gate, and run a
final recheck before returning or writing a bookmark.

Investigate missing results by checking publication state, source hash/revision
binding, current author account/member state, current community access/ELG
credential and partition decision, and SAF blocks. Never inspect or log private
letter bodies. A Valkey/queue outage does not change authorization or the
PostgreSQL result. Re-run bounded integration coverage after migration changes;
do not use offset pagination or popularity fields to troubleshoot ordering.

Candidate recall is capped at 120 rows (the common 20-item request recalls at
most 80); final gates and diversity ranking scan only this ordered look-ahead.
Continuation cursors retain the original as-of and expiry, so a later page
cannot extend a snapshot or its lifetime. The final recheck/conditional
bookmark insert is the linearization point; changes committed afterward may
race a response and must be observed by the next request.

Locale filters use the shared content-language grammar: lowercase language,
optional title-case script, and optional uppercase alpha-2 or numeric-3 region,
with a 32-character limit. Extensions, variants, private-use tags, and
CLDR/IANA registry alias canonicalization are rejected consistently by
contracts and the discovery index; this grammar is a product subset, not a
complete BCP-47 registry.
