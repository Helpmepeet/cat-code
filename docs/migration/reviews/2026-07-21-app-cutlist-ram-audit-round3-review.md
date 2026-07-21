# Round-3 adversarial review — desktop cut-list + RAM audit (2026-07-21)

**Reviewed artifact:**
`docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md` rev 3

**Verdict: RED — rework before using rev 3 as a dispatch plan.**

Rev 3 correctly retains `f2-attach-smoke`, identifies the existing clean-close
host event, and adds the right minimum sidecar latch ordering for the
submit-vs-park race. It nevertheless introduces or retains five dispatch-level
defects. The largest cut in the recomputed safe-now bucket is not safe: the
281-line `harness-demo` trio is a contract-named end-to-end verification
artifact. The RAM-0 protocol also permits an “intended-shipping” feature cohort
before that feature manifest exists, so the prerequisite measurement session is
not reproducibly dispatchable. Two park-survival rows remain false or
incomplete, and the suggested dispatch section still carries stale decision
numbers and the superseded instruction to design a new close signal.

## Findings

| ID | Severity | Finding | Owner / disposition |
|---|---|---|---|
| F1 | High | The ≈326-line safe-now bucket is overstated by ≈281 lines because `harness-demo` is a contract-named, executable P3-H integration proof, not an unreferenced throwaway. | Audit author: retain the trio until equivalent automated end-to-end coverage lands; recompute safe-now to ≈45 lines meanwhile. |
| F2 | High | RAM-0 allows measurement against an undefined “intended-shipping” feature configuration when the feature ruling is still open. | RAM-0 owner: require a checked-in exact feature manifest before shipping-target runs; exploratory candidate manifests must be separately named and cannot substitute for the post-ruling cohort. |
| F3 | Medium | The park matrix says `thread goal` survives, but desktop resume discards the restored `initialState` that contains it and constructs a fresh store with `threadGoal: null`. | Park decision owner: classify thread goal as DIE in the current path or fund/wire its restoration; add a public park→restore goal assertion. |
| F4 | Medium | The effort split is still incomplete: `ultra` is a selectable non-persistable value, `max` persists for ant users, and an ephemeral value can reveal an older/current shared setting on restore rather than simply reset. | Park decision owner: partition by actual persistence condition and state the restore fallback explicitly; extend the two-session test matrix. |
| F5 | Medium | The suggested dispatch section contradicts the reordered queue and the rev-3 close-signal correction. | Audit author: repair the dispatch gates and require disposal to consume the existing host event, with no new close signal. |

## F1 — `harness-demo` is not a safe deletion

Rev 3 calls the trio “throwaway demo drivers” referenced by no contract doc and
assigns all 281 tracked lines to safe-now
(`app-cutlist-ram-audit.md:55-56,157-162`). Source-of-contract evidence says the
opposite:

- The decided P3-H design makes the script its fifth verification layer and
  specifies its end-to-end obligations: launch the dev renderer, wait for the
  real readiness/export predicates, traverse renderer bridge → IPC → picker
  bypass → cwd token → validation → spawn, then prove two same-cwd sessions with
  distinct PIDs (`specs/2026-07-05-gui-harness-design.md:241-273`). Its file plan
  names `app/scripts/harness-demo.ts` (`:275-286`).
- The authoritative P3-H backlog says to implement that design verbatim
  (`backlog/phase3.md:679-708`), and STATUS records “scripted demo” as a landed
  P3-H deliverable (`STATUS.md:162`).
- The current script still performs the executable proof: it launches Vite and
  Electron with all three dev-harness flags
  (`app/scripts/harness-demo.ts:53-92`); its driver exercises the page bridge and
  requires two ready same-cwd sessions with distinct engine PIDs plus the 0600
  debug artifact (`harness-demo-driver.ts:18-53`).
- `harnessDemoSource.test.ts` checks cleanup/source strings only (`:4-25`); it
  does not execute or replace that integration path.

