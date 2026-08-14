# Renderer freeze and DevTools crash: two faults, one symptom, and no detector for either

Incident of 2026-08-14, investigated and independently reviewed the same day.
Desktop dev app, launch `b6223455` (`app.start` 06:57:13.789Z), branch
`migration`. Two live sessions: `e550b8bf` (active, engine `b977125d`) and
`b86b79c9` (engine `07eb7226`).

Operator symptom: the active session's elapsed clock stopped at
`5m 44s · ↓ 15.5k tokens`, no new transcript rows appeared, and sessions could
not be switched. Opening DevTools appeared to unfreeze the application.

Read the verdict, then "Playbook for the next occurrence". The most important
sentence in this report is that **the 2026-08-10 playbook misroutes this
symptom class**, and following it costs a pass.

## Verdict

There were TWO faults, not one, and the second one destroyed the first one's
evidence.

1. **A renderer freeze.** React stopped committing renders in the renderer for
   at least 124 seconds while frames continued to arrive, be dispatched into
   every store, and be acknowledged. **Cause unknown.** No mechanism has been
   established, and nothing in the current logging stack can observe it.
2. **A renderer crash, caused by opening DevTools.** `Debugger.enable` makes V8
   re-parse every script in the process; in a renderer already holding 6.7 GB,
   that allocation failed and Chromium aborted on purpose. The application did
   not unfreeze: the renderer was replaced.

The two are independent. The freeze was already ≥124 s old when DevTools was
opened, and nothing about a frozen renderer produces a `Debugger.enable`.
**Fixing the crash, or never opening DevTools, will not prevent the freeze.**

The engine was healthy throughout, and this is NOT the engine-hang class of
`docs/reports/2026-08-10-overnight-turn-hang-investigation.md`.

## Proof: the engine was not involved

Positive health, not merely absent evidence:

- Turn ledger for the launch: 9 started / 9 completed, every one `reason: ok`,
  zero `session.turn.stalled`.
- The turn spanning the crash started 07:39:27.867Z and **completed** at
  07:45:54.019Z (`durationMs: 386152`, `reason: ok`) — 2.5 minutes *after* the
  renderer died and was replaced. The engine ran straight through the renderer's
  death.
- Transport intact across the freeze window: `engine.produced` 2,377 →
  `sidecar.socket.sent` 2,378 → `supervisor.socket.received` 2,374 →
  `preload.received` 2,387. No loss.
- Process samples: both sidecar main threads in `kevent64`, Electron main in
  `mach_msg2_trap`, GPU idle.

## Proof: the renderer stopped committing

Between 07:41:23.539Z and 07:43:24.288Z, for the active session:
**2,388 `renderer.state.queued`, 0 `renderer.state.applied`.**

The chain is closed in source:

- Both acknowledgements are produced in the same loop, same iteration, both
  unconditional: the queued ack is sent at `app/renderer/src/App.tsx:933` and
  the applied ack is pushed onto `pendingDeliveryStateAcksRef` at `:936`. So
  2,388 entries were sitting in that ref.
- The post-commit effect at `app/renderer/src/App.tsx:610` has **no dependency
  array** and `splice(0)`s the entire array. A single re-render of `<App>` in
  those 124 seconds would have emitted thousands of applied acks. Zero arrived.
- Nothing swallowed them downstream: zero `trace.ack.rejected` records in the
  window, and the preload's acknowledgement queue is stage-blind
  (`app/preload/deliveryAckQueue.ts:111`).

The frames were real content, not idempotent snapshots that could legitimately
bail out of rendering. By `messageKind` (see "Corrections" below), the 2,388
frames were 2,323 `stream_event`, 15 `assistant`, 7 `user`, 3 `system` and 40
snapshot frames — and the same mix produced `applied ≈ queued` in healthy
windows (1,532 / 1,529 over 19 minutes; 469 / 472 over 52 seconds).

Scope of the claim: this proves `<App>` did not re-render. It does not prove no
fiber anywhere rendered. The operator's stopped elapsed clock, which a pane
owns, covers the remainder.

## Proof: DevTools caused the crash

`EXC_BREAKPOINT` / `SIGTRAP` on `CrRendererMain`, `exitCode: 5`. The
`instructionByteStream.atPC` decodes to `brk #0` / `hlt #0` / `brk #1` —
Chromium's `IMMEDIATE_CRASH`, a deliberate abort.

Symbolicated against the official `electron-v33.4.11-darwin-arm64-symbols.zip`
(framework UUID `4c4c44bc-5555-3144-a1ff-8f155e198779`, matching the report).
Every frame resolves inside a function:

