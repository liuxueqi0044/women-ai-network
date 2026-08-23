# Membership verification policy controls

This repository contains policy controls and synthetic fixtures only; it does
not publish a production membership policy. A policy must be versioned,
approved by the product/legal owner, effective-dated and reviewed by an
authorized human before production use.

Identity provider success is evidence for identity/age processing only. It is
not a decision about whether a person is a woman and cannot approve or reject
membership. No face, name, voice, document gender field or AI model may be
used for that purpose. Membership decisions are human-reviewed, use stable
reason categories, and remain appealable.

## Required controls

- An approved policy has an immutable `(policy id, revision)`, content hash,
  legal-basis reference, reviewer, review time and effective interval.
- An application stores the selected policy revision/hash, an allowed
  statement category and explicit consent time. It stores no face, gender
  score, model output, document image or provider payload.
- Only the internal `MembershipReviewPort` can approve or reject. Current
  decision reasons are closed codes; free-text reviewer notes are out of scope.
- A rejected member may create one open encrypted appeal. Authorized review
  either upholds the decision or overturns it, with an immutable audit event.
- Provider identity and age results never mutate membership state.

This policy does not impose a global minimum age. Eligibility policy decides
whether a jurisdiction can launch Youth access and enforces the separate adult
Dating threshold. Membership review cannot bypass those ELG decisions.
