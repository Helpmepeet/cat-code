# `apply_patch` candidate evaluation

Date: 2026-09-13

Verdict: YELLOW. The supplied-session results support the candidate design, but
the matching-policy release gate remains unresolved.

## Evaluated inputs

- Desktop app session `952385a4-6a8a-4b89-a4de-53a32c75e86c`, resolved through
  the desktop registry to engine session
  `6c27be0a-aeab-487a-a26c-5a261872157a`.
- Main engine transcript: 10 `Apply_patch` calls.
- Implementor subagent `agent-a113099b7e103c60a`: 58 `Apply_patch` calls and
  two successful `Write` calls needed to reconstruct the ordered working state.
- Historical ambiguity window used by the 2026-08-09 production analysis. Of
  the original 48 failures, 46 remain extractable from current transcript
  storage and 24 reproduce against a pre-cursor runtime and a git source state.
- One paired live GPT-5.6-Luna smoke task under the production and candidate
  contracts, in isolated temporary directories with session persistence off.

## Supplied-session reconstruction

The transcript alone contains no complete source snapshots, so direct replay
correctly classified all 68 calls as unknown. For the substantive replay, source
state was reconstructed from base commit `c036b8f23d19a6a95ad205d5839e966bb8506de8`,
then every successful patch and write was applied in transcript order. The
result was checked against final session commit
`5a53fa0ef4c48f3e1249d4f25f85d91bf6b680ba`.

- 19 touched paths.
- 68 patch calls: 50 recorded successes, 17 recorded matcher failures, and one
  malformed envelope.
- 0 recorded-versus-simulated outcome mismatches.
- 0 final-file mismatches against the final session commit.

| Policy | Accepted | Rejected | Unknown |
|---|---:|---:|---:|
| Current production matcher | 50 | 17 | 1 |
| Historical first-forward model | 63 | 4 | 1 |
| Candidate complete exact planner | 53 | 14 | 1 |
| Complete tolerant measurement | 53 | 14 | 1 |

The candidate accepted all 50 recorded successes and reproduced byte-identical
outputs for them. It introduced no observed wrong-region placement in this
cohort. It also accepted three formerly rejected calls representing two retry
incidents:

1. A three-hunk `codexAccountPool.test.ts` edit. Its additions match the later
   successful repair. Applied to the exact reconstructed snapshot, the complete
   test file passed 85 tests.
2. Two attempts to add distinct IDs to four named Welcome fixtures. These are
   two attempts at one incident. The agent later chose a different valid repair
   by making the fixture helper supply a default ID. Applying the candidate's
   first attempted repair to the exact snapshot produced the intended four
   placements, and the focused Welcome suites passed 31 tests.

Thus the supplied session shows two recovered retry incidents, no lost
historical success, and no observed consequential wrong placement.

## Historical ambiguity replay

The archived 2026-08-09 replay scripts were recovered from their session's
recorded `Write` calls and rerun against the exact pre-fix runtime at commit
`381b79d1b2f85d2e73e0b66fac224a4f2116fcc0`. Current transcript storage yielded
46 of the original 48 failures. Twenty-four target-file states reproduced the
old collision signature.

This remains single-operation evidence, not the complete-envelope evidence
required by the new release plan.

| Policy over 24 reproduced target operations | Accepted | Rejected |
|---|---:|---:|
| Historical first-forward model | 23 | 1 |
| Candidate complete exact planner | 9 | 15 |

The candidate rejected the known dangerous first-hunk `phase4.md` case and both
reconstructed `TranscriptView.tsx` attempts. It also rejected the historical
204-location `sidecarServer.test.ts` recovery, showing that it is intentionally
more conservative than cursor-first placement. The nine accepted historical
operations still require complete-envelope reconstruction and individual
ground-truth adjudication before they can count toward the release gate.

## Paired live smoke

Both contracts were built separately. GPT-5.6-Luna received the same repeated
function-block task under each contract.

- Both runs read the fixture and generated canonical lowercase `apply_patch` on
  the first update attempt.
- Both produced the correct, byte-identical edit.
- The hosted decoder accepted the generated canonical grammar in both runs.
- The candidate returned contract version 2 and the expected original-source
  placement `[5, 9)`.
- The process exit in both runs was caused by the configured dollar cap after
  the successful mutation while the model requested its final verification
  read. It was not a patch failure.
- Observed costs were approximately USD 0.108 and USD 0.176. This pair is smoke
  evidence only, not a statistically meaningful model comparison.

## Release-gate accounting

| Gate | Status |
|---|---|
| Every supplied-session call classified | Met for exploratory replay: 68/68 |
| Candidate preserves supplied-session successful outputs | Met: 50/50 |
| Zero observed wrong-region placements in supplied session | Met |
| At least 20 adjudicable complete-envelope ambiguity cases | Not met; 24 target operations are reconstructed, but not complete envelopes |
| At least 30 adjudicable successful non-exact updates, five per evaluated tier | Not met; no qualifying cohort has been reconstructed |
| At least 30 update attempts per contract and model/provider configuration | Not met; one attempt per contract for GPT-5.6-Luna |
| Live old-session continuation with legacy `Apply_patch` history | Not run |

## Decision

Keep `FilePatchTool.call` on the production matcher. The candidate remains
promising and fixed both supplied-session retry incidents that it accepted, but
the available evidence does not authorize production activation.

The next qualifying work is to freeze a provenance-preserving complete-envelope
manifest, extend the historical reconstruction to meet the ambiguity and
tolerant-success floors, and then run the repeated paired model suite. The fixed
13-task suite repeated three times under each contract requires 78 live tasks per
model configuration. The two smoke runs show that this is a material capacity
and cost decision rather than a quick final check.
