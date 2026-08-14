# Renderer incidents final report: memory, freeze, crash, and observability

**Filed:** 2026-08-15
**Status:** Final consolidated record of the 2026-08-09, 2026-08-10, and
2026-08-14 investigations. The renderer-freeze mechanism remains open.
**Scope:** Desktop renderer memory growth, renderer freezes, DevTools-triggered
crashes, the separate engine-hang incident, and the observability decisions that
follow from them.

This report combines the dated reports and design record listed in **Source
records** below. It is the canonical summary of their conclusions, corrections,
and remaining work. Source code remains authoritative when a filed document and
current implementation disagree.

## Executive verdict

The reports describe four distinct findings, not one progressively worsening
failure:

| Date and symptom | Established verdict | Status |
|---|---|---|
| 2026-08-09 apparent freeze, then SIGTRAP | The apparent freeze was hidden-page timer throttling. The later renderer death was a deliberate Chromium PartitionAlloc out-of-memory abort during Blink selection-bounds text shaping. | Crash recovery shipped; the old freeze attribution is withdrawn. |
| 2026-08-10 session left working overnight | The engine stopped after its final assistant message and never emitted `result` or `turn.status`. The UI correctly reflected an engine run that never closed. | Separate engine-hang class; not a renderer diagnosis. |
| 2026-08-14 stopped clock and unresponsive display | React stopped committing `<App>` while frames continued through the delivery pipeline. The renderer freeze is proven, but its mechanism is unknown. | Still open. |
| 2026-08-14 DevTools attach | `Debugger.enable` caused V8 to re-parse renderer scripts. A small allocation failed in an already overloaded renderer and Chromium aborted. The apparent recovery was renderer replacement. | Cause established; recovery path shipped. |

The memory investigation then resolved the largest open question from the crash
side: at 3.9 GB, 3,653 MB was Blink PartitionAlloc and only 182 MB was the V8
JavaScript heap. The renderer's growth is therefore primarily native browser
engine memory created by mounted DOM, layout, text, and highlighting structures,
not application JavaScript state.

## 1. The 2026-08-14 incident

### 1.1 The renderer freeze

Between 07:41:23.539Z and 07:43:24.288Z, the active session produced 2,388
`renderer.state.queued` acknowledgements and zero `renderer.state.applied`
acknowledgements. The source path is closed enough to establish the boundary:

- both acknowledgements are produced unconditionally in the same renderer loop
  (`app/renderer/src/App.tsx:933-936`);
- applied acknowledgements are drained by the post-commit effect at
  `app/renderer/src/App.tsx:610`;
- the effect has no dependency array, so a re-render of `<App>` would have drained
  the pending acknowledgements;
- no downstream acknowledgement rejection occurred.

The strongest supported statement is therefore: **`<App>` did not re-render for
at least 124 seconds while live content continued to arrive and enter the
stores.** The stopped clock, which is owned by a pane, is consistent with that
boundary. The evidence does not establish whether React scheduled no work, or
scheduled work that never reached a commit. It also does not identify why.

The engine was healthy during the window. The turn spanning the later crash
started at 07:39:27.867Z and completed at 07:45:54.019Z, two and a half minutes
after the renderer died. The transport remained intact, and the sidecar, Electron
main process, and GPU were idle rather than busy in a render loop.

The reported `5m 44s` clock value cannot establish the freeze onset. Trace
retention rotated away the beginning of the incident while the investigation was
still running. The freeze lasted at least 124 seconds and may have lasted roughly
fifteen minutes; the exact duration is unrecoverable.

### 1.2 The DevTools-triggered crash

Opening DevTools did not unfreeze the existing renderer. It replaced it.
DevTools sent `Debugger.enable`, which enters V8's debugger path and calls
`CollectSourcePositionsForAllBytecodeArrays()`. Symbolication of the official
Electron 33.4.11 symbols shows the failing path:

```text
PartitionAlloc out-of-memory
  V8 literal buffer growth
  Parser::ParseProgram
  CollectSourcePositionsForAllBytecodeArrays
  V8Debugger::enable
  DevTools protocol dispatch
```

The instruction at the program counter is Chromium's deliberate
`IMMEDIATE_CRASH` sequence. The renderer then followed the recovery path:

```text
renderer.process.gone      reason=crashed, exitCode=5
renderer.recovery.started
renderer.recovery.succeeded
```

