# PRF-01 profile operations

Run migrations through the repository migration runner. `0006_profile.sql`
creates the `profile` schema and its reversible down section; never edit an
applied migration. Rotate PII keys using the existing IAM keyring process.

The profile schema intentionally contains no DOB, document, precise-location,
provider payload, or media bytes. A failed visibility/partition decision must
remain denied. Inspect only hashes, states, versions, and audit metadata during
incident response.
