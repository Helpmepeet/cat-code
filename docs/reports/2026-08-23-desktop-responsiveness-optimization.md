# Desktop responsiveness optimization investigation

**Date:** 2026-08-23
**Status:** Evidence-backed proposal, corrected after implementation-readiness review; no application implementation changes
**Scope:** Electron desktop app (`app/`), user-perceived responsiveness
**Recommendation:** Replace sequential immutable transcript batch folding with a batch-aware transcript projection transaction.

## Executive summary

The highest-confidence desktop responsiveness opportunity is the transcript replay projector.

The desktop delivery path already sends replay frames in a batch and performs one React dispatch per store. The transcript store nevertheless implements that dispatch by reducing every frame through the ordinary immutable single-frame reducer. Each assistant frame scans the complete row list twice and copies multiple growing records. Replaying `R` one-row assistant frames therefore performs quadratic work before React can commit the restored transcript.

A benchmark importing the production projector reproduced the scaling:

| Replay frames | Median projection time |
|---:|---:|
| 1,100 | 41.79 ms |
| 2,000 | 128.75 ms |
| 2,200 | 158.01 ms |
| 4,000 | 505.60 ms |
| 8,000 | 2,118.90 ms |

Doubling 2,000 to 4,000 frames increased runtime 3.93 times. Doubling 4,000 to 8,000 increased it 4.19 times. The current restored-history limit is 4,000 frames, while the live replay ring permits 8,000 frames.

The recommended change is a transcript-specific `projectServerFrames(state, frames)` path that clones each touched session once, processes the ordered batch through mutable working indexes, then publishes one immutable state. The ordinary `projectServerFrame()` path should remain for single live frames. This keeps protocol, security, event ordering, and raw-event fidelity unchanged while moving append-heavy replay projection toward linear complexity.

## Question and constraints

The investigation was narrowed with the operator before source review:

- Target: the Electron desktop application under `app/`.
- Priority: user responsiveness.
- Deliverable: an evidence-backed proposal, not implementation.

Three read-only investigations ran independently:

1. Renderer computation and repainting.
2. Event delivery and renderer ingestion.
3. Startup, session creation, and restore lifecycle.

Their claims were treated as leads rather than conclusions. The relevant source paths were then checked directly, and the renderer and delivery-trace candidates were benchmarked against the production modules. No Electron window was launched, no GUI was driven, no live account was accessed, and no user transcript or diagnostics content was inspected. Concurrent edits existed elsewhere in the desktop tree; the projector, batch wrapper, preview reducer, replay benchmark, limits, and replay-buffer files used for the primary finding had no uncommitted changes.

## Primary finding: transcript batching stops at dispatch

### Current path

A replay or restore reaches the renderer as a `ServerFrame[]`:

1. `app/renderer/src/App.tsx:1001-1050` receives the array and calls `applyServerFrameBatch()`.
2. `app/renderer/src/serverFrameBatch.ts:78-119` dispatches one batch action to each store.
3. The transcript store uses `projectServerFrameBatched = withBatch(projectServerFrame)` at `app/renderer/src/previewTranscriptState.ts:79`.
4. `withBatch()` at `app/renderer/src/serverFrameBatch.ts:35-40` implements the batch as `action.actions.reduce(reducer, state)`.
5. Every frame therefore runs the complete immutable `projectServerFrame()` path at `app/renderer/src/transcriptProjector.ts:1265-1392`.
6. Assistant frames reach `projectAssistantFrame()` at `app/renderer/src/transcriptProjector.ts:1502-1605` and then `upsertExistingRows()` at `app/renderer/src/transcriptProjector.ts:2551-2561`.

The cache-preview path has the same behavior. `projectPreviewTranscriptCache()` at `app/renderer/src/previewTranscriptState.ts:123-138` projects its cached frames through the same generic batched reducer before admitting the preview.

### Why it is quadratic

For each assistant frame, `upsertExistingRows()`:

- maps every existing row to replace a matching row;
- maps every existing row again to build a `Set` of row IDs;
- filters the replacement rows before appending new ones.

For `R` distinct one-row assistant frames, the two explicit row scans perform:

```text
2 × (0 + 1 + ... + R - 1) = R(R - 1)
```

That is already quadratic. `projectAssistantFrame()` also creates growing copies of `nextBlockIndexByMessageId` and `seenFrameIds` for each distinct message, so optimizing only the row lookup would not remove all quadratic behavior.