DevTools is therefore a **mutating probe**, not a read-only diagnostic tool, for a
loaded renderer. It must not be opened during a long streaming run while the
memory problem remains possible.

## 2. Memory attribution and reproduction

A live `footprint` sample separated the renderer's compartments:

```text
Dirty      Regions   Category
3653 MB    13953     app-specific tag 14, PartitionAlloc / Blink native
 182 MB    10671     app-specific tag 16, V8 / JavaScript heap
```

At that sample, 95% of the renderer was native Blink allocation and the entire
JavaScript heap was 182 MB. JavaScript-state eviction can therefore address only
a small fraction of the observed memory.

The two-session workload that asks each session to read every file over 400 lines
and write a detailed summary reproduced the growth in minutes:

| Point | Renderer footprint | PartitionAlloc dirty | Regions |
|---|---:|---:|---:|
| Fresh launch | 144 MB | 52.1 MB | 852 |
| Both sessions, about 15 minutes | 1,412 MB | 1.1 GB | 5,366 |
| Shortly afterward | 3,974 MB | 3.6 GB | 13,018 |
| Both tabs closed before JavaScript eviction fix | 3,918 MB | 3.6 GB | 14,319 |
| Both tabs closed with eviction fix | 566 MB | 444.1 MB | 8,747 |

The first run grew roughly tenfold in fifteen minutes and accelerated as the
transcript grew. Dirty memory converged on resident memory, showing committed
pages rather than a merely virtual or readily reclaimable reservation.

Closing tabs completely unmounts the transcript DOM and, after the eviction fix,
removes the live projection and raw message logs. PartitionAlloc still retains
committed pages in Chromium's allocator pools. The conclusion is consequently
not to reclaim the memory after allocation, but to prevent unbounded DOM,
layout-object, text-fragment, and highlighting creation during streaming.

### 2.1 The resulting rendering decision

Transcript virtualization is now an evidence-backed primary implementation
target, not a hypothesis about JavaScript state. The design calls for a
hierarchical render-leaf virtualizer rather than a row-only window:

1. Bound Markdown, code, reasoning, tool-output, inspector, and nested-transcript
   leaves.
2. Virtualize outer variable-height transcript items if the stage-one gate shows
   that many short rows and three visible panes still grow with history.
3. Keep the current native pane scroller and use one pane-local measurement and
   scroll-anchor coordinator.

A row-only virtualizer is insufficient because one visible assistant row can
contain the complete accumulated Markdown response and syntax-highlighted code.

Stage one has landed in commits `7115ff71`, `45f3b3f0`, and `af9e082a`. It bounds
transcript Markdown and inspector leaves and converges virtual spacer heights.
It does not yet prove that the outer transcript layer is unnecessary or that the
live memory targets are met.

The design's primary acceptance targets are:

- two-session, fifteen-minute run: renderer footprint below 1.0 GB,
  PartitionAlloc dirty below 700 MB, and fewer than 3,000 regions;
- one long streaming turn: footprint below 750 MB with no renderer error boundary,
  lost click handling, or allocation failure;
- three visible panes: footprint below 1.5 GB with a post-warm-up slope below
  5 MB/minute;
- fixed viewport and state: a tenfold increase in source length increases mounted
  transcript DOM by no more than 15%.

The operator must run the live measurement because the renderer test suite is
SSR-only. A passing headless suite cannot establish scrolling, selection,
expansion, or memory behavior in a live Electron renderer.

## 3. What remains unknown about the freeze

The following are established:

- frames arrived and were acknowledged through the delivery pipeline;
- all stores received them unconditionally;
- the renderer was `visible: true` for the relevant occurrence;
- timers continued firing;
- no acknowledgement rejection occurred;
- `<App>` did not commit renders for the measured interval;
- the engine completed its work normally.

The following are not established:

- whether React scheduled no render, or scheduled one that never committed;
- the exact freeze onset and duration;
- whether the freeze and native memory growth share a mechanism;
- whether replay storms are the source of the memory growth or only a separate
  load amplifier.

The new `rendersCommitted` counter, added in `b110d99e`, addresses the first
missing distinction for future occurrences. `rendererWorkingSetKiB`, added in
`e7aab83e`, provides main-process memory sampling, while `dd866ad0` renamed the
narrow V8 probe to `jsHeapUsedBytes` so it no longer claims to be process memory.
A later stalled-session check used three readings to rule out a renderer failure:
`rendersCommitted` rose from 260 to 302, `renderer.state.applied` tracked
`queued` at 445/445, and `engine.produced` had advanced recently. This confirms
that the new measurements can discriminate a live occurrence; it does not close
the original freeze.

