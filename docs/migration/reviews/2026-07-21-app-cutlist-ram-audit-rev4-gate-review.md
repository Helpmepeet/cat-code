# Rev-4 scoped gate check — desktop cut-list + RAM audit (2026-07-21)

**Reviewed artifact:**
`docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md` rev 4

**Verdict: RED — two corrections are required before rev 4 can be frozen.**

This was a conformance check of the five accepted round-3 dispositions, not a
fourth full adversarial review. Rev 4 correctly repairs the harness buckets,
the main RAM-0 protocol, thread-goal classification, effort partition and test
matrix, disposal wiring, dispatch numbering, and bucket arithmetic. One stale
decision-queue sentence still preserves the exact RAM-0 escape that R3-F2 was
meant to remove. Rev 4 also adds an incorrect mechanism to the new
`UNVERIFIED` state row: worktree, cost state, and context collapse are restored
through side effects in `processResumedConversation`; they are not riders in
the returned `ProcessedResume.initialState` that the desktop sidecar drops.

## Findings

| ID | Severity | Finding | Required disposition |
|---|---|---|---|
| F1 | High | Queue item #1 still permits feature selection “before or alongside” measurement and measuring “both configurations,” contradicting the strict-predecessor RAM-0 rule. | Replace the stale queue text with the same strict predecessor, pre-sample exact-manifest, and exploratory/non-satisfying language used in RAM-0 and dispatch. |
| F2 | Medium | The new `UNVERIFIED` row and uncertainty list falsely describe worktree, cost state, and context collapse as `ProcessedResume.initialState` riders subject to the thread-goal drop. | Keep these fields `UNVERIFIED`, but remove the false shared mechanism and identify their engine-side restore side effects; require desktop-path verification without predicting the result. |

## F1 — the decision queue retains the “measure both” escape

The normative RAM-0 section is corrected: ruling #1 is a strict predecessor,
the exact sorted feature manifest and probe method must be recorded before the
first sample, and pre-ruling named candidate runs are exploratory and do not
satisfy RAM-0 (`app-cutlist-ram-audit.md:303-313`). The dispatch repeats that
gate correctly (`:592-596`).

Queue item #1 still says feature selection is required “BEFORE or alongside
measurement” and permits the probe to measure “the shipping target, or both
configurations as explicit cohorts” (`:570-572`). That is the rev-3 escape
hatch verbatim in the operator-facing blocking queue. “Both configurations”
cannot identify the intended-shipping configuration before ruling #1 defines
its exact manifest.

Failure scenario: an operator follows the blocking queue, samples a guessed
second configuration alongside the ruling, and treats the session as satisfying
RAM-0 even though the manifest was not finalized before sampling. The later
RAM-0 and dispatch text say those results are non-satisfying, leaving the audit
with two incompatible gates for its first dispatch.

**Disposition:** replace lines 571-572 with a strict statement that ruling #1
must finalize the exact shipping manifest before any shipping-target sample.
Pre-ruling current-featureless or explicitly named candidate runs may be
exploratory only and do not satisfy RAM-0. Remove the “or both configurations”
alternative everywhere outside the intentional revision-history record.

## F2 — the downgraded fields are not dropped `initialState` riders

The thread-goal correction itself is source-accurate. The loader returns the
goal in `ProcessedResume.initialState` (`src/utils/sessionRestore.ts:805-821`),
`resumeEngineSession` returns only the processed messages and engine id
(`app/sidecar/sessionResume.ts:102-112`), and controller creation receives only
those messages (`app/sidecar/index.ts:132-168`). Classifying thread goal as
`DIES` is therefore correct.

The adjacent row adds a broader source claim: “the same drop mechanism as
thread goal applies” to “Worktree, cost-state, other `initialState` riders”
(`app-cutlist-ram-audit.md:503`). The open-uncertainty list extends that
mechanism to worktree, cost state, and context collapse (`:563-565`). Current
source does not support it:

- cost state is restored directly by `restoreCostStateForSession` while
  processing the resume (`src/utils/sessionRestore.ts:683-698`);
