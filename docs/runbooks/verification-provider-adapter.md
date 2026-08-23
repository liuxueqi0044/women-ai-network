# Verification provider adapter guide

Implement an adapter behind `IdentityVerificationProviderPort`. Normalize only
the closed event schema in `@wai/contracts`; retain no raw payload. Verify the
original raw body with timing-safe HMAC comparison and support active plus
previous signing secrets. Session creation must be idempotent and use an
opaque case reference, never an account UUID.

Document retention, regional processing, webhook retry/order semantics, and
deletion/redaction behavior. Production wiring is deliberately not included
until procurement and legal review select a provider.

The adapter must also expose a stable lowercase `name`, reject unknown event
states, enforce the semantic invariant that `verified` means confirmed
identity plus passed liveness, and return only the minimum normalized fields.
Its client token may be returned once to the authenticated caller but may not
be persisted. The provider session reference is never returned by our API; it
is encrypted at rest and resolved by keyed digest.

Before enabling a real adapter, run the compliance cases for raw-body
tampering, active/previous secret rotation, duplicate delivery, conflicting
payload digest, concurrent delivery, worker crash/reclaim, future timestamp,
out-of-order terminal events, subject collision, redaction, and production
mock refusal. Record provider SDK version and license, data regions, subprocessors,
retention, assurance scope, age-output semantics and webhook retry SLA in a
new ADR.