Virtualization is expected to prevent the measured unbounded-memory failure. It
is not, by itself, an explanation for a freeze that occurs with flat memory and
healthy render costs.

## 4. Logging findings and operator decision

The investigations found three observability defects that materially changed the
verdicts:

- `heapUsedBytes` reported only `performance.memory.usedJSHeapSize`, showing
  102-115 MB while the renderer held 6.7 GB. It was renamed to
  `jsHeapUsedBytes`; real process memory is now sampled from Electron main.
- `eventLoopLagMs` is a cached timer-scheduling measurement with a practical
  floor near 4 ms. It proves that a timer fired, not that the renderer committed
  a display update. Its naming and semantics remain a documentation or design
  debt.
- Six roughly 20 MB delivery-trace files can rotate within minutes under replay
  load. The investigation's onset evidence was deleted while it was being read.
  Retention must be changed so bulk records cannot evict the beginning of a bad
  session before it can be investigated.

Two further records need correction rather than more volume:

- `attachment.replayed` is currently stamped while the replay array is built,
  before `deliver()` decides whether a send occurs. It can report delivery that
  never happened. The stamp should represent the actual `webContents.send`, or a
  dropped-stage record should make the early return explicit.
- A replay of roughly 50,000 records in 2.4 seconds is visible only by inferring
  it from file rotation and manual counts. Replay batch size and trigger should
  be represented by bounded metadata, without logging transcript content.

### Operator ruling: adopt the observability minimum

On 2026-08-15, the operator ruled that the proposed
`docs/migration/decisions/OBSERVABILITY-MINIMUM.md` is adopted. The rule is:

> Any operation that can block indefinitely must either log its start or be
> covered by a watchdog that logs its failure to finish. Summary-only records are
> permitted only for operations that cannot hang.

The ruling also adopts these constraints:

- a diagnostic watchdog must not abort the operation unless the abort has a
  separate liveness or recovery justification;
- start records contain only bounded closed-vocabulary metadata, never payloads
  or free-form transcript content;
- records are emitted once per operation or watchdog firing, not once per frame,
  chunk, or poll;
- lifecycle records must be protected from shedding, while high-volume samples
  remain bounded and lower priority;
- a designed terminal state must have its own name rather than appearing as an
  absent completion record;
- labels are populated only from state the emitter directly holds, with
  `unknown` preferred to an inferred but confident-looking cause.

This is not authorization to log more indiscriminately, persist raw sidecar
stderr, or relax the private-diagnostics and rate-budget contracts. Whether to
arm `CLAUDE_ENABLE_STREAM_WATCHDOG` remains a separate liveness decision, and
whether to persist selected sidecar drop reasons remains a separate schema
choice.

## 5. Corrected interpretation of earlier records

### 2026-08-09 SIGTRAP report

The original report's 32 GB PartitionAlloc address-space observation is not
pathology evidence. A healthy renderer has the same fixed virtual reservation.
Dirty bytes and region count are the meaningful measures. The report's region
count observation remains useful.

Its apparent freeze was hidden-page timer throttling: samples pinned near one
second and then one minute, the known Chromium background-throttling constants.
The later crash was a PartitionAlloc out-of-memory abort during Blink
selection-bounds text shaping. That allocation site differs from the 2026-08-14
DevTools crash, although both are the same deliberate Chromium abort class.

### 2026-08-10 overnight engine hang

That session stopped after a final assistant message and before the engine emitted
`result` and `turn.status`. The UI stayed working because the engine run genuinely
never closed. Candidate waits included the post-turn tool-use summary, an
unbounded conversation lock, and stop hooks.

This verdict is correct for that incident only. A stuck-working display is not
proof of an engine hang: the 2026-08-14 renderer freeze produced the same visible
symptom while the engine continued to complete turns. The engine-side
`session.turn.stalled` detector correctly did not fire for the renderer freeze
because engine messages were still flowing.

The old request table that called `messageKind` unavailable was stale. Source
shows that field landed in `5eb76537`.

### Same-day corrections

- The detached-DOM retention claim was retracted after source inspection showed
  that closing tabs unmounts the transcript and the JavaScript eviction fix was
  measured directly.
