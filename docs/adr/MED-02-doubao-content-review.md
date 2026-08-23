# ADR MED-02 — Doubao visual content review after media sanitization

Status: accepted for implementation; production credential approval pending.

## Context

Profile avatars and profile-gallery images need a second safety layer after
malware scanning and image sanitization. A visual model can help detect content
policy violations, but it must not become an identity, gender, age, beauty, or
membership classifier. The Ark credential and the media itself are sensitive,
and the application serves users across jurisdictions.

## Decision

The worker runs the following fixed sequence:

1. private quarantine upload;
2. hash, magic and size verification;
3. ClamAV scan;
4. sharp/libvips decode, metadata stripping and re-encode;
5. write a private clean rendition;
6. issue a short-lived signed HTTPS read URL;
7. call Volcengine Ark ChatCompletions with the configured visual endpoint;
8. parse a strict closed JSON decision; publish only `allow`.

The wire shape follows the
[official Ark ChatCompletions API](https://api.volcengine.com/api-docs/view?action=ChatCompletions&serviceCode=ark&version=2024-01-01),
including `image_url` content and an Endpoint ID in `model`.

The allowed output is `allow`, `block`, `review`, or local `unavailable`, with
a closed reason-code vocabulary. Model prose, image description, OCR text and
provider error bodies are neither trusted nor persisted. `review` is not an
automatic approval. Provider/network/schema failure is `unavailable` and the
job remains fail-closed/retryable.

The adapter prompt explicitly forbids inferring or reporting identity, gender,
age, ethnicity, nationality, health, disability, religion, sexual orientation,
attractiveness, relationship intent, or membership eligibility. VER and ELG
remain the authorities for identity/membership. Doubao is not used for hiring
or employment decisions.

## Reuse and supply-chain decision

- Volcengine's OpenAI-compatible ChatCompletions HTTP contract is used directly;
  no provider SDK or runtime dependency was added.
- `minio@8.0.7` supplies mature S3-compatible signing and object operations;
  no custom SigV4 implementation is maintained.
- ClamAV remains the malware engine and sharp/libvips remains the image parser
  and sanitizer.
- Development uses pinned Community MinIO; production storage is selected by
  procurement and connected through the same S3-compatible port.

## Operational and legal consequences

- Ark keys are secret-manager values. A key pasted into chat, logs, tickets or
  source control is revoked before use.
- Production requires a visual-capable endpoint ID; a text-only endpoint must
  fail the real provider smoke.
- The signed clean URL must be reachable by Ark but expires quickly; the bucket
  is never public.
- Procurement must document data region, subprocessors, retention/no-training,
  deletion, incident response and cross-border transfer terms.
- Metrics contain only closed result/error codes and latency; never URLs, keys,
  object names, image bytes, OCR, provider response bodies or user traits.

## Rejected alternatives

- Using a visual model as gender/age/identity verification: inaccurate,
  discriminatory and outside this module's authority.
- Sending quarantine originals to a remote moderation provider: unnecessary
  exposure of untrusted bytes and metadata.
- Approving on timeout or malformed output: unsafe fail-open behavior.
- Writing a custom S3 signer: duplicates a mature security-sensitive wheel.
