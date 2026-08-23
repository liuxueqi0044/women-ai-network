# ADR 0004 — Verification, age assurance and membership separation

Status: accepted for implementation; production provider selection pending.

VER-01 keeps three independent conclusions: provider identity verification,
Eligibility-owned external age attestation, and versioned human-reviewed
membership. A provider `verified` event never approves membership. Raw provider
payloads, document data, biometric data, provider references and plaintext DOB
are not stored. The HMAC mock exists only for local/CI; production uses a
fail-closed unavailable adapter until a reviewed provider is configured.

Age assurance is passed through `AgeCredentialIssuer`; Verification does not
write the Eligibility schema. Youth/adult and Dating gates remain ELG policy
decisions. No gender classifier or AI inference is part of this module.

## Decision details

- `identity_cases`, `verification_attempts`, and `provider_events` are the
  durable source of truth. Process-local maps are forbidden.
- Provider session references are AES-256-GCM encrypted and looked up by a
  context-separated keyed HMAC. Provider subjects are stored only as a
  different context-separated HMAC.
- Inbox claims carry a random processing token and a bounded lease. Only the
  current owner may complete or fail a claim; an expired worker cannot commit
  after another worker reclaimed the event.
- Case effects are serialized with a PostgreSQL advisory lock. Provider
  ordering uses `(occurred_at, provider_event_id)` and the identity state
  machine, so a delayed failure cannot regress a verified case or mint a new
  age credential.
- Eligibility encrypts DOB evidence and derives the age band using Temporal in
  the active policy timezone. Credential expiry is the earliest of provider
  assurance expiry, policy expiry, and the next birthday.
- Membership policy rows have a composite `(id, revision)` key. Approved rows
  are immutable except retirement; applications snapshot revision and content
  hash. Decisions and appeals are exposed only through the trusted review
  port, not a public admin route.
- `CommunityAccessDecisionPort` requires an enabled IAM account, verified
  identity, a current Eligibility-owned `externally_attested` credential, and
  approved membership. It does not replace ELG mode/partition decisions.

## Rejected alternatives

- Building OCR, liveness, face matching, or document verification locally.
- Treating a provider's `verified` result as membership approval.
- AI classification of gender from face, voice, name, or documents.
- A global 18+ flag. Youth/adult separation and Dating adult thresholds remain
  versioned jurisdiction policy in ELG-01.