- Earlier `vmmap --summary` resident and dirty column labels were corrected.
- The earlier plan's decision not to pursue virtualization is superseded by the
  measured compartment attribution and reproduction. Its reasoning about not
  guessing at a memory fix, and about keeping the freeze investigation separate,
  remains valid.

## 6. Current implementation and verification status

The following work is recorded as shipped in the source reports:

- renderer-death recovery, send gating, and recovery replay fixes:
  `6ee65a56`, `fb518346`, `2fc7440c`;
- health and memory observability: `dd866ad0`, `e7aab83e`, `b110d99e`;
- bridge-allowlist drift protection: `f135d6ad`;
- transcript stage-one containment: `7115ff71`, `45f3b3f0`, `af9e082a`.

The stage-one report records `bun test app/` at 3,176 passing and 12 failing,
against a 3,166 passing and 12 failing baseline. The same failures remained:
`app/main/replayBuffer.test.ts` and load-sensitive real-engine or timer tests.
That pass did **not** run `typecheck`, `renderer:build`, or `test:hardening`, so
stage-one live acceptance is not complete.

The desktop security gate was also repaired after two bridge methods landed
without bookkeeping. `openWorkspaceFile` and `stats.query` are now covered, and
the hardening smoke is recorded as 19/19 in the source report.

No claim of full renderer parity or live memory success is made here. The
remaining acceptance work must run the full desktop battery and the operator-run
memory and interaction workloads.

## 7. Playbook for the next occurrence

1. **Do not open DevTools.** It can mutate and kill the renderer being diagnosed.
2. **Route the failure before quitting.** If `engine.produced` has stopped and no
   result follows, investigate the separate engine-hang class. If
   `renderer.state.queued` continues while `renderer.state.applied` is flat,
   investigate a renderer freeze.
3. **Copy the delivery trace immediately.** Current retention can erase onset
   evidence within minutes under streaming or replay load.
4. **Capture the live sidecar stack before teardown** when the engine route is
   indicated. Sampling the known sidecar PID is read-only and can identify an
   unbounded await that no post-mortem log can recover.
5. **Use external renderer measurements.** Sample the live renderer with
   `footprint -p <pid>` and `vmmap --summary <pid>`. Read PartitionAlloc dirty or
   resident bytes and region count; do not use `jsHeapUsedBytes` as process
   memory and do not treat the fixed 32 GB virtual reservation as a leak.
6. **Compare the numeric renderer counters.** `rendersCommitted`, queued versus
   applied counts, and the timestamped working-set sample should turn the next
   occurrence into a mechanism-level report rather than a reconstruction.

## 8. Open work

1. Establish the mechanism of the 2026-08-14 renderer freeze and recover its true
   onset on a recurrence.
2. Run stage-one virtualization against the established one-long-turn and
   two-session workloads. Decide whether the outer variable-height virtualizer
   is required from measured many-short-row and three-pane results.
3. Verify scrolling, expansion, inline-output reveal, inspector behavior,
   keyboard focus, and bounded native selection in a live renderer. The explicit
   parity adaptations are the fixed selection corridor, bounded handling for one
   pathological atomic body, and virtualized painting of long tool output.
4. Fix or explicitly scope delivery-trace retention so incident onset survives
   the investigation window.
5. Stamp replay records after delivery is decided, or record the dropped stage.
6. Give `eventLoopLagMs` a name and contract that do not imply render liveness.
7. Decide separately whether to enable the stream watchdog for liveness and
   whether to persist bounded sidecar drop reasons.

Do not solve these open items by adding a memory ceiling, hiding the DevTools
crash, evicting authoritative transcript state, or treating the 2026-08-14
freeze as an engine hang. Those changes would move or obscure the failure without
addressing the evidence.

## Source records

- `docs/reports/2026-08-14-renderer-memory-attribution.md`
- `docs/reports/2026-08-14-renderer-freeze-and-devtools-crash.md`
- `docs/plans/2026-08-14-desktop-transcript-virtualization-design.md`
- `docs/reports/2026-08-14-desktop-logging-feedback.md`
- `docs/plans/2026-08-14-renderer-freeze-fix-plan.md`
- `docs/migration/decisions/OBSERVABILITY-MINIMUM.md`
- `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md`
- `docs/reports/2026-08-10-overnight-turn-hang-investigation.md`