The generic batching layer reduces React dispatch and commit count, which was the purpose of the original F3 change. It does not reduce projector work inside that dispatch. One dispatch is therefore not one projection transaction.

### User-visible trigger

The cost occurs when a large frame set is projected before the renderer can commit it:

- restoring a parked or restorable session;
- rebuilding live state after a renderer reload;
- projecting a cached transcript preview.

Because the reducer runs synchronously on the renderer thread, projection delays the restored transcript paint and competes with input and layout work. The benchmark isolates reducer CPU and does not include React rendering, markdown parsing, or DOM layout, so it should be interpreted as a lower-level blocking component rather than an end-to-end interaction measurement.

Load-earlier is not a beneficiary of the renderer-only transaction proposed here. The sidecar sends recovered messages one at a time at `app/sidecar/sidecarServer.ts:4164-4194`. Main arms replay coalescing only for lazy restore and open-history at committed-source `app/main/main.ts:2267-2275` and `app/main/main.ts:2364-2427`; without that state, `app/main/attachmentGate.ts:73-78` immediately returns each frame as a one-element delivery. The renderer would therefore invoke the batch projector repeatedly with singleton batches. Optimizing load-earlier would be a separate bounded main-process coalescing change that preserves recovered-head ordering, completion settlement, limit-triggered partitions, timer flush, and interruption behavior.

## Reproduced benchmark

### Fixture

The benchmark imported the production `createTranscriptState`, `projectServerFrame`, `withBatch`, and `batch` functions. Each delivery contained:

- one valid `ready` frame;
- `R` replayed assistant message frames;
- one short text block and one distinct UUID per assistant frame.

The frames were constructed before timing. Each size ran three times after one 100-frame warm-up, and the median was reported. Bun reported version 1.4.0 on macOS arm64.

### Results

| Frames | Run 1 | Run 2 | Run 3 | Median |
|---:|---:|---:|---:|---:|
| 1,100 | 64.31 ms | 41.79 ms | 37.14 ms | 41.79 ms |
| 2,000 | 119.98 ms | 130.84 ms | 128.75 ms | 128.75 ms |
| 2,200 | 170.45 ms | 158.01 ms | 152.33 ms | 158.01 ms |
| 4,000 | 517.68 ms | 505.60 ms | 484.30 ms | 505.60 ms |
| 8,000 | 2,118.90 ms | 2,116.74 ms | 2,146.49 ms | 2,118.90 ms |

The benchmark is reproducible from the repository with this exact command. Absolute times vary by machine; the scaling ratio is the decision evidence.

