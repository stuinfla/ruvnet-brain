Updated: 2026-08-02 22:25:00 EDT | Version 1.0.0
Created: 2026-08-02 22:25:00 EDT

# ADR-062 and DDD-0015 dual-model review

## Verified reviewers

| Lane | Live provider/model evidence | Effort | Final verdict |
|---|---|---|---|
| Fable 5 | Claude CLI canonical model `claude-fable-5`, provider `firstParty`, session `9c38f28e-ed53-4c44-867b-f9faab401dc3` | Medium | SIGN-WITH-CHANGES; exact changes applied |
| GPT-5.6 Sol | Codex model `gpt-5.6-sol` | Medium | SIGN |

No alias was guessed and no substitute model was used.

## Corrections incorporated before acceptance

- required one same-reducer npm observation before GitHub latest intent;
- removed special re-promotion states and made compensated routing depend on fresh GitHub state;
- separated immutable candidate payload identity from its signed evidence envelope;
- made sequence-zero prior-generation evidence immutable across retries;
- removed decorative fencing and defined create-only receipt CAS semantics;
- made draft creation the sole idempotent bootstrap exception before the first receipt;
- resolved published tag identity by SHA instead of trusting `target_commitish`;
- scoped host matrices to one candidate run and one final public-artifact run;
- distinguished a healthy published-non-latest state from a draft that requires compensation;
- required fresh dual-provider observation rather than implying an atomic cross-provider snapshot;
- defined the precise no-further-mutation rule after a receipt CAS loss.

## Acceptance

Both governing documents describe the same build-once, persist-once, resume-by-observation release
transaction and have no remaining implementation-blocking contradiction. Implementation and
Agentic QE must still prove conformance before publication.
