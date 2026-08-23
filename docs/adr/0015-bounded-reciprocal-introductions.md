# ADR-0015 — bounded reciprocal introductions

MCH-01 stores small, frozen introduction batches and candidates in PostgreSQL. Candidate rules are
deterministic and versioned. Every final read or mutation re-evaluates IAM account state, VER
membership, ELG mode/partition and SAF interaction state; current onboarding hard requirements are
unknown-fail-closed. Scores are internal only.

Interested and Pass are actor-owned, payload-bound and immutable per batch. Pass has a bounded
cooldown. Mutual outcome requires two independent Interested decisions and is handed to a CON-owned
materialization port with both decision proofs. MCH never writes connection tables. Safe local
reason-code rendering is the complete fallback; an optional provider may only rewrite approved
codes and cannot add facts, candidates, scores or actions.