```sh
cd /Users/pt/cat-code && bun -e '
import { createTranscriptState, projectServerFrame } from "./app/renderer/src/transcriptProjector.ts";
import { batch, withBatch } from "./app/renderer/src/serverFrameBatch.ts";
const SID = "replay-session";
const ready = { kind: "ready", protocolVersion: 1, sessionId: SID, engineSessionId: `engine-${SID}`, payload: { type: "app.ready", protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: "idle" }, goalSnapshot: null, pendingPermissionRequests: [] } };
const assistantFrame = index => ({ kind: "event", protocolVersion: 1, sessionId: SID, replay: true, event: { type: "message", message: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `replay body ${index}` }] }, uuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` } } });
const reducer = withBatch(projectServerFrame);
reducer(createTranscriptState(), batch([ready, ...Array.from({ length: 100 }, (_, index) => assistantFrame(index))]));
const output = [];
for (const count of [1100, 2000, 2200, 4000, 8000]) {
  const delivery = [ready, ...Array.from({ length: count }, (_, index) => assistantFrame(index))];
  const runs = [];
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    const state = reducer(createTranscriptState(), batch(delivery));
    const elapsed = performance.now() - started;
    if (state.sessions[SID]?.rows.length === count) runs.push(elapsed);
    else throw new Error(`bad row count for ${count}`);
  }
  const sorted = [...runs].sort((a, b) => a - b);
  output.push({ frames: count, runsMilliseconds: runs.map(value => Number(value.toFixed(2))), medianMilliseconds: Number(sorted[1].toFixed(2)) });
}
console.log(JSON.stringify(output, null, 2));
'
```

The current source limits make these sizes relevant:

- `app/shared/limits.ts:167-168` permits 4,000 restored-history frames within 4 MiB.
- `app/main/replayBuffer.ts:81-83` permits 8,000 retained ring frames within 8 MiB.
- The sizing evidence in `app/shared/limits.ts:156-165` says the byte cap commonly binds around 1,100 to 2,200 messages. Real deliveries contain a mix of frame types and message shapes, so that corpus range is context rather than a claim that every real restore matches this synthetic assistant-only fixture.

### Interpretation limits

The benchmark proves the projector's scaling and renderer-thread CPU cost. It does not prove an end-to-end Electron latency number because it excludes:

- IPC and preload work;
- React scheduling and commit;
- markdown parsing;
- DOM construction and layout;
- development-versus-packaged renderer differences;
- real transcript mixtures, replacement rates, and message block counts.

Those exclusions do not weaken the complexity finding. They limit the amount of user-visible improvement that should be claimed before implementing and measuring the full path.

## Proposed implementation shape

Add a transcript-specific batch transaction rather than making generic `withBatch()` stateful.

### Production behavior

1. Introduce `projectServerFrames(state, frames)` adjacent to `projectServerFrame()` in `app/renderer/src/transcriptProjector.ts`.
2. Group or route frames by addressed session while preserving global arrival order.
3. On first mutation of a session in the batch, create one working session copy.
4. Clone growing collections once per touched session:
   - rows;
   - seen frame IDs;
   - block indexes;
   - streaming block state;
   - correlation maps that the batch actually changes.
5. Maintain a temporary row-ID-to-index map for replacement and streaming finalization.
6. Apply every frame in order to the working state, including recovered head insertion and terminal settlement.
7. Publish one immutable session object and one outer transcript state after the batch.
8. Keep `projectServerFrame()` as the authoritative single-frame path for live deliveries and tests.
9. Route both `reduceLiveTranscriptState()` and `projectPreviewTranscriptCache()` through the new batch function.

The implementation should not add a dependency, change the wire protocol, widen IPC, merge protocol planes, alter raw event fidelity, or reopen transcript virtualization. This proposal addresses reducer complexity before DOM rendering; it is separate from CC-59's deferred outer-row virtualization decision.

The scope is deliberately limited to deliveries that already arrive as multi-frame batches. It does not optimize load-earlier or ordinary singleton live deliveries.

### Important constraint

Adding only a persistent row-ID map is insufficient. It would remove the two row scans but leave per-frame copies of `rows`, `seenFrameIds`, and `nextBlockIndexByMessageId`. The optimization has to make the complete batch the immutable publication boundary.

## Correctness and acceptance criteria

### Semantic equivalence

Batch projection must be deeply equivalent to sequential `projectServerFrame()` application. Differential coverage must include:

- assistant append and same-ID replacement;
- stream deltas followed by authoritative assistant frames;
- user frames and tool-result correlation;
- replay deduplication;
- hidden/synthetic frames;
- result-boundary settlement;
- recovered head insertion and its closing result;
- generated-image preview frames;
- unknown-session and unknown-message no-ops;
- every sample returned by `allSdkMessageSamples()` at `app/renderer/src/sdkMessageFixtures.ts:2001-2003`;
- interleaved frames for multiple sessions;
- the complete delivery as one batch, singleton batches, every split point for bounded fixtures, and adversarial partitions matching frame-limit, byte-limit, and lazy-timer flushes.

The differential assertion must compare every `TranscriptSessionState` collection at `app/renderer/src/transcriptProjector.ts:470-564`, not only visible rows: streaming state, block indexes, deduplication, tool results, generated-image previews, agent completions, slash commands, hidden-frame membership, truncation, recovery insertion, and compaction state.

### Identity preservation

Tests should prove that:

- the optimized path does not mutate a deeply frozen input state;
- callers retaining the prior state observe it deep-equal and unmodified;
- unchanged sessions keep their existing references;
- unchanged rows keep their existing references;
- a no-op batch returns the original state;
- one ordinary live frame retains current single-frame behavior.

### Performance evidence

Use 1,100, 2,200, 4,000, and 8,000 frame fixtures and record p50 and p95 projection time. Acceptance should require:

- a 2,000-to-4,000 scaling ratio consistent with near-linear rather than quadratic growth;
- semantic equality with sequential projection;
- no extra React dispatches or commits;
- a local monotonic-clock measurement around the pure renderer `projectServerFrames()` transaction, excluding fixture construction and React rendering.

The existing delivery trace is secondary liveness and end-to-end pipeline evidence, not a projector-duration clock. `DeliveryAcknowledgement` carries no occurrence timestamp at `app/shared/deliveryTrace.ts:126-137`; preload queues acknowledgements until 64 records or 50 ms at `app/preload/deliveryAckQueue.ts:119-139` and `app/preload/preload.ts:140-156`; main timestamps them only while processing the eventual batch at committed-source `app/main/main.ts:2016-2073` and `app/main/deliveryTraceSink.ts:611-636`. `renderer.state.applied` is also emitted from the post-commit effect at `app/renderer/src/App.tsx:701-708`, not at reducer completion. Do not widen the acknowledgement schema merely to turn this trace into a benchmark.

A packaged or freshly launched development app must still be measured before claiming an end-to-end user-visible latency reduction. That GUI measurement requires operator authorization for the specific run under the repository's desktop rules.

### Verification battery for an implementation

An implementation should run at minimum:

```bash
cd /Users/pt/cat-code && bun test app/renderer/src/transcriptProjector.test.ts app/renderer/src/replayBatchRender.test.tsx app/renderer/src/previewTranscriptState.test.ts
cd /Users/pt/cat-code && bun test app/
cd /Users/pt/cat-code && bun run --cwd app typecheck
cd /Users/pt/cat-code && bun run --cwd app typecheck:sidecar
cd /Users/pt/cat-code && bun run --cwd app test:hardening
cd /Users/pt/cat-code && bun run --cwd app renderer:build
```

The focused benchmark should run separately from correctness tests so normal test success does not depend on machine-specific timing thresholds.

## Secondary candidate: duplicate transcript parsing during resume

`resumeEngineSession()` at `app/sidecar/sessionResume.ts:219-237` performs two serial loads of the same session JSONL:

1. `loadConversationForResume()` resolves the session through `getLastSessionLog()`, which calls `loadSessionFile()` at `src/utils/sessionStorage.ts:4957-4975`.
2. `getSessionQueueOperations()` immediately calls `loadSessionFile(..., { keepAllLeaves: true })` again at `src/utils/sessionStorage.ts:4917-4929`.

The underlying loader already returns both `queueOperations` and the message map at `src/utils/sessionStorage.ts:4784-4807`. Source also records a historical 170 to 227 ms saving from avoiding a comparable second full-file load at `src/utils/sessionStorage.ts:4977-4981`.

This is a credible second optimization. A one-pass sidecar resume loader could return the existing resume `LogOption`, queue operations, and message UUIDs from one `keepAllLeaves` parse. It must preserve active-chain selection, compaction behavior, and queue-delivery semantics; the two current calls use different loader options, so merely deleting the second call would be incorrect.

It ranks below the projector because its current end-to-end saving was not independently reproduced in this investigation, while the projector's current scaling was. It also affects engine restore startup rather than every large replay/preview projection.

## Third candidate: synchronous delivery-trace persistence

Each delivery trace append at `app/main/deliveryTraceSink.ts:242-260`:

- serializes a JSON record;
- calls `fstatSync`;
- rotates if necessary;
- calls `writeSync`.

A normally delivered frame receives three trace writes before `webContents.send` and one immediately afterward through committed-source `app/main/main.ts:1038-1044` and `app/main/main.ts:1583-1589`. Renderer acknowledgement stages later create additional main-thread writes at committed-source `app/main/main.ts:2016-2073`.

The aggregate production evidence in `docs/reports/2026-08-10-delivery-trace-retention-measurement.md:13-20` records approximately 12 stage records and 8.1 KiB per frame, with a 9.85 MiB/min heavy-use burn rate. That proves write volume, not interaction latency.

A disposable benchmark of the exact production sink weakened this candidate as the first priority:

- One 10,000-frame run:
  - mean: 0.2316 ms per frame;
  - p50: 0.2108 ms;
  - p95: 0.2840 ms;
  - p99: 0.4887 ms;
  - p99.9: 3.2465 ms;
  - maximum: 15.1384 ms.

The benchmark is reproducible with this exact command:

```sh
cd /Users/pt/cat-code && bun -e '
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeliveryTraceSink } from "./app/main/deliveryTraceSink.ts";
const stages = ["engine.produced", "sidecar.received", "sidecar.socket.queued", "sidecar.socket.sent", "supervisor.socket.received", "host.received", "main.ipc.queued", "main.ipc.sent", "preload.received", "renderer.subscription.received", "renderer.state.queued", "renderer.state.applied"];
const frames = 10000;
const configDir = mkdtempSync(join(tmpdir(), "cat-code-trace-bench-"));
const sink = createDeliveryTraceSink({ configDir, launchId: "bench-tail", sweepIntervalMs: 0 });
const durations = [];
const totalStarted = performance.now();
for (let sequence = 1; sequence <= frames; sequence++) {
  const trace = { streamEpoch: "bench-epoch", sequence, traceId: `trace-${sequence}`, deliveryAttempt: 1, replay: false, sourceProcessInstanceId: "bench-sidecar", sourceWallTimestamp: "2026-08-23T00:00:00.000Z", sourceMonotonicTimestampMs: sequence, connectionEpoch: 1 };
  const started = performance.now();
  for (const stage of stages) sink.mark({ sessionId: "bench-session", trace, stage, frameKind: "event", messageKind: "stream_event", documentId: "bench-document", subscriptionEpoch: 1 });
  durations.push(performance.now() - started);
}
const elapsed = performance.now() - totalStarted;
sink.close();
rmSync(configDir, { recursive: true, force: true });
durations.sort((a, b) => a - b);
const at = percentile => durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * percentile))];
console.log(JSON.stringify({ frames, marksPerFrame: stages.length, totalMilliseconds: Number(elapsed.toFixed(2)), millisecondsPerFrame: Number((elapsed / frames).toFixed(4)), frameLatencyMilliseconds: { p50: Number(at(0.5).toFixed(4)), p95: Number(at(0.95).toFixed(4)), p99: Number(at(0.99).toFixed(4)), p999: Number(at(0.999).toFixed(4)), max: Number(at(1).toFixed(4)) } }, null, 2));
'
```

The tail contains occasional synchronous stalls near a 16.7 ms frame budget, but this benchmark does not identify rotation as their cause. The steady-state result is too small to outrank the transcript projector without production evidence connecting trace writes to visible stalls. Any asynchronous design would also need to preserve crash/freeze evidence, ordered records, rotation, bounded backpressure, and explicit loss accounting.

## Candidates not selected

### Markdown reparsing

Assistant markdown can be reparsed as text changes, but correct incremental GitHub-Flavored Markdown parsing must preserve syntax that crosses chunk boundaries. It is a broader semantic change than the projector transaction and lacks equivalent current measurements.

### Top-level transcript virtualization

`TranscriptView` still mounts every top-level row, so large DOM trees remain a real cost. That work is already tracked under CC-59's measured gate and changes scroll anchoring and layout behavior. The quadratic projector blocks before DOM rendering and has a narrower, independently measurable fix.

### Live-frame coalescing

Live coalescing could reduce updates, but it deliberately delays paint and complicates frame-level acknowledgement timing. Existing batching already reduced replay commits. The evidence points to work inside the batch, not to insufficient batching at the transport boundary.

## Recommendation

Implement batch-aware transcript projection first.

It has the strongest combination of:

- a source-proven repeated-work path;
- independently reproduced quadratic scaling;
- current limits that reach the expensive range;
- direct execution on the renderer thread;
- no required protocol or security-boundary change;
- a deterministic correctness oracle, because sequential projection remains available for equivalence tests.

Keep the duplicate resume load as the next candidate. Treat asynchronous delivery-trace persistence as a tail-latency experiment rather than an assumed win.

This report adds no application code and makes no end-to-end Electron latency claim. Its implementation recommendation should be accepted only after semantic-equivalence tests, scaling benchmarks, the full desktop verification battery, and an authorized live-path measurement.

```text
VERIFICATION
- git diff --cached --check -- docs/reports/2026-08-23-desktop-responsiveness-optimization.md  → clean
- bun run maps:lint  → passed: 18 maps validated, 7 existing advisory warnings
- projector benchmark command above  → reproduced quadratic scaling; 128.75 ms at 2,000, 505.60 ms at 4,000, 2,118.90 ms at 8,000
- delivery-trace benchmark command above  → 10,000 frames, 0.2108 ms p50, 0.4887 ms p99, 15.1384 ms maximum
Stale-reference sweep: clean; removed benefit and metric claims plus dirty-tree main.ts anchors have zero remaining hits.
Not run: cd /Users/pt/cat-code && bun test app/; cd /Users/pt/cat-code && bun run --cwd app typecheck; cd /Users/pt/cat-code && bun run --cwd app typecheck:sidecar; cd /Users/pt/cat-code && bun run --cwd app test:hardening; cd /Users/pt/cat-code && bun run --cwd app renderer:build. This correction changes documentation only.
```
