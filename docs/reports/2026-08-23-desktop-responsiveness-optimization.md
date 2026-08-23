# Desktop responsiveness optimization investigation

**Date:** 2026-08-23  
**Status:** Evidence-backed proposal; no application implementation changes  
**Scope:** Electron desktop app (`app/`), user-perceived responsiveness  
**Recommendation:** Replace sequential immutable transcript batch folding with a batch-aware transcript projection transaction.

## Executive summary

The highest-confidence desktop responsiveness opportunity is the transcript replay projector.

The desktop delivery path already sends replay frames in a batch and performs one React dispatch per store. The transcript store nevertheless implements that dispatch by reducing every frame through the ordinary immutable single-frame reducer. Each assistant frame scans the complete row list twice and copies multiple growing records. Replaying `R` one-row assistant frames therefore performs quadratic work before React can commit the restored transcript.

A benchmark importing the production projector reproduced the scaling:

| Replay frames | Median projection time |
|---:|---:|
| 1,100 | 35.33 ms |
| 2,000 | 128.29 ms |
| 2,200 | 144.99 ms |
| 4,000 | 524.48 ms |
| 8,000 | 2,150.18 ms |

Doubling 2,000 to 4,000 frames increased runtime 4.09 times. Doubling 4,000 to 8,000 increased it 4.10 times. The current restored-history limit is 4,000 frames, while the live replay ring permits 8,000 frames.

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
- projecting a cached transcript preview;
- loading an older transcript page into an existing session.

Because the reducer runs synchronously on the renderer thread, projection delays the restored transcript paint and competes with input and layout work. The benchmark isolates reducer CPU and does not include React rendering, markdown parsing, or DOM layout, so it should be interpreted as a lower-level blocking component rather than an end-to-end interaction measurement.

## Reproduced benchmark

### Fixture

The benchmark imported the production `createTranscriptState`, `projectServerFrame`, `withBatch`, and `batch` functions. Each delivery contained:

- one valid `ready` frame;
- `R` replayed assistant message frames;
- one short text block and one distinct UUID per assistant frame.

The frames were constructed before timing. Each size ran three times, and the median was reported. The 2,000/4,000/8,000 series included a 100-frame warm-up before measurement. Bun reported version 1.4.0 on macOS arm64.

### Results

| Frames | Run 1 | Run 2 | Run 3 | Median |
|---:|---:|---:|---:|---:|
| 1,100 | 48.06 ms | 35.33 ms | 35.03 ms | 35.33 ms |
| 2,000 | 136.57 ms | 128.29 ms | 126.88 ms | 128.29 ms |
| 2,200 | 144.49 ms | 144.99 ms | 148.81 ms | 144.99 ms |
| 4,000 | 524.48 ms | 528.41 ms | 515.98 ms | 524.48 ms |
| 8,000 | 2,202.18 ms | 2,150.18 ms | 2,062.94 ms | 2,150.18 ms |

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

### Important constraint

Adding only a persistent row-ID map is insufficient. It would remove the two row scans but leave per-frame copies of `rows`, `seenFrameIds`, and `nextBlockIndexByMessageId`. The optimization has to make the complete batch the immutable publication boundary.

## Correctness and acceptance criteria

### Semantic equivalence

Batch projection must be deeply equivalent to sequential `projectServerFrame()` application for fixtures covering:

- assistant append and same-ID replacement;
- stream deltas followed by authoritative assistant frames;
- user frames and tool-result correlation;
- replay deduplication;
- hidden/synthetic frames;
- result-boundary settlement;
- recovered head insertion and its closing result;
- generated-image preview frames;
- unknown-session and unknown-message no-ops;
- interleaved frames for multiple sessions.

### Identity preservation

Tests should prove that:

- unchanged sessions keep their existing references;
- unchanged rows keep their existing references;
- a no-op batch returns the original state;
- one ordinary live frame retains current single-frame behavior.

### Performance evidence

Use 1,100, 2,200, 4,000, and 8,000 frame fixtures and record p50 and p95 projection time. Acceptance should require:

- a 2,000-to-4,000 scaling ratio consistent with near-linear rather than quadratic growth;
- semantic equality with sequential projection;
- no extra React dispatches or commits;
- lower delivery-trace duration from `renderer.subscription.received` to `renderer.state.applied` on representative replay batches.

A packaged or freshly launched development app must still be measured before claiming an end-to-end user-visible latency reduction. That GUI measurement requires operator authorization for the specific run under the repository's desktop rules.

### Verification battery for an implementation

An implementation should run at minimum:

```bash
bun test app/renderer/src/transcriptProjector.test.ts app/renderer/src/replayBatchRender.test.tsx app/renderer/src/previewTranscriptState.test.ts
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
bun run --cwd app renderer:build
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

A normally delivered frame receives three trace writes before `webContents.send` and one immediately afterward through `app/main/main.ts:1047-1053` and `app/main/main.ts:1600-1606`. Renderer acknowledgement stages later create additional main-thread writes at `app/main/main.ts:2033-2090`.

The aggregate production evidence in `docs/reports/2026-08-10-delivery-trace-retention-measurement.md:13-20` records approximately 12 stage records and 8.1 KiB per frame, with a 9.85 MiB/min heavy-use burn rate. That proves write volume, not interaction latency.

A disposable benchmark of the exact production sink weakened this candidate as the first priority:

- Five 1,000-frame runs, 12 marks per frame: median 200.78 ms total, or 0.2008 ms per frame.
- One 10,000-frame run:
  - p50: 0.2059 ms per frame;
  - p95: 0.2440 ms;
  - p99: 0.3810 ms;
  - p99.9: 4.8595 ms;
  - maximum: 14.8880 ms.

The tail suggests rotation can consume most of a 16.7 ms frame budget, so moving persistence behind a bounded ordered writer remains worth measuring. The steady-state result is too small to outrank the transcript projector without production evidence connecting trace writes to visible stalls. Any asynchronous design would also need to preserve crash/freeze evidence, ordered records, rotation, bounded backpressure, and explicit loss accounting.

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
- git diff --check  → clean
- bun run maps:lint  → passed: 18 maps validated, 7 existing advisory warnings
Stale-reference sweep: not applicable; this report renames or removes no interface, file, command, or configuration.
Not run: desktop code battery; this is a docs-only change and no app source changed.
```