```
 0-2   partition_alloc::internal::OnNoMemoryInternal / OnNoMemory / RunPartitionAllocOomCallback
 3-4   WTF::PartitionsOutOfMemoryUsing1G / WTF::Partitions::HandleOutOfMemory
 5-8   PartitionRoot::OutOfMemory <- PartitionDirectMap <- PartitionBucket::SlowPathAlloc
 9-10  allocator_shim::PartitionMalloc <- operator new
11-13  v8::internal::LiteralBuffer::ExpandBuffer / AddTwoByteChar / Scanner::Next
14-20  v8::internal::Parser::ParseProgram -> parsing::ParseAny
21-23  Compiler::CollectSourcePositions <- Isolate::CollectSourcePositionsForAllBytecodeArrays()
24-27  v8::internal::Debug::UpdateState <- V8Debugger::enable <- V8DebuggerAgentImpl::enable
28-33  protocol::Debugger::DomainDispatcherImpl::enable <- DevToolsSession::DispatchProtocolCommand
34-43  mojo IPC -> base::RunLoop -> content::RendererMain
```

Reading: opening DevTools sent `Debugger.enable`; V8's debugger-enable path
calls `CollectSourcePositionsForAllBytecodeArrays()`, which re-parses every
script in the renderer; one scanner literal-buffer growth could not get memory
from PartitionAlloc, and Chromium aborted.

This is **not** "DevTools perturbed a fragile renderer". It is the specific,
named operation DevTools performs on attach, doing an unbounded amount of
allocation. Treat DevTools as a mutating probe on a loaded renderer, never a
read-only one.

The renderer was then replaced, which is what looked like recovery:

```
07:43:27.157Z renderer.process.gone      {reason: crashed, exitCode: 5, pid: 97507}
07:43:27.157Z renderer.recovery.started  {count: 1, reason: crashed}
07:43:27.340Z renderer.recovery.succeeded {pid: 3609}
```

Relationship to `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md`: frames
0-10 are byte-for-byte that report's abort sequence, so the **abort class is the
same**. The allocation site is entirely different — V8 re-parsing here, Blink
text shaping on selection bounds there. The 2026-08-09 attribution to the
unvirtualized transcript render path is **not** evidence for this crash, and was
itself flagged as inferred in that report.

## Why nothing detected it

- **`session.turn.stalled` is engine-side only.** `observeTurnEvent`
  (`app/sidecar/sidecarServer.ts:1500`) resets its quiet clock on engine
  `message` events, which were flowing normally. It correctly never fired. It
  cannot see a renderer that stops applying what it receives.
- **The delivery-trace quiescence verdict never armed.** It fires only after
  five minutes with no marks at Electron main, and main was receiving frames
  throughout.
- **Restoring what `bb7d5964` removed would NOT have caught this.** That commit
  truncated the stall verdict at `preload.received`. Its premise about
  `renderer.ui.committed` being absent is correct and explained by source
  (`app/renderer/src/App.tsx:622` and `:945`); its premise that
  `renderer.state.applied` merely "lags" is not supported — in healthy windows
  applied tracks queued closely. But the verdict path compares **watermarks**
  derived from a `contiguous()` scan over a 2,048-sequence-per-stream in-memory
  ring that evicts hard under this load (3,314 to 10,662 `trace.loss`
  `in_memory_eviction` records per trace file). For this session both
  `preloadReceived` and `applied` sat pinned at 363 for the whole incident, so
  the comparison would have returned `null`. The full chain is in any case
  retained in the forensic summary (`app/main/deliveryTraceSink.ts:666`); only
  the verdict label was narrowed.
- **There is no renderer-freeze detector at all.** The 2026-08-10 work built an
  engine-stall detector. The signal that does work here is a *count* over a
  sliding window (2,388 queued against 0 applied is unmistakable), not a
  watermark comparison.

## Instrumentation that was blind, and by how much

| Probe | Reality |
|---|---|
| `heapUsedBytes` | `performance.memory.usedJSHeapSize` (`app/preload/preload.ts:148`) — V8 JS heap ONLY. Reported 102-115 MB while the renderer process held **6.7 GB** (peak 6.9 GB). The 2026-08-09 report added this field "to give the next memory incident a growth curve". It did not. |
| `eventLoopLagMs` | A cached value written by a nested `setTimeout(0)` off a 5 s interval (`app/preload/preload.ts:88`) and read verbatim at probe time, floored around 4 ms. "4.5 ms, healthy" proves timers fire, nothing more. |
| Process `sample` | Carries `Physical footprint`, the number that mattered. Check the sample's own `Date/Time` header: the samples taken in this incident are stamped 07:38:26.545Z, three minutes *before* the earliest surviving trace record and inside an engine-idle gap, so they do not characterise the freeze window. |

## A separate live pathology: replay storms