Failure scenario: the safe-cuts dispatch deletes the only runnable P3-H
end-to-end proof. A later change can leave the pure `devHarness` tests green
while breaking the dev preload bundle, IPC registration, picker-token chain,
Electron launch, debug export, or two-sidecar composition.

**Disposition:** retain all three files, or first land an automated integration
test proving the same production entry points and failure modes. With the trio
removed from the bucket, the stated safe-now total falls from ≈326 to the ≈45
micro-cut estimate. This is distinct from round-2's `f2-attach-smoke` finding:
rev 3 corrected that harness but made the same unsupported classification for a
different contract artifact.

## F2 — RAM-0's feature cohort does not exist until ruling #1 lands

The protocol says either the feature ruling lands first **or** measurement runs
both “current-featureless” and “intended-shipping” configurations
(`app-cutlist-ram-audit.md:279-285`). The queue and dispatch preserve the same
escape hatch: feature choice may land “alongside” measurement, and an unruled
run should measure “both feature configs” (`:535-538,556-558`). But rev 3 never
defines an intended-shipping feature manifest; deciding that manifest is the
open ruling itself.

Failure scenario: RAM-0 guesses a candidate subset of the roughly forty
`dev-full` features, records decision-grade medians, and the operator later
chooses a different shipping set. Module reachability, initialization, and
runtime allocations differ, so every dependent delta must be rerun despite the
protocol claiming the prerequisite is complete.

**Disposition:** make ruling #1 a strict predecessor for shipping-target
measurement. Record the exact sorted feature manifest (and build/probe method)
in the raw-results artifact before the first run. Pre-ruling exploration may
measure explicitly named candidate manifests, but those results remain
exploratory and do not satisfy RAM-0. “Alongside” is acceptable only if the
manifest is finalized and recorded before sampling begins.

The rest of the RAM-0 requirements — retained probe/corpus/raw artifact,
private-dirty/footprint alongside RSS, repetitions, range, and counterbalanced
order — are appropriate. No RAM number was re-measured in this review.

## F3 — desktop resume drops the restored thread goal

The matrix groups `thread goal` with surviving IDs/cwd/title/worktree/cost state
(`app-cutlist-ram-audit.md:473`). The engine loader does recover it, and
`processResumedConversation` places it in `ProcessedResume.initialState`
(`src/utils/sessionRestore.ts:805-821`). The desktop sidecar then drops that
state:

- `resumeEngineSession` returns only `{ engineSessionId, messages }`
  (`app/sidecar/sessionResume.ts:102-112`).
- `index.ts` threads only `resumed.messages` into controller construction
  (`app/sidecar/index.ts:132-168`).
- `createNormalSidecarQueryEngineConfig` creates a new store from
  `getDefaultAppState()` plus permission context and persisted effort
  (`app/sidecar/sessionController.ts:191-207`); the default thread goal is null
  (`src/state/AppStateStore.ts:486-518`).
- The renderer submit path deliberately sends no `goalSnapshot`
  (`app/renderer/src/App.tsx:1417-1441`), so the retained renderer cannot repair
  the loss on the next turn; the restored sidecar's null goal snapshot instead
  becomes current display state.

Failure scenario: park a session with an active thread goal, restore it, and the
Goals panel/diagnostic identity and subsequent controller state have no goal
despite the decision matrix promising survival.

**Disposition:** classify thread goal as DIE for the current desktop path, or
thread the processed initial state (or a narrower verified goal restoration)
into the sidecar's real app-state store. Acceptance needs a public
spawn→goal→park→restore assertion, not merely proof that the JSONL loader found
the field.

## F4 — the effort partition omits live cases and restore fallback

Rev 3 lists shared-surviving `low/medium/high` and dying
`xhigh/max/numeric` (`app-cutlist-ram-audit.md:475-476`). Current engine truth is
broader:

- `ultra` is an `EffortLevel` (`src/utils/effort.ts:13-20`) and is exposed by the
  desktop's engine-owned options for `gpt-5.6-sol` and `gpt-5.6-terra`
  (`:82-89`; `app/sidecar/runControlsDomain.ts:300-306`). It is not persistable.
