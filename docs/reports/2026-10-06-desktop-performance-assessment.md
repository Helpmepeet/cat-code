# Cat Code desktop performance assessment

Date: 2026-10-06

Status: Investigation complete; measurement priorities provisional; no implementation.

Source reference checked when preparing this report: `b5bee495c0fa07462e6690b2a76bbfe7452d4755`. Desktop source files were clean in the working tree.

Review amendment, 2026-10-06: source paths were rechecked at `41ec7f5de6b9ab654f90c93a3ed19aff638fd304`. The initial ordering over-weighted 8,000-frame stress fixtures, omitted acknowledgement and persistence-time work, and required comparable fixtures without saving a harness. This revision separates recurring interactions from document reattachment, adds historical sizing evidence, and makes a reproducible baseline a prerequisite for implementation comparisons. No timings were rerun during the amendment.

Cat Code has several concrete candidates for the interaction-focused approach described in [How we made Claude.ai faster](https://claude.dev/blog/how-we-made-claude-ai-faster/). Repeated Markdown processing is the first candidate to measure in long streaming replies; composer/background update scope is another recurring path. Ordinary history restore, lifecycle cache reads, tab switching, renderer reattachment, and eager imports have different triggers and should be assessed separately.

The user requested investigation without code changes. Measurements below exercise current functions with synthetic inputs; proposals have not been implemented. Node/V8 measurements use Node v24.3.0, while earlier comparisons use Bun 1.4.0. These establish local processing costs and mechanisms, rather than production Electron interaction latency, paint duration, battery savings, or a whole-app speedup. Costs from different fixtures and processes should not be added into a predicted user-visible delay.

**Provisional measurement priority**

| Priority | Candidate and trigger | Evidence | Proposed direction |
|---|---|---|---|
| 1 | Markdown processing during streamed updates | With a 33,600-character settled prefix, multi-sentence prose took 15–16 ms per update; a settled 64,000-character code block took 34 ms in V8. | Reuse settled parse/highlight results more broadly and evaluate moving expensive processing off the renderer thread. |
| 2 | Composer and background update scope during typing and incoming deltas | A headless development-React probe showed foreground shell work growing with visible pane count; native latency is unmeasured. | Scope subscriptions and draft updates; stabilize callbacks and pane props. |
| 3 | Raw-message replay during ordinary history restore, including parked-session wake | Fresh synthetic replay took 1.4 ms at 500 messages and 16.2 ms at 2,000. The 139 ms at 8,000 is a stress result beyond the single-attach history cap. | Process a batch with fewer copies and maintain bounded UUID lookup for replay deduplication. |
| 4 | Cache reads during preview and eligible session park/close/restart/quit persistence | Warm accepted-cache reads took 1.6 ms for 500 small messages and 23.6 ms for the 8,000-message stress fixture. | Remove avoidable full-cache reads from persistence and evaluate offloading remaining reads/validation while preserving lifecycle ordering. |
| 5 | Parsed-content reuse on tab return | Returning to loaded sessions repeatedly parsed a completed 28,822-character response; native switch latency is unmeasured. | Retain bounded parsed results across pane remounts. |
| 6 | Tracing when an existing buffer is replayed to a new renderer document | Three passes took 14.9 ms for 2,048 dense sequences and 806.8 ms for an 8,000-sequence stress case; compacted real sequence patterns and acknowledgements were not measured. | Make eviction and pending-record lookup inexpensive; batch writes while preserving bounded diagnostics and loss accounting. |
| 7 | Eager imports at startup and first feature use | Static analysis found substantial eager dependencies; launch latency is unmeasured. | Defer pages and heavy rendering libraries when the first interaction permits. |

This order weights recurrence implied by the code paths as well as processing severity. Actual interaction frequencies and native latency have not been measured, so it is an order for collecting evidence, not a demonstrated ranking of user-visible gains. Recovery tracing remains a separate responsiveness and diagnostic-correctness concern.

**Historical session scale and distinct replay paths**

The [August 19 retention measurement](2026-08-19-transcript-retention-cap-measurement.md) recorded 1,849 engine transcripts: p50 82, p90 332, p99 1,075, and maximum 2,988 records per session. Its original desktop-ring verdict was subsequently voided after streaming-partial compaction. The current sizing comment in [FrameReplayBuffer](../../app/main/replayBuffer.ts) describes the 8,000-frame cap as a backstop after compaction and cites the 2,988-record corpus maximum. These are historical measurements and source commentary, not a newly sampled workload or a guarantee that future sessions cannot reach the cap.

Ordinary sidecar history attachment is separately limited to 4,000 frames and 4 MiB in [shared limits](../../app/shared/limits.ts) and [sendHistoryReplay](../../app/sidecar/sidecarServer.ts). Real message size can make the byte cap bind sooner. The renderer's 8,000-message raw-log retention cap is a different budget: a growing live log is not one initial history burst. The 8,000-message replay and cache fixtures therefore characterize stress behavior rather than typical restore size.

An ordinary restore while the renderer remains attached sends sidecar history through the live/coalesced delivery path with newly minted, increasing trace sequences. Existing-buffer reattachment uses `attachment.replayed` when a new renderer document announces readiness, including reload/recovery and initial readiness if frames were already buffered. These paths should not share an assumed frequency or tracing cost. Neither restore/reload rates nor provider chunk distributions were sampled in this investigation.

**Tracing during reattachment**

Electron main maps a replay through `traceFrame(..., 'attachment.replayed')` in its renderer-ready handler. [sendServerFramesNow](../../app/main/main.ts) then maps every frame through `main.ipc.queued`, sends the batch, and iterates through `main.ipc.sent`. The first two passes precede the IPC send. All three are synchronous.

[createDeliveryTraceSink](../../app/main/deliveryTraceSink.ts) retains at most 2,048 sequence entries per stream. Its `trimState` finds the minimum retained sequence with `Math.min(...state.traces.keys())`. Eviction calls `flushPendingFrames`, which scans the pending map even when flushing one sequence. Records use synchronous file-stat and write operations.

The transcript replay buffer permits 8,000 recent ring frames per session in [FrameReplayBuffer](../../app/main/replayBuffer.ts), subject to its byte budget, while head/sticky frames occupy separate slots. This is a backstop-sized fixture, not the observed historical maximum. Reintroducing older sequences during replay can immediately evict them again, repeating scans and writes.

The two rings retain different frame populations. Transcript compaction removes finished streams' partials; the trace ring sees those sequences too and has no matching transcript-compaction step. A compacted replay below 2,048 frames can therefore still contain sequence IDs already evicted from tracing. The dense-sequence fixture below does not establish a production replay-count threshold: sequence age/gaps, current trace contents, message kinds, and delivery attempts also matter.

The controlled reattachment probe pre-recorded source, socket, host, and buffered stages, incremented delivery attempts, and ran the three passes in the same order as main. It used synthetic assistant-message tags, production trace/log limits, temporary private log directories, and an unarmed sweep timer. Trace minting and initial buffering were outside the timed passes. IPC, renderer execution, and later acknowledgements were not simulated inside the timed interval.

| Frames | Streams | Frames per stream | Replayed pass | Queued pass | Sent pass | Three passes |
|---|---|---|---:|---:|---:|---:|
| 2,048 | 1 | 2,048 | 4.3 ms | 5.2 ms | 5.3 ms | 14.9 ms |
| 4,000 | 1 | 4,000 | 71.6 ms | 89.9 ms | 88.8 ms | 250.3 ms |
| 8,000 | 1 | 8,000 | 213.4 ms | 261.1 ms | 262.4 ms | 806.8 ms |
| 8,000 | 4 | 2,000 | 17.1 ms | 18.7 ms | 23.4 ms | 59.0 ms |

Each column is a median of five measured repetitions after a discarded first repetition. Separate column medians need not sum to the total median. An earlier single-stream run measured about 678 ms for 8,000 frames; the final run with production limits and completed-message tags measured about 807 ms. These are dense-sequence stress results, not measured current-session reload latency.

A rough linear interpolation between the 2,048- and 4,000-frame rows puts 2,988 dense sequences at approximately 128 ms; the review's rounded 0.13 ms per extra sequence gives approximately 137 ms, or about 140 ms. Neither is a measured value or a realistic worst-case bound. Both assume the same dense sequence pattern and omit acknowledgement handling. A new fixture must model compacted partials and retained old sequence IDs before estimating current-session cost.

After the three passes, 5,952 of the one-stream fixture's 8,000 sequence entries were absent from the diagnostic lookup used to accept acknowledgements. All entries remained available in the four-stream control. This concerns trace evidence and acknowledgement acceptance; the probe does not establish lost transcript delivery.

The measurement omitted subsequent acknowledgement work. For each valid acknowledgement of an absent sequence, main calls `recordAcknowledgementRejected`, which appends a synchronous trace record, and calls the operational warning logger. The [operational sink](../../app/main/operationalLogSink.ts) deduplicates repeated event/session/reason keys for one second, so logger calls are not equivalent to one disk warning per rejection. Other acknowledgement failures and renderer-side work were not timed either.

For an old sequence immediately evicted in each of the three passes, each reopened pending record can be flushed as `evicted`, adding up to three records before rejected acknowledgements. The trace lane rotates at 20 MiB per file and retains at most 100 MiB in total. Additional replay/rejection records increase retention pressure and may displace older detail when limits are reached. The complete acknowledgement count, added time/bytes, and actual displacement were not measured; the three-pass timing is only a component of total recovery work.

Steady sequential tracing is much cheaper: another probe recording twelve stages and a completed log record per frame measured about 0.035–0.045 ms per frame. Its cumulative time should not be treated as one UI stall. Large replay pass order and retention pressure are the stronger targets.

A change should preserve the diagnostic memory and disk budgets, truthful stage timestamps, explicit loss accounting, and the distinction between received, queued, applied, and committed evidence. Simply increasing the ring capacity would exchange CPU cost for retention cost without addressing the scans.

**Raw-message replay**

[reduceServerFrameWithLimits](../../app/renderer/src/rawMessageLog.ts) checks replay UUIDs with `session.messages.some(...)`, then spreads both the message array and its parallel byte-size array for each admitted frame. [withBatch](../../app/renderer/src/serverFrameBatch.ts) folds the batch through the ordinary reducer; fewer React dispatches do not eliminate these per-frame operations.

For a fresh replay with unique UUIDs, the deduplication checks examine approximately 32 million prior-message UUIDs at the synthetic 8,000-message stress size, in addition to repeated array copies. A single ordinary sidecar attachment cannot emit that many history frames under its 4,000-frame cap. At 2,000 unique messages, the same scan pattern examines approximately two million prior-message UUIDs.

The synthetic fixture alternated user and completed assistant messages. At 8,000 messages, the raw log retained 2,681,225 serialized bytes, within its 8 MiB budget. Its unusually small messages allow the large count to fit; it is not a sampled session-size distribution.

| Messages | Fresh replay | Duplicate replay | Fresh non-replay admission | Transcript projection |
|---|---:|---:|---:|---:|
| 500 | 1.4 ms | 0.7 ms | 0.6 ms | 0.6 ms |
| 2,000 | 16.2 ms | 5.2 ms | 4.0 ms | 1.4 ms |
| 8,000 | 139.3 ms | 95.0 ms | 44.2 ms | 4.7 ms |

These Node/V8 medians use five repetitions after warm-up. The Bun probe showed the same scaling, with approximately 166 ms for the fresh 8,000-message replay and 88 ms for duplicates.

A batch-aware reduction and bounded UUID index are candidates. They must preserve live non-replay duplicates, chronological retention, byte accounting, session reset/removal, and the existing semantics for replay UUIDs whose messages were evicted.

The context gauge and live token estimate were lower priority in this fixture: approximately 0.026 ms and 0.012 ms per call at 8,000 retained messages. Raw admission of one small live delta took about 0.011 ms.

**Streaming Markdown and highlighting**

[planMarkdownLeaves](../../app/renderer/src/markdownRenderPlan.ts) has a deliberately conservative plain-paragraph append path. [BoundedMarkdown](../../app/renderer/src/BoundedMarkdown.tsx) explicitly enables it for the production transcript plugins. Its suffix rule excludes trailing whitespace and line breaks, while the retained-paragraph rule excludes internal periods and several Unicode text shapes. When the append path fails, the whole Markdown message is parsed and transformed.

The period restriction depends on accumulated paragraph content, not just the next chunk. `isPlainParagraphText` permits one period only at the paragraph's exact end; once more text follows that sentence-ending period, it becomes internal and later appends cannot use this shortcut while the same paragraph remains active. Multi-sentence prose therefore has a sustained full-parse path even if later chunks individually match the suffix rule. This makes long ordinary prose a stronger validation target than an isolated awkward chunk, while the proportion of real traffic taking this path remains unmeasured.

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

Regular measured edits invoked approximately 634 hooks with one pane, 931 with two, and 1,228 with three. Background deltas also caused foreground shell/pane hook execution. The probe did not wrap App in StrictMode, so these are not reported as StrictMode-doubled counts. They still come from development React and establish only breadth of work; they have not been correlated with production-build hook work or native wall-clock typing latency. The executable probe was not retained for independent verification.

Draft updates live in App. [SessionPane](../../app/renderer/src/SessionPane.tsx) supplies fresh inline callbacks to the memoized TranscriptView. Scoping draft/store subscriptions and stabilizing pane props are candidates. The existing row memoization helps: typing beside a completed transcript caused zero Markdown parses.

Six switches between loaded synthetic sessions re-parsed a completed 28,822-character response on every visit. [WorkspacePanels](../../app/renderer/src/WorkspacePanels.tsx) keys the pane subtree by session ID, while [BoundedMarkdown](../../app/renderer/src/BoundedMarkdown.tsx) owns its parsed-plan cache in a component ref. Remounting loses that cache.

A bounded cache that survives pane remounts may improve return visits. Keeping every session's DOM mounted would need separate memory and background-work evidence. Parsing caches also need invalidation for source, plugin, math, and callout configuration changes.

**Cache reads during preview and persistence**

[readCache](../../app/main/transcriptCache.ts) synchronously reads the file, parses JSON, validates the cache/header shape, and scans frames with the current secret guard.

In [persistTranscriptCache](../../app/main/main.ts), main also calls this full reader to carry existing image previews into the replacement cache. This happens after a non-empty buffered session produces an eligible cache, even if no preview ultimately needs carrying forward. It is part of persistence before eviction on session park/close/restart, terminal lifecycle handling, and applicable relocation paths. [shutdownAll](../../app/host/host.ts) synchronously invokes eviction/persistence for each live row it marks clean at quit. Empty/ineligible sessions and missing cache files do not incur the full accepted-cache cost.

A Node/V8 probe exercised this real reader on accepted temporary synthetic caches. Seven measured repetitions followed warm-up; filesystem reads were warm.

| Cache fixture | Serialized size | Full read, validation, and scan |
|---|---:|---:|
| 500 small assistant messages | 0.34 MB | 1.59 ms |
| 2,000 small assistant messages | 1.36 MB | 6.07 ms |
| 8,000 small assistant messages | 5.45 MB | 23.61 ms |
| Four large text messages | 4.20 MB | 2.41 ms |
| One large image preview | 16.78 MB | 19.40 ms |

The many-small-message fixture spent about 8.3 ms in JSON parsing and 14.3 ms in the secret scan. The differing fixtures show that object structure matters alongside serialized size. The 8,000-message result is a stress fixture, not a measured ordinary park/close cost. Cold disk behavior, total persist/write time, and multi-session quit time were not measured. Changes should avoid unnecessary full-cache reads while preserving preview retention, size limits, current schema/guard checks, eligibility/race checks, fail-closed behavior, and snapshot → persist → evict ordering. Offloading alone requires a lifecycle design that still completes durable persistence before exit.

**Startup imports**

The existing October 4 renderer build has one JavaScript asset of 1,657,331 bytes. A separate esbuild analysis bundled current renderer source entirely in memory, with production React settings, minification, a module contribution graph, and CSS/image assets excluded. Its JavaScript estimate was 1,703,950 bytes:

| Dependency group | Contribution in the analysis |
|---|---:|
| KaTeX | 268,746 bytes |
| highlight.js | 169,527 bytes |
| Code exclusively reachable through Usage, Accounts, Goals, and Sessions pages | 153,129 bytes |

The page figure estimates exclusive dependency reachability, rather than an implemented chunk size. This analysis is not a Vite production rebuild and provides no launch-time speedup measurement. [App](../../app/renderer/src/App.tsx) imports those pages eagerly; deferring them and heavy rendering libraries is a candidate when the first interaction does not need them.

Main already schedules catalog, account, usage, and backfill work after first paint. Existing [resource improvements](2026-10-04-resource-waste-improvements.md) also bound mounted transcript content, cache settled highlights, improve socket buffer growth, suppress several duplicate snapshots, and gate recurring refreshes while hidden/minimized. These mechanisms should remain part of the baseline.

**Validation before choosing or shipping changes**

Before implementing a fix, save a runnable harness, exact synthetic fixtures, runtime versions, source revision, timing boundaries, and raw results, then record a fresh baseline. The old inline probes were not saved and cannot serve as the matching control for a reconstructed harness. Run both original and changed implementations through the same saved harness; the published numbers above remain exploratory references.

End-to-end validation should then measure the isolated change in Cat Code Dev with synthetic state. The current [memory trajectory harness](../../app/scripts/rendererMemoryTrajectory.ts) records render-commit counts but marks commit-duration acceptance as unmeasured. Counts alone cannot prove better interaction latency.

| Interaction or invariant | Required evidence |
|---|---|
| Ordinary history restore | Measure fresh attachment and parked-session wake independently of renderer reload; include historical small/medium/large scales and the current 4,000-frame/4 MiB history limits. |
| Existing-buffer renderer reattachment | Measure tracing, IPC, raw reduction, projection, acknowledgement handling, and paint separately; include dense sequences, compacted/gapped sequences with old IDs, historical-scale fixtures near 2,988 records, and a separately labeled 8,000-frame stress case. |
| Tracing correctness and retention | Bounded retained objects/files; truthful delivery stages, explicit evidence loss, acknowledgement rejection counts, and bytes/rotation/displacement; no diagnostic exceptions escaping into user work. |
| Raw replay correctness | Equivalent admitted messages and byte totals under duplicate replay, eviction, oversized messages, reset, removal, and mixed sessions. |
| Streaming | Chunk-to-visible-paint latency across an entire multi-sentence paragraph, formatting, math, multilingual text, and open/settled code; count shortcut/fallback frequency for known input chunks and retain raw frame fidelity. |
| Typing and background streams | Keystroke-to-paint and foreground work with one, two, and three visible panes plus background sessions. |
| Tab switching | Return-to-visible-content latency and bounded retained heap; scroll, focus, disclosure, and selection behavior remain correct. |
| Cache lifecycle | Preview/read latency plus park, close, restart, terminal exit, and multi-session quit; include preview carry-forward, full read/validation/scan, durable write completion, and empty/ineligible controls. |
| Startup imports | First composer paint and first usable interaction, deferred feature first-use cost, and memory. |

After the reproducible baseline exists, implementation should proceed one mechanism at a time using those saved fixtures before and after each change. Correlate deterministic work counts with measured interaction time, record interaction/slow-path frequency rather than assuming it, and retain both memory and correctness checks.

A global fixed streaming delay is not selected by this investigation. The existing [September 12 Electron batching matrix](2026-09-12-live-streaming-batching-results.md) rejected 8 ms and 16 ms policies against its reviewed CPU threshold; main currently uses `delayMs: 0`. Better handling of repeated work should be evaluated independently of changes to delivery timing.

**Measurement record and limits**

The timing probes called current production functions without modifying their implementations. Node probes used esbuild with `write: false` to compile virtual TypeScript entry points, then supplied the resulting JavaScript to Node through stdin. Source parsing/compilation and process startup were outside the timed function intervals. Headless React probes used happy-dom, development React, and a memory-only bridge; happy-dom provides no native browser layout/paint timing.

Cache and trace probes used only private temporary directories under `/private/tmp` and removed them on completion. No provider turn, real credential operation, live app launch, source edit, or dependency change was part of the investigation.

The measured values were captured from inline probes in this conversation. No standalone executable benchmark suite or raw profile artifact was saved. Reconstructing the descriptions is insufficient for a directly comparable before/after claim: a new saved harness must establish its own baseline before implementation. Historical corpus figures were read from repository documentation, not remeasured from the user's live stores. The evidence supports the mechanisms and local synthetic costs; current workload sizes/frequencies, production latency percentiles, and expected whole-app improvement remain open.