- session metadata and worktree state are restored through
  `restoreSessionMetadata` and `restoreWorktreeForResume` side effects
  (`:712-745`);
- context-collapse state is restored through `restoreFromEntries` when the
  feature is enabled (`:748-760`);
- the returned `initialState` contains context initial state, agent fields,
  attribution, standalone-agent context, thread goal, and agent definitions —
  not the three fields named above (`:814-821`).

Failure scenario: the park decision work is scoped as a single dropped-return
repair and either overlooks the existing side-effect paths or treats those
fields as proven losses. Their actual desktop behavior still needs public-path
verification, but it cannot be inferred from the thread-goal mechanism.

**Disposition:** retain the conservative `UNVERIFIED` classification requested
by R3-F3. Rewrite the explanation to say these fields have engine-side restore
paths whose effective desktop behavior must be verified field by field. Remove
the claim that worktree, cost state, or context collapse rides the discarded
`ProcessedResume.initialState`; separately inventory the fields that actually
do ride it.

## Scoped conformance matrix

| Requested check | Result | Evidence |
|---|---|---|
| R3-F1 harness retention and safe-now recomputation | PASS | Both harnesses are retained until equivalent automation; the safe-now bucket contains only the ≈45-line micro-cuts (`:65-73,155-186,585-588,597-598`). |
| R3-F2 strict feature-manifest predecessor | FAIL | RAM-0 and dispatch pass; blocking queue item #1 retains the old escape (`:303-313,570-572,592-596`). |
| R3-F3 thread goal and other state riders | PARTIAL | Thread goal is correctly `DIES` and the remaining row is no longer `SURVIVES`, but its new causal explanation is false (`:502-503,563-565`). |
| R3-F4 effort partition, fallback, and ephemeral test | PASS | Persistable values, ant/external `max`, `ultra`, numeric effort, shared fallback, and the two-session ephemeral case are all covered (`:505-506,516-523`). |
| R3-F5 dispatch gates and existing disposal events | PASS | Dwell is gated on #3, collapse on #8+#9, and disposal consumes existing `session-status (exited, restorable)` plus `session-removed` with no new close signal (`:599-606`). |

## Cross-reference and arithmetic sweep

- Queue/dispatch references are consistent for dwell (#3), status
  acknowledgement (#8), `messageCount` (#9), and both harnesses (#10). F1 is
  the sole stale queue instruction found.
- Section references for the two retained harnesses (§I.3a/§I.3b), safe cuts
  (§I.6), dwell (§I.1), collapse (§I.2), `messageCount` (§I.7), RAM-3.1,
  RAM-3.4, RAM-3.5, and Part III resolve to the intended material.
- The safe-now estimate is internally consistent:
  `13 + 5 + 4 + 4 + 16 + 3 = 45` lines. Retained harness arithmetic is also
  consistent: `356 + 45 = 401`, `154 + 101 + 26 = 281`, and
  `401 + 281 = 682`.
- No new close signal is requested. Uses of that phrase are either the
  prohibition or the intentional revision trail.
- The revision-history mention of the old two-cohort disposition is not treated
  as a live escape. The live queue wording in F1 is.
- Apart from F2, no new rev-4 assertive claim beyond the five dispositions was
  found in the scoped additions.

## Verification boundary

No RAM figure was re-measured or re-litigated. Park design detail beyond the
requested source-behavior corrections and all settled retentions remained out
of scope. This review changed no application source and makes no runtime-test
claim.

```text
VERIFICATION
- git diff --check  → clean
- git diff --no-index --check /dev/null docs/migration/reviews/2026-07-21-app-cutlist-ram-audit-rev4-gate-review.md  → clean (exit 1 means files differ, with no whitespace diagnostics)
- bun run maps:lint  → passed: 18 maps, 8 advisory warnings in existing map files
- cited-path existence check  → all 4 cited files exist
Stale-reference sweep: N/A — no production identifier, path, or interface was renamed or removed
Not run: application build/tests — docs-only scoped review; no runtime source changed and no runtime pass is claimed
```