- `max` is persistable when `USER_TYPE=ant`, while external users get
  session-only max (`src/utils/effort.ts:121-136`). The blanket DIE row is
  therefore configuration-dependent.
- Selecting a non-persistable value does not clear an existing persisted
  `effortLevel`; the write path simply performs no settings write
  (`src/commands/effort/effort.tsx:16-27`). On restore the new sidecar reloads
  the current shared persisted value (`sessionController.ts:195-207`). Thus a
  session can run at `xhigh`/`ultra`, park, then restore at an older `high` (or a
  value another session wrote), not necessarily at auto/default.

Failure scenario: the operator accepts the documented DIE behavior, but a Sol
session at `ultra` is absent from the test matrix, or an ephemeral selection
restores as an old/shared value and silently changes behavior behind the kept
tab.

**Disposition:** split the matrix as follows: persistable shared values =
`low/medium/high` plus conditional ant `max`; ephemeral override =
`xhigh/ultra/numeric` plus external `max`; restore result for the latter = the
then-current persisted shared value when one exists, otherwise model/default
resolution. The pairwise test should seed a persisted value, select an
ephemeral value in A, mutate or preserve the shared value from B, then restore
A. Numeric effort should be labeled engine-reachable but not currently offered
by the desktop picker.

## F5 — the dispatch recipe still encodes the old queue and old signal design

Three contradictions remain in the executable handoff:

1. The dwell deletion is scheduled “after ruling 2”
   (`app-cutlist-ram-audit.md:561-562`), but the reordered queue makes dwell the
   explicit UX ruling **#3** (`:535-540`). Ruling #2 only funds measurement.
2. The status-collapse dispatch mentions only message-count ruling #9
   (`:563-564`), omitting the required StatusBadge visible-change acknowledgment
   at ruling #8 (`:547-549`).
3. The renderer-disposal dispatch says it includes “designing the
   renderer-visible close signal” (`:565-566`), contradicting rev 3's corrected
   source account: the existing host `session-status` transition already carries
   `(exited, restorable)` (`:361-388`; production source
   `app/host/host.ts:452-482`) and the audit explicitly says not to invent a
   second signal.

Failure scenario: a worker follows the suggested sequence, lands the dwell or
badge behavior without its operator ruling, or spends a session widening the
control-plane/preload surface for a close event that already exists.

**Disposition:** gate dwell on queue #3; gate the status collapse on both #8 and
the selected #9 direction; describe RAM-3.4 as wiring one `session-dispose`
action from the existing `session-status (exited, restorable)` and
`session-removed` events. No new close signal is part of that session.

## Re-checked and cleared in round 3

- `f2-attach-smoke` is correctly retained pending equivalent automated
  two-sidecar coverage.
- The new parking latch requirement is the correct minimum linearization rule
  for the source-visible submit race: `handleSubmit` checks and sets
  `activeTurn` synchronously (`sidecarServer.ts:1039-1052`), so a sidecar-local
  latch set before the final gate check can reject latch→submit and let an
  already-accepted submit abort submit→latch parking. The implementation and
  ack-flush/quiescence mechanism remain DESIGN/UNVERIFIED, as rev 3 states.
- Clean close really does emit the existing host-plane
  `session-status (exited, restorable)` event (`host.ts:452-482`), and the
  renderer currently folds it only through preview/shell handling
  (`App.tsx:646-689`). Rev 3's main RAM-3.4 correction is sound; F5 is against
  the stale dispatch sentence.
- The safe micro-cut arithmetic is internally consistent at ≈45 lines. The
  three-bucket arithmetic `281 + 45 = 326` is also arithmetically correct; F1 is
  the classification of the 281-line term, not a recount complaint.
- No quantitative RAM claim was promoted or rejected. All remain SCRATCH pending
  a corrected RAM-0 run.

## Verification

- Re-derived the rev-3 focus claims from the current migration contracts and
  production source; no app/engine source was modified.
- Did not run the app battery: this review changes documentation only and makes
  no runtime pass claim.
- Docs-only checks are recorded with the review handoff.
