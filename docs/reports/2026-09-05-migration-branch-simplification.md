# Migration branch simplification

**Repo:** cat-code · **Branch:** `migration` · **Range:** `8a20b725..c1644613` · **Date:** 2026-09-05

A structural pass over a branch that had grown ~509,000 lines past `main`.
Ten commits, net −3,149 lines, every gate still green, and rather more work
rejected than performed.

| | |
|---|---|
| Net lines | **−3,149** (6,165 added, 9,314 removed) |
| Commits | 10, across 125 files |
| Tests | **4,712 passing / 0 failing** (up from 4,694) |
| Proposals | **71 implemented, 103 rejected** on inspection |
| Agents | 30 (10 survey · 17 implementation · 3 second-pass) |

---

## How the work was scoped

The branch adds ~509K lines, but only ~236K of that is desktop application code
and ~90K is engine change. The remaining ~200K is dated documentation, which
this repo treats as historical record rather than current truth, so it was left
alone.

Ten read-only agents surveyed disjoint slices of the real implementation surface
and returned **81 findings**. Four implementation waves then acted on them, each
agent owning a disjoint set of files so no two could collide.

Three sessions shared this working tree throughout. That constrained the pass in
ways worth recording: two of the largest targets were parked untouched because a
live session held uncommitted edits in them, and two commits had to be assembled
with `git apply --cached` on a hunk-filtered patch so another session's in-flight
work was never swept in.

---

## Verification

Every gate was measured before the first change and again after the last. The
suite grew because agents added coverage, not because tests were relaxed.

| Gate | Before → after | |
|---|---|---|
| `bun test app/` | 4694 → **4712 pass, 0 fail** (284 → 288 files) | green |
| `bun run --cwd app typecheck` | clean → clean | green |
| `bun run --cwd app typecheck:sidecar` | passed, 0 new owned diagnostics | green |
| `bun run --cwd app test:hardening` | 19/19 → 19/19 | green |
| `bun run build:dev:full` | `./cli-dev` built | green |

### One red that is not ours

`bun test src/utils/permissions/` reports 4 failures. I ran the same suite in a
detached worktree at the pre-session commit and got the **identical** failure
set: bare `bun test` compiles the `TRANSCRIPT_CLASSIFIER` gate to false, so the
auto-mode availability tests cannot pass. With
`--feature=TRANSCRIPT_CLASSIFIER --feature=AUTO_MODE_UPSTREAM_PORT` the suite is
119 pass / 0 fail. Pre-existing, not a regression.

---

## What was consolidated

### The transcript projector keeps one projection, not two — 4,233 → 3,385

A 2026-08-23 performance change added a batched mutable-draft projection *beside*
the existing immutable single-frame reducer instead of replacing it. Every
SDKMessage variant, frame kind, dedupe rule and recovery-insert branch had been
written and changed twice ever since. The draft transaction survives;
`projectServerFrame` is now a one-line delegation.

The two paths were **not quite equivalent**, and the file's own differential
oracle could not see it because it compared with `toEqual`: for an assistant
error frame with text but no uuid and no message id, one path returned the state
object unchanged while the other republished a deep-equal copy. That was
corrected rather than inherited. Coverage was re-proved by mutation, not assumed:
breaking draft reuse turns 10 tests red.

### One snapshot-send shape instead of eleven copies — `sidecarServer.ts` 7,225 → 6,894

Adding a per-session read seam used to cost a 27-line `sendXSnapshot` differing
only in domain, frame kind and payload key, plus a byte-identical
`broadcastXSnapshot`. Nine verb handlers opened with the same 17-line
requestId-then-parse-then-reject preamble, nine more repeated the same
domain-missing reply, and an 18-branch `handleFrame` ladder routed verbs through
**five different styles of type test**.

Those are now `sendDomainSnapshot`, `broadcastToConnections`, `parseVerbMessage`,
`requireDomain` and one dispatch table. Validation itself did not move: each
handler still passes its own schema, the vocabulary stays closed, and the
hardening suite is the proof.

### One versioned-preference codec instead of fourteen — 14 codecs → 2

Fourteen modules each carried the same read/write pair: `getItem`, parse, reject
`version !== 1`, validate one field, swallow to null. Three of them cited each
other in the comment explaining the swallow. They now share one codec and keep
only a key, a default, a type and a validator.

