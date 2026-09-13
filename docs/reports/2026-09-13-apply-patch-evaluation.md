# `apply_patch` candidate evaluation

Date: 2026-09-13

Verdict: YELLOW. The candidate passes the supplied-session and GPT-5.6-Luna
model gates and materially outperforms the current matcher, but the historical
complete-envelope and tolerant-success release gates remain unresolved.

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
- A frozen 13-case GPT-5.6-Luna model suite, repeated three times under both
  contracts for 78 qualifying runs. Each run used only `Read` and canonical
  lowercase `apply_patch` in a fresh isolated fixture with persistence off.

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

## Paired GPT-5.6-Luna evaluation

### Frozen method

Manifest version 2 contains 13 byte-scored tasks covering unique exact edits,
later-hunk disambiguation, ambiguity recovery, hint substring collisions, outer
hint whitespace, five ordered hunks, a multi-file envelope, BOF, hard EOF with
no final newline, CRLF, BOM, trailing whitespace, and Unicode punctuation. Each
task ran three times under each contract. Odd repeats ran current then candidate;
the even repeat reversed that order.

The frozen cases and resumable runner are in
`scripts/apply-patch-model-eval/`; the compact machine-readable outcome is in
`scripts/apply-patch-model-eval/results/2026-09-13-gpt-5.6-luna-medium.json`.

The clean control and candidate were both built from commit `ba056787`. A
recursive comparison of their `src` trees found one differing file:
`FilePatchTool.tsx`, whose only differences select the candidate description,
planner, and pure applier. The binaries were:

- current: SHA-256
  `91c2111619c79e80add82918869bee4a43de6fcfea088e43064eafb0fd06a38a`;
- candidate: SHA-256
  `ceb55775c47f6b11e28d6e13aa575612ce12673c4cec2430a74f319fe22de693`.

Task correctness required every expected file to be byte-identical with no
unexpected fixture mutation. This deliberately gives the current contract
credit when the model eventually reaches the correct bytes despite violating a
requested call shape. Tool rejection alone is neither success nor failure.

### Results

| Contract | Correct tasks | Patch attempts | Rejected attempts | Cost | Cumulative duration |
|---|---:|---:|---:|---:|---:|
| Current | 34/39 (87.2%) | 63 | 21 | USD 1.3554 | 625.7 s |
| Candidate | 38/39 (97.4%) | 45 | 6 | USD 0.9891 | 443.9 s |

| Case | Current correct | Candidate correct | Current attempts/rejections | Candidate attempts/rejections |
|---|---:|---:|---:|---:|
| Unique exact | 3/3 | 3/3 | 3/0 | 3/0 |
| Later fence | 2/3 | 3/3 | 15/12 | 3/0 |
| Deliberate ambiguity retry | 3/3 | 3/3 | 7/3 | 6/3 |
| Hint substring collision | 3/3 | 3/3 | 9/6 | 3/0 |
| Hint outer whitespace | 0/3 | 3/3 | 3/0 | 5/2 |
| Five ordered hunks | 3/3 | 2/3 | 5/0 | 3/0 |
| Multi-file envelope | 3/3 | 3/3 | 3/0 | 3/0 |
| BOF prepend | 3/3 | 3/3 | 3/0 | 3/0 |
| EOF without final newline | 2/3 | 3/3 | 3/0 | 3/0 |
| CRLF preservation | 3/3 | 3/3 | 3/0 | 3/0 |
| BOM preservation | 3/3 | 3/3 | 3/0 | 4/1 |
| Trailing whitespace | 3/3 | 3/3 | 3/0 | 3/0 |
| Unicode punctuation | 3/3 | 3/3 | 3/0 | 3/0 |

All 108 generated patch attempts used the canonical lowercase name; neither
contract emitted legacy `Apply_patch`.

### Failure adjudication

The candidate produced no consequential wrong-region placement. Its one failed
task was replacement corruption: the model emitted five context-plus-addition
hunks, duplicating each old declaration beside its new form. The exact planner
placed those literal instructions correctly but cannot infer that the model
intended replacement rather than insertion. The other two repeats of this case
passed. This is a model patch-construction error accepted by the language, not a
matcher placement error, but it counts as a task failure.

The current contract's five failed tasks were:

- three replacement corruptions in the outer-whitespace hint case. The model
  omitted source indentation, and tolerant matching authorized the near match,
  publishing an unindented or one-space replacement. The candidate rejected
  the same malformed shape when it occurred and recovered with exact text;
- one later-fence failure after six safe rejections. Its seventh attempt was
  accepted but inserted a second divider declaration instead of replacing the
  old one, then hit the per-run budget cap;
- one EOF output corruption that added a final newline despite an explicitly
  unterminated expected file.

The candidate's six rejections were recoverable: three deliberately ambiguous
first attempts, two indentation mismatches, and one BOM mismatch. Its
diagnostics led to correct bytes in each case. The candidate used 29% fewer
patch attempts, 29% less cumulative runtime, and 27% less model cost in this
sample.

Before the qualifying run, 78 attempted invocations failed before contacting a
model because the sandbox denied engine-migration state access; cost was zero.
A subsequent nine-run manifest-v1 probe cost USD 0.4044 and was stopped when its
purported substring fixture was found not to contain a real collision. A first
complete v2 run cost USD 2.4258 but used an older production binary, so it was
excluded as a confounded comparison. Total authorized evaluation spend,
including excluded probes, was USD 5.1746; the clean qualifying run cost USD
2.3445.

## Release-gate accounting

| Gate | Status |
|---|---|
| Every supplied-session call classified | Met for exploratory replay: 68/68 |
| Candidate preserves supplied-session successful outputs | Met: 50/50 |
| Zero observed wrong-region placements in supplied session | Met |
| At least 20 adjudicable complete-envelope ambiguity cases | Not met; 24 target operations are reconstructed, but not complete envelopes |
| At least 30 adjudicable successful non-exact updates, five per evaluated tier | Not met; no qualifying cohort has been reconstructed |
| At least 30 update attempts per contract and model/provider configuration | Met for GPT-5.6-Luna medium: current 63, candidate 45 |
| Candidate has zero consequential wrong-region placements in the paired suite | Met for GPT-5.6-Luna medium |
| Candidate final correctness is not below current | Met: 38/39 versus 34/39 |
| Live old-session continuation with legacy `Apply_patch` history | Not run |

## Decision

Keep `FilePatchTool.call` on the production matcher only until the remaining
offline safety gates are resolved. The model evidence now favors the candidate:
it improves correctness, sharply reduces retries, rejects malformed whitespace
instead of publishing corrupted replacements, and makes whole-update ordering
and whole-line hints usable.

Do not activate it solely from this model suite. The next qualifying work is to
reconstruct and adjudicate at least 20 historical ambiguity calls as complete
envelopes and at least 30 current successes that depend on non-exact matching.
That work determines whether the candidate's conservatism creates an
unacceptable regression outside this controlled model suite. The old-session
live continuation remains a separate compatibility check.