Found while reviewing, still occurring, and **not** established as related to
this incident. At 08:03:50.4-08:03:52.9Z Electron main emitted roughly 50,000
`attachment.replayed` plus `main.ipc.queued`/`sent` records in 2.4 seconds
(25,159 in a single trace file, verified), filling three 20 MB trace files back
to back at about 25 MB/s and driving the then-current renderer to an 859 MB
peak. The same signature appears in the pre-crash window (1,883
`attachment.replayed` for `b86b79c9` with no matching `preload.received`) and
across 07:44-08:03 (8,807 more).

`deliver()` ships an entire replay as one `webContents.send` of the whole array
(`app/main/main.ts:910`). This is a credible source for the old renderer's
6.7 GB and deserves its own scoped investigation. It reproduces live, unlike the
freeze.

## Corrections to existing records

- **`docs/reports/2026-08-10-overnight-hang-log-request.md` row B3 is stale.**
  It marks the event-type bucket on delivery-trace records as "Dispatched".
  It landed as `5eb76537`, the field is `messageKind`
  (`app/main/deliveryTraceSink.ts:110`). The first pass of this investigation
  trusted that row, concluded the frame composition was unknowable, and left the
  central claim open on a weaker argument. Source wins over dated docs
  (CLAUDE.md §8.2); this is that rule costing a conclusion. The row is corrected
  in place.
- The 2026-08-10 investigation's UI conclusion — "stuck working means the
  engine's run never closed, NOT a renderer bug" — is true of that incident and
  false as a general rule. Both causes produce an identical symptom.

## Playbook for the next occurrence

Symptom: a session shows working, no new rows, and the app otherwise responds.

1. **Do not open DevTools.** It is not a read-only probe. On a renderer that has
   been streaming for a long session it can trigger the abort documented above,
   destroying the state you are trying to inspect.
2. **Discriminate engine hang from renderer freeze first**, in the session's
   delivery trace. Engine hang: frames stop being produced. Renderer freeze:
   `renderer.state.queued` keeps counting up while `renderer.state.applied`
   stays flat. This single comparison routes the whole investigation, and
   getting it wrong costs a pass.
3. **Sample the renderer and read `Physical footprint`**, not `heapUsedBytes`.
   Check the sample's `Date/Time` header against the window you are reasoning
   about. Sampling is read-only; do not pattern-kill anything (CLAUDE.md §4).
4. **Copy the session's delivery-trace files immediately.** Retention is six
   files / 100 MB and rotates in minutes under streaming load. Files from the
   start of this incident were destroyed *during* the investigation, which is
   why the freeze onset is unknown.
5. Check `messageKind` on the queued frames to establish whether real content
   was arriving, rather than snapshots that may legitimately bail out.

## Open questions

**Partly answered the same evening.** The 6.7 GB is attributed in
`docs/reports/2026-08-14-renderer-memory-attribution.md`: 95% of the renderer is
Blink PartitionAlloc, the JavaScript heap is 182 MB, and the growth reproduces on
demand in about fifteen minutes. The freeze below remains unexplained.

- **Why React stopped committing.** Established: frames arrived, were dispatched
  unconditionally into all twenty stores, the event loop was idle with timers
  firing, the window was `visible: true` throughout, no acknowledgements were
  rejected, and `<App>` did not re-render for ≥124 s. Every "the frames never
  reached the stores" path is closed in source (`withBatch` is a pure fold at
  `app/renderer/src/serverFrameBatch.ts:35`; `applyServerFrameBatch` dispatches
  unconditionally). No mechanism is established. What would settle it: a
  renders-committed counter in the health payload, incremented in the same
  post-commit effect, separating "React scheduled nothing" from "React scheduled
  and never ran". Nothing in the current stack distinguishes those.
- **Freeze onset.** Unrecoverable; traces rotated. `5m 44s` is inconsistent with
  a freeze starting at the 07:41:23 rotation boundary and may indicate an onset
  near 07:27:50-07:28:00, making the freeze ~15.5 minutes rather than 2. Not
  confirmable.
- **Whether the 6.7 GB caused the freeze.** No mechanism established in either
  direction.
- **Whether the replay storms are the memory source.** Would be settled by
  logging replay batch sizes alongside the renderer's real footprint.

## Recommended next steps

1. Add the two probes that would make a recurrence diagnosable: a
   renders-committed counter, and real process memory from the main side
   (`webContents.getProcessMemoryInfo()`).
2. Investigate the replay storms, which reproduce live.
3. A renderer-freeze detector based on counting applied against queued over a
   sliding window, which is a different mechanism from the watermark comparison
   `bb7d5964` narrowed.
4. **Not** transcript virtualization on this incident's evidence. It may still
   be worth doing, but nothing here supports it.