Because saved preferences are live user state, the new test types out an
old-format record for all thirteen keys **as literals**, so a silently renamed
key or field fails the suite. `workspaceLayout.ts` was deliberately left alone:
its envelope carries three fields and it removes the key when the layout empties,
which is a different contract rather than this one with a longer argument list.

### One worker runner, one cadence driver, one channel list — `main.ts` 3,876 → 3,706

Three modules independently transcribed the same spawn / framed-stdout / timeout
/ teardown mechanism down to identical variable names, with
`WorkerProcessLifecycle` declared verbatim three times. Eleven `ipcMain.on` verb
handlers differed only in a channel constant.

And the 47 fixed IPC channel names were declared twice, byte for byte, with
nothing enforcing they matched: a rename on one side produced a renderer verb
sent to a channel nobody listens on, with no error and no log. That is now a
compile error.

### Dead code, actually proved dead — −390 `src/tools`, −598 `src/utils`

- A complete second auto-mode classifier sat behind `AUTO_MODE_UPSTREAM_PORT`, a
  gate that is unconditionally on in every build.
- `spawnMultiAgent` carried a 219-line unreachable separate-window path with two
  orphaned tmux helpers.
- An ant-only migration was guarded by `"external" === 'ant'`, a comparison the
  build macro folds to constant false.

The workspace-map lint caught the stale citation left by that last deletion,
which is exactly what it exists for.

### Tests that asserted on source text now press keys — 41 greps, 11 ported

`App.test.tsx` read `App.tsx` as a string in 41 tests and asserted with
`toContain` on sliced text, pinning exact indentation and line breaks. Each
opened by explaining that the renderer suite is SSR-only and cannot press a key.
**That stopped being true** when a DOM harness landed; sixteen files already used
it.

Eleven are now real keydown, paste and drop tests. Most of the rest were *kept*:
on inspection, the module each one named as covering it tested the predicate,
while the bug had been at App's call site. This is why the section added lines
rather than removing the 700 the survey predicted.

---

## The ledger

The honest headline of this pass is the rejection rate. Across four
implementation waves, agents verified each finding against real source before
acting; **103 of 174 proposals were rejected**. A review where everything is real
is the exception, and estimates skew high because they are made from reading two
examples and extrapolating.

**71 implemented.** Verified against source, then changed, then re-verified by
the suite that covers it. One agent ran a **320,000-case differential fuzz** of
old parsers against new before swapping record-narrowing at a trust boundary:
zero mismatches, 22,682 accepts, so the corpus was not vacuously all-reject.
Another proved its surviving test coverage by **mutation** rather than by
counting green ticks.

**103 rejected**, in four recurring shapes:

- **Wrong on reading.** "Nine identical wrappers" was two read and seven
  extrapolated; the other seven had different transaction bodies and return
  contracts.
- **Not actually duplicates.** Of 68 "duplicate" inline icons, most differed in
  viewBox, path, stroke or size. Merging them would have been a visual change.
- **A consumer the survey missed.** Three "dead" components are pinned by name in
  `.design-sync/config.json`.
- **Abstraction would be worse.** Sharing the snapshot-store core needs a generic
  over frame kind and payload with narrowing passed as a callback, to save twenty
  mechanical lines while the doc comments, which are the bulk, survive unmerged.

### The three biggest findings were all rejected

By estimated line count, the top three findings in the whole survey were worth
20,770 lines between them. None was implemented. Each targeted complexity this
branch did not create, or safety it does not have.

| Finding | Est. | Why rejected |
|---|---|---|
| De-compile 325 React Compiler output files | 10,975 | Fork-point artifacts, not this branch's complexity. Mechanically extracting embedded sourcemaps would change memoization across the entire UI. |
| Delete the PowerShell tool | 9,321 | Platform-gated is not dead, and a live session was editing those exact files. |
| Strip 474 stale inline sourcemaps | 474 | Fork-point build artifacts. A build concern, not a source simplification. |

---

## Commits

