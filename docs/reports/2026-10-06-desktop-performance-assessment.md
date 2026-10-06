# Cat Code desktop performance assessment

Date: 2026-10-06

Status: Investigation complete; implementation proposed.

Source reference checked when preparing this report: `b5bee495c0fa07462e6690b2a76bbfe7452d4755`. Desktop source files were clean in the working tree.

Cat Code has several concrete candidates for the interaction-focused approach described in [How we made Claude.ai faster](https://claude.dev/blog/how-we-made-claude-ai-faster/). The strongest newly measured candidates are delivery tracing during large reattachments, raw-message replay, and repeated Markdown processing. Broader React updates, loss of parsed content on tab switches, and eager imports are additional candidates with more limited performance evidence.

The user requested investigation without code changes. Measurements below exercise current functions with synthetic inputs; proposals have not been implemented. Node/V8 measurements use Node v24.3.0, while earlier comparisons use Bun 1.4.0. These establish local processing costs and mechanisms, rather than production Electron interaction latency, paint duration, battery savings, or a whole-app speedup. Costs from different fixtures and processes should not be added into a predicted user-visible delay.

**Optimization order**

| Order | Candidate | Evidence | Proposed direction |
|---|---|---|---|
| 1 | Tracing during large reattachments | Three synchronous tracing passes took 807 ms for 8,000 frames in one synthetic stream, versus 59 ms for the same total across four smaller streams. | Make eviction and pending-record lookup inexpensive; batch durable writes while preserving bounded diagnostic retention and loss accounting. |
| 2 | Raw-message replay | An 8,000-message fresh replay took 139 ms; duplicate replay took 95 ms; transcript projection took 4.7 ms. | Process a batch with fewer copies and maintain bounded UUID lookup for replay deduplication. |
| 3 | Markdown processing | Common prose chunks took 15–16 ms per update; a settled 64,000-character code block took 34 ms in V8. | Reuse settled parse/highlight results more broadly and move expensive processing off the renderer thread where appropriate. |
| 4 | Composer and background update scope | A headless React probe showed foreground shell work during typing and background streaming, growing with visible pane count. | Scope subscriptions and draft updates; stabilize callbacks and pane props. |
| 5 | Tab-switch reuse | Returning to loaded sessions repeatedly parsed a completed 28,822-character response. | Retain bounded parsed results across pane remounts. |
| 6 | Cache reads and startup imports | Accepted cache reads blocked synchronously for 24 ms in a warm-file fixture; static bundle analysis found substantial eager dependencies. | Offload cache reading and validation; defer page and heavy-library loading when the interaction permits. |

The top three have measured costs in restore and streaming workloads. The remaining candidates have narrower timing fixtures or work-count/source evidence. All need interaction measurements before estimating a user-visible benefit.

**Tracing during reattachment**

Electron main maps a replay through `traceFrame(..., 'attachment.replayed')` in its renderer-ready handler. [sendServerFramesNow](../../app/main/main.ts) then maps every frame through `main.ipc.queued`, sends the batch, and iterates through `main.ipc.sent`. The first two passes precede the IPC send. All three are synchronous.

[createDeliveryTraceSink](../../app/main/deliveryTraceSink.ts) retains at most 2,048 sequence entries per stream. Its `trimState` finds the minimum retained sequence with `Math.min(...state.traces.keys())`. Eviction calls `flushPendingFrames`, which scans the pending map even when flushing one sequence. Records use synchronous file-stat and write operations.

The transcript replay buffer permits 8,000 recent frames per session in [FrameReplayBuffer](../../app/main/replayBuffer.ts). A retained replay can therefore exceed the trace ring's capacity. Reintroducing older sequences during replay evicts them again, repeating scans and writes.

The controlled reattachment probe pre-recorded source, socket, host, and buffered stages, incremented delivery attempts, and ran the three passes in the same order as main. It used synthetic assistant-message tags, production trace/log limits, temporary private log directories, and an unarmed sweep timer. Trace minting and initial buffering were outside the timed passes. IPC, renderer execution, and later acknowledgements were not simulated inside the timed interval.

| Frames | Streams | Frames per stream | Replayed pass | Queued pass | Sent pass | Three passes |
|---|---|---|---:|---:|---:|---:|
| 2,048 | 1 | 2,048 | 4.3 ms | 5.2 ms | 5.3 ms | 14.9 ms |
| 4,000 | 1 | 4,000 | 71.6 ms | 89.9 ms | 88.8 ms | 250.3 ms |
| 8,000 | 1 | 8,000 | 213.4 ms | 261.1 ms | 262.4 ms | 806.8 ms |
| 8,000 | 4 | 2,000 | 17.1 ms | 18.7 ms | 23.4 ms | 59.0 ms |

Each column is a median of five measured repetitions after a discarded first repetition. Separate column medians need not sum to the total median. An earlier single-stream run measured about 678 ms for 8,000 frames; the final run with production limits and completed-message tags measured about 807 ms. The repeatable finding is the large cost beyond the per-stream retention threshold, rather than one exact machine-independent duration.

After the three passes, 5,952 of the one-stream fixture's 8,000 sequence entries were absent from the diagnostic lookup used to accept acknowledgements. All entries remained available in the four-stream control. This concerns trace evidence and acknowledgement acceptance; the probe does not establish lost transcript delivery.

Steady sequential tracing is much cheaper: another probe recording twelve stages and a completed log record per frame measured about 0.035–0.045 ms per frame. Its cumulative time should not be treated as one UI stall. Large replay pass order and retention pressure are the stronger targets.

A change should preserve the diagnostic memory and disk budgets, truthful stage timestamps, explicit loss accounting, and the distinction between received, queued, applied, and committed evidence. Simply increasing the ring capacity would exchange CPU cost for retention cost without addressing the scans.

**Raw-message replay**

[reduceServerFrameWithLimits](../../app/renderer/src/rawMessageLog.ts) checks replay UUIDs with `session.messages.some(...)`, then spreads both the message array and its parallel byte-size array for each admitted frame. [withBatch](../../app/renderer/src/serverFrameBatch.ts) folds the batch through the ordinary reducer; fewer React dispatches do not eliminate these per-frame operations.

For a fresh replay with unique UUIDs, the deduplication checks examine approximately 32 million prior-message UUIDs at 8,000 messages, in addition to repeated array copies.

The synthetic fixture alternated user and completed assistant messages. At 8,000 messages, the raw log retained 2,681,225 serialized bytes, within its 8 MiB budget.

| Messages | Fresh replay | Duplicate replay | Fresh non-replay admission | Transcript projection |
|---|---:|---:|---:|---:|
| 500 | 1.4 ms | 0.7 ms | 0.6 ms | 0.6 ms |
| 2,000 | 16.2 ms | 5.2 ms | 4.0 ms | 1.4 ms |
| 8,000 | 139.3 ms | 95.0 ms | 44.2 ms | 4.7 ms |

These Node/V8 medians use five repetitions after warm-up. The Bun probe showed the same scaling, with approximately 166 ms for the fresh 8,000-message replay and 88 ms for duplicates.

A batch-aware reduction and bounded UUID index are candidates. They must preserve live non-replay duplicates, chronological retention, byte accounting, session reset/removal, and the existing semantics for replay UUIDs whose messages were evicted.

The context gauge and live token estimate were lower priority in this fixture: approximately 0.026 ms and 0.012 ms per call at 8,000 retained messages. Raw admission of one small live delta took about 0.011 ms.

**Streaming Markdown and highlighting**

[planMarkdownLeaves](../../app/renderer/src/markdownRenderPlan.ts) has a deliberately conservative plain-paragraph append path. Its suffix rule excludes trailing whitespace and line breaks, while the retained-paragraph rule excludes internal periods and several Unicode text shapes. When the append path fails, the whole Markdown message is parsed and transformed.

The V8 fixture used a 33,600-character settled prefix containing headings, bold text, and links, followed by an active paragraph. It used the production transcript plugins, math normalization, callout recognition, and a render-plan cache. Each repetition initialized the cache before timing 24 appends; five repetitions followed a discarded warm-up repetition.

| Active text shape | Median processing per append |
|---|---:|
| Narrow accepted word append | 0.66 ms |
| Chunk ending in a space | 16.14 ms |
| Paragraph containing multiple sentences | 15.29 ms |
| Paragraph containing a soft line break | 16.38 ms |
| Thai text containing combining marks | 16.27 ms |

These are input-shape probes, not measurements of the user's provider chunk distribution. A broader reuse strategy needs a correctness fallback for reference definitions, autolinks, tables, math, callouts, fence transitions, and edits that can reinterpret earlier content. Broadening one regular expression is insufficient evidence of a safe optimization.

[highlightCode](../../app/renderer/src/markdownPlugins.ts) caches at most 32 highlighted blocks and 256,000 source characters, with a 16,000-character per-entry ceiling. Larger settled blocks run the synchronous highlighter again whenever a full Markdown transform reaches them.

The following V8 fixture appended formatted paragraphs after a completed TypeScript fence. The diagnostic control omitted rehype plugins; it is not a proposed product behavior change.

| Completed code characters | Production pipeline | Control without rehype plugins |
|---|---:|---:|
| 15,500 | 2.43 ms | 1.00 ms |
| 16,500 | 7.45 ms | 1.07 ms |
| 32,000 | 15.30 ms | 1.88 ms |
| 64,000 | 33.57 ms | 3.54 ms |

The earlier Bun 64,000-character result was about 88 ms. Runtime differences materially affect this workload, so the V8 values are the better renderer-oriented processing reference; neither runtime substitutes for an Electron measurement.

Long open fences have a separate cost. `isWholeUnterminatedFence` parses the growing tail to verify that prefix reuse remains safe. With the same settled prefix, processing took approximately 1.5, 4.0, 7.2, and 14.1 ms per append at 16,000, 64,000, 128,000, and 256,000 open-code characters. Settled-prefix reuse therefore leaves increasing active-tail work.

Potential changes include reuse of settled blocks, bounded highlight retention based on meaningful memory accounting, incremental active-tail processing, and a worker for expensive parsing/highlighting. Validation must cover content correctness, stale-result handling, selection/copy behavior, memory bounds, and uninterrupted visibility of delivered text.

**React update scope and tab switching**

A separate headless development-React probe mounted the actual [App](../../app/renderer/src/App.tsx) with an in-memory bridge and synthetic sessions. Editing one composer executed hooks in App, Sidebar, every visible SessionPane, transcript layout, and closed dialogs.

Regular measured edits invoked approximately 634 hooks with one pane, 931 with two, and 1,228 with three. Background deltas also caused foreground shell/pane hook execution. These counts establish breadth of work; they have not been correlated with native wall-clock typing latency.

Draft updates live in App. [SessionPane](../../app/renderer/src/SessionPane.tsx) supplies fresh inline callbacks to the memoized TranscriptView. Scoping draft/store subscriptions and stabilizing pane props are candidates. The existing row memoization helps: typing beside a completed transcript caused zero Markdown parses.

Six switches between loaded synthetic sessions re-parsed a completed 28,822-character response on every visit. [WorkspacePanels](../../app/renderer/src/WorkspacePanels.tsx) keys the pane subtree by session ID, while [BoundedMarkdown](../../app/renderer/src/BoundedMarkdown.tsx) owns its parsed-plan cache in a component ref. Remounting loses that cache.

A bounded cache that survives pane remounts may improve return visits. Keeping every session's DOM mounted would need separate memory and background-work evidence. Parsing caches also need invalidation for source, plugin, math, and callout configuration changes.

**Cache reads and startup**

[readCache](../../app/main/transcriptCache.ts) synchronously reads the file, parses JSON, validates the cache/header shape, and scans frames with the current secret guard.

A Node/V8 probe exercised this real reader on accepted temporary synthetic caches. Seven measured repetitions followed warm-up; filesystem reads were warm.

| Cache fixture | Serialized size | Full read, validation, and scan |
|---|---:|---:|
| 500 small assistant messages | 0.34 MB | 1.59 ms |
| 2,000 small assistant messages | 1.36 MB | 6.07 ms |
| 8,000 small assistant messages | 5.45 MB | 23.61 ms |
| Four large text messages | 4.20 MB | 2.41 ms |
| One large image preview | 16.78 MB | 19.40 ms |

The many-small-message fixture spent about 8.3 ms in JSON parsing and 14.3 ms in the secret scan. The differing fixtures show that object structure matters alongside serialized size. Cold disk behavior was not measured. Worker-based loading should preserve size limits, current schema and guard checks, eligibility/race checks, and fail-closed behavior.

The existing October 4 renderer build has one JavaScript asset of 1,657,331 bytes. A separate esbuild analysis bundled current renderer source entirely in memory, with production React settings, minification, a module contribution graph, and CSS/image assets excluded. Its JavaScript estimate was 1,703,950 bytes:

| Dependency group | Contribution in the analysis |
|---|---:|
| KaTeX | 268,746 bytes |
| highlight.js | 169,527 bytes |
| Code exclusively reachable through Usage, Accounts, Goals, and Sessions pages | 153,129 bytes |

The page figure estimates exclusive dependency reachability, rather than an implemented chunk size. This analysis is not a Vite production rebuild and provides no launch-time speedup measurement. [App](../../app/renderer/src/App.tsx) imports those pages eagerly; deferring them and heavy rendering libraries is a candidate when the first interaction does not need them.

Main already schedules catalog, account, usage, and backfill work after first paint. Existing [resource improvements](2026-10-04-resource-waste-improvements.md) also bound mounted transcript content, cache settled highlights, improve socket buffer growth, suppress several duplicate snapshots, and gate recurring refreshes while hidden/minimized. These mechanisms should remain part of the baseline.

**Validation before choosing or shipping changes**

The next useful investigation is end-to-end validation of an isolated change in Cat Code Dev, with synthetic state. The current [memory trajectory harness](../../app/scripts/rendererMemoryTrajectory.ts) records render-commit counts but marks commit-duration acceptance as unmeasured. Counts alone cannot prove better interaction latency.

| Interaction or invariant | Required evidence |
|---|---|
| Large restore and renderer reattachment | Trace, raw reduction, projection, and render/paint intervals measured separately; fixtures below and above 2,048 sequences and near the 8,000-frame limit. |
| Tracing correctness | Bounded retained objects/files; truthful delivery stages and explicit evidence loss; no diagnostic exceptions escaping into user work. |
| Raw replay correctness | Equivalent admitted messages and byte totals under duplicate replay, eviction, oversized messages, reset, removal, and mixed sessions. |
| Streaming | Chunk-to-visible-paint latency with ordinary prose, formatting, math, multilingual text, and open/settled code; retain raw frame fidelity. |
| Typing and background streams | Keystroke-to-paint and foreground work with one, two, and three visible panes plus background sessions. |
| Tab switching | Return-to-visible-content latency and bounded retained heap; scroll, focus, disclosure, and selection behavior remain correct. |
| Startup and cache loading | First composer paint and first usable interaction, cache reads on the critical path, deferred feature first-use cost, and memory. |

Implementation should proceed one mechanism at a time, using the same fixtures before and after each change. Correlate deterministic work counts with measured interaction time, and retain both memory and correctness checks.

A global fixed streaming delay is not selected by this investigation. The existing [September 12 Electron batching matrix](2026-09-12-live-streaming-batching-results.md) rejected 8 ms and 16 ms policies against its reviewed CPU threshold; main currently uses `delayMs: 0`. Better handling of repeated work should be evaluated independently of changes to delivery timing.

**Measurement record and limits**

The timing probes called current production functions without modifying their implementations. Node probes used esbuild with `write: false` to compile virtual TypeScript entry points, then supplied the resulting JavaScript to Node through stdin. Source parsing/compilation and process startup were outside the timed function intervals. Headless React probes used happy-dom, development React, and a memory-only bridge; happy-dom provides no native browser layout/paint timing.

Cache and trace probes used only private temporary directories under `/private/tmp` and removed them on completion. No provider turn, real credential operation, live app launch, source edit, or dependency change was part of the investigation.

The measured values were captured from inline probes in this conversation. No standalone executable benchmark suite or raw profile artifact was saved. Reproduction requires reconstructing the described fixtures; recording runnable probes and Electron traces belongs with the follow-up implementation/validation work. The evidence supports the mechanisms and optimization order, while production latency percentiles and expected whole-app improvement remain open.