| sha | subject | files | + | − |
|---|---|---:|---:|---:|
| `1c4ec2c0` | one snapshot-send shape instead of eleven copies | 1 | 105 | 308 |
| `d1787d91` | one verb-parse preamble instead of nine copies | 1 | 57 | 127 |
| `96d3533c` | the transcript projector keeps one projection, not two | 2 | 445 | 1,303 |
| `24b3dbf4` | one versioned-preference codec instead of fourteen | 32 | 974 | 976 |
| `0829849a` | the sidecar test server takes an options object | 8 | 502 | 843 |
| `6a18a621` | one NDJSON worker runner and one cadence driver in main | 20 | 1,728 | 2,114 |
| `2f43f284` | drop the dead auto-mode classifier and the dead spawn path | 28 | 886 | 2,026 |
| `479e99cb` | drop the ant-only migration the external build cannot reach | 3 | 0 | 50 |
| `c788acb1` | one IPC channel list, and real key presses instead of source greps | 27 | 1,094 | 932 |
| `c1644613` | second-pass leftovers, and three sequences that had to stay in sync | 12 | 382 | 643 |

### Net change by area

```
 -728  app/renderer      -598  src/utils        -180  src/hooks
 -668  app/sidecar       -393  app/main          -85  src/migrations
 -390  src/tools         -191  src/services      -76  app/scripts
  -14  app/host           +44  app/preload       +53  app/shared
   +4  src/constants      +74  src/remote
```

---

## Second pass, fresh context

Three agents reviewed the resulting code without being shown the original
findings. Two returned a verdict of **justified**. One ran three independent
duplicate detectors across ~180 renderer modules; the fuzzy pass returned exactly
one hit in the entire scope, and no two files exceeded 33% structural overlap.

**What it still found:** a leftover copy of the shared storage helper in
`Sidebar.tsx`, under a comment citing a location that had stopped existing; an
unsurveyed `app/scripts` where two RAM instruments each carried a full copy of the
measurement readers; and three sequences that had to stay in sync but were written
out repeatedly (a close-text-block sequence seven times in the Codex streaming
translator, a remote permission confirm in all three transports, and one metadata
dispatch twice inside a single function).

**What it disproved:** my own suspicion that `deferredContinuationRunner` held one
lifecycle parameterized by mode. Background is a process-wide singleton; foreground
is a caller-supplied keyed map with an origin that crosses the REPL. They already
share their finalization core.

---

## Left complex, on purpose

**`sidecarServer.ts`, 6,894 lines in one class.** It is the trust boundary. The
inbound vocabulary must be closed and validated in one place, and every verb
handler ends by broadcasting to the same connection set. The two clusters that
could plausibly be lifted out both need to broadcast frames, so lifting them buys
callbacks and a second file for the same state machine.

**`protocol.ts`, 59% doc comments.** 4,315 lines, of which 2,555 are prose citing
the decision each frame shape came from. That is the versioned wire contract's
load-bearing half, and the only thing stopping a future additive change from
quietly breaking it.

**The `contextCollapse` subsystem.** Genuinely dead: its gate is in no build list
and the implementation is 74 lines of stubs returning their arguments. Removing it
fully requires hand-editing two React Compiler output files, and a partial removal
leaves the subsystem half-present, which is worse than either end state.

**The preload's eleven verb senders.** Three identical lines each, but one of them
is the default-deny guard. Factoring it moves the guard a hop away from eleven of
forty-five senders to buy about twenty lines in a 658-line file. An allowlist that
is easy to audit is worth more than a shorter one.

---

## Parked

**Push.** Ten commits sit on `migration`. Pushing publishes other sessions'
commits stacked underneath, so it is yours to call.

```bash
cd /Users/pt/cat-code && git push origin migration
```

**Two targets a live session was holding.** `TranscriptView.tsx` had 39
uncommitted hunks landing directly in `ToolCardShell` and `ToolCard`, the exact
consolidation targets, and another sat inside `SessionPaneProps`, blocking the
70-prop grouping. Worth roughly 950 lines between them once that session lands.

**`bannerStackModel.ts`.** Verified dead, zero production consumers. But
`docs/migration/PARITY-LEDGER.md` records it as a BUILT parity row, so deleting it
is a parity cut requiring a flagged STATUS entry, and `STATUS.md` was another
session's dirty file. Three previous reviews parked it; so did this one, rather
than cut silently.

**`serverFrameBatch.ts`.** Seventeen identically-typed dispatcher fields and
seventeen identical dispatch lines, about 34 lines. Collapsing them requires
editing `App.tsx`, which was unavailable all session.
