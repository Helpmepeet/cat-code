# Live streaming batching implementation plan

Date: 2026-09-12. Status: **independently reviewed; ready for implementation when requested. Implementation has not started**.

Source checkpoint: `d7c26305a0a0b93db5667f7e5bf7ead865ed3c21`, plus the shared working tree. Recheck owners before implementation: other sessions are editing `App.tsx`, lease state and maps. This plan authorizes no application launch, provider call, installation or change to live session data.

## Outcome and scope

Reduce repeated IPC deliveries, renderer dispatches and transcript-array work while several sessions stream, with the same conversation content, ordering, permissions and recovery behavior. The first implementation changes **delivery scheduling in Electron main**. It preserves raw frames and uses the existing renderer batch path.

The proposal is to collect ordinary text/thinking deltas for a short fixed window, then deliver the original frames together. Start with **8 ms**, compare with **16 ms** and immediate delivery, and choose from measured CPU and latency. These are proposed tuning values, not a measured optimum. Timers provide a scheduling deadline, not a hard real-time guarantee under a blocked event loop.

The first pass does not combine text payloads, drop intermediate events, change model requests, pause hidden sessions, batch inbound user commands, redesign the raw-message log, or change replay batching. A raw-log optimization is a separate follow-up only if measurement shows it remains a material cost.

## Why this is a concrete opportunity

| Current owner | Verified behavior |
|---|---|
| [Attachment gate](/Users/pt/cat-code/app/main/attachmentGate.ts:74) | Ordinary attached live frames are returned as one-element arrays. Every incoming frame is recorded in the existing replay buffer first. |
| [Main delivery](/Users/pt/cat-code/app/main/main.ts:1163) | Each `deliver` call immediately sends its frame array through `CH_SERVER_FRAME`. |
| [Preload subscription](/Users/pt/cat-code/app/preload/preload.ts:405) | Already accepts `ServerFrame[]` and acknowledges each frame before passing the array to the renderer. |
| [Renderer dispatch](/Users/pt/cat-code/app/renderer/src/serverFrameBatch.ts:75) | Dispatches each store once per delivered array; most generic reducers still fold individual frames inside that dispatch. |
| [Live transcript reducer](/Users/pt/cat-code/app/renderer/src/previewTranscriptState.ts:78) | Routes a batch to `projectServerFrames`, which shares per-session drafts and publishes once per batch. |
| [Raw message log](/Users/pt/cat-code/app/renderer/src/rawMessageLog.ts:178) | Still serializes and copies retained arrays per message. IPC batching alone does not remove that work. |

The [earlier audit](../../reports/2026-09-12-multi-session-compute-audit.md) found a promising narrow projector microbenchmark. It excluded actual arrival timing, IPC and React; it is a reason to investigate, not evidence for an app-wide speedup. The newer [CPU measurements](../../reports/2026-09-12-compute-measurement-results.md) cover logging and history, not this proposal.

## Delivery contract

### 1. One bounded queue per attached renderer document

Add an Electron-free `app/main/liveFrameBatcher.ts` with injectable clock/timer/send dependencies. It holds one FIFO across sessions, preserving the order in which main previously called `deliver`; separate session queues must not reorder interleaved traffic. `AttachmentGate` remains the owner of attachment/replay decisions, and the queue operates **after** it.

Proposed limits are **32 frames and 256 KiB of UTF-8 JSON accounting size**. Compute each queued frame's size once, including its delivery-trace envelope, and include the array brackets and commas in the total. This is a queue accounting budget, not a claim about Electron structured-clone transport bytes or JavaScript heap usage; measure heap/high-water behavior separately. Ordinary live frames already receive trace metadata before the attachment gate; any future path adding metadata after accounting must reserve or account for it. Count, byte budget and oldest-frame deadline are independent flush triggers. Keep these small live-queue budgets distinct from the existing outbound single-frame limit and replay budgets in [limits.ts](/Users/pt/cat-code/app/shared/limits.ts).

When adding a frame would cross a budget, flush the existing queue first. A single otherwise-legal frame larger than the live-queue budget is sent immediately through the existing path; it is never truncated, split or rejected merely because it cannot be queued. Preexisting legal replay arrays keep their current envelope and budgets.

Arm one timeout when the queue becomes nonempty. New arrivals do not move the first frame's deadline. On every enqueue, flush an already-overdue queue before accepting more work; continuous traffic must not postpone flushing indefinitely. Clear the timer when empty. There is no periodic idle timer and no animation-frame dependency, so hidden/minimized windows do not suspend delivery.

### 2. Conservative eligibility and ordered barriers

Carry an explicit **main-only delivery origin** into the coordinator. Default to immediate delivery; only the attachment gate's ordinary live-forwarding path opts into live batching. Attachment-ready snapshots and replay/coalescer flushes stay immediate even if they contain just one original live delta without `replay: true`. Determine origin from the producing path, not array length or the gate's state after a call that may finish coalescing. This adds no public frame field or IPC schema.

Only a **single frame from that ordinary live path** with this complete shape is delayable:

- `kind === 'event'`, with neither `replay` nor `recovered` set;
- its existing `event.message` is an SDK `stream_event`;
- the stream event is a well-formed `content_block_delta`, with a nonnegative safe-integer block index;
- its delta is `text_delta` with string text, or `thinking_delta` with string thinking.

Use the real types and runtime guards, not an unchecked cast or string search. Unknown, malformed or future event shapes take the immediate path. The [projector's supported stream shapes](/Users/pt/cat-code/app/renderer/src/transcriptProjector.ts:1953) are the starting reference.

**Every other nonempty `deliver` input is an ordered barrier:** first flush all previously queued live frames, then send that original input immediately. This covers permissions/questions, message and content-block starts/stops, tool JSON deltas, assistant/result messages, errors, run-control outcomes, lifecycle events, ready/reset/replay/recovered frames, and any already-assembled multi-frame array. It deliberately preserves the existing replay coalescer's behavior. Empty arrays remain no-ops.

Example: `A.text1 → B.text1 → A.permission` must be sent as `[A.text1, B.text1]` followed immediately by `[A.permission]`. Priority means skipping the batching timer; it does not mean overtaking prior frames.

Apply the same prefix flush before [sendHostEvent](/Users/pt/cat-code/app/main/main.ts:1938). Host events can remove or replace renderer session state; a queued server frame must not arrive later and undo that transition. Recheck all direct renderer-bound sends during implementation. The health-probe channel currently has no transcript/store mutation and should stay independent. Inbound abort/permission/user commands continue through their existing immediate paths.

### 3. Navigation, removal and shutdown are explicit

Extract the minimum delivery coordinator needed for executable tests, and use that same coordinator from `main.ts`; avoid proving a helper that production never calls. Keep the low-level `sendNow` function immediate, while the public `deliver` adapter applies the policy.

| Transition | Required action |
|---|---|
| First ready/replay | Deliver the existing replay array immediately, before later live frames, including a singleton original live delta; preserve preview-to-live handover. |
| Repeated ready in the same document | Keep the one-shot replay latch. Do not replay or discard pending live frames just because the subscription epoch changed. Stamp the current subscription identity when actually sending. |
| Navigation or renderer process loss | Cancel the timer, invalidate the queue generation, discard only its pending delivery copies and re-arm the existing attachment/replay path. Do not reinsert frames into the replay buffer: they were already recorded. |
| New document identity | No old-generation callback may send into it. Bind the coordinator to the existing navigation/readiness lifecycle; explicitly test an identity change between enqueue and flush. Preserve current bounded replay semantics rather than claiming every historical frame is retained. |
| Session terminal event or removal | Flush its preceding FIFO prefix before terminal/removal publication or replay-buffer eviction; do not let a queued frame resurrect a removed session. This includes the host-event channel. |
| Window close, shutdown, signal teardown, macOS reactivation | Dispose the old queue/timer as part of existing teardown. No post-disposal sends. Fresh activation creates a fresh queue; it cannot inherit stale frames. Existing persistence and shutdown work remain authoritative. |

Use a **document-generation guard**, not subscription epoch alone: the same document's StrictMode ready/subscription cycle does not make valid queued traffic obsolete. Recheck destination availability immediately before each send. If the renderer is unavailable, cancel pending delivery copies through the document-loss path and retain the existing bounded replay/recovery behavior.

Drain by detaching the pending array and clearing timer/accounting **before** invoking the send callback. Reentrancy, a stale timer firing after cancellation, and repeated disposal must be harmless. Do not retry directly into an uncertain document or allow a timer exception to crash main.

**Send-failure recovery needs new wiring.** Current `deliver` has no catch, and the renderer-loss recovery callback lives inside window creation. Extract a window-owned transition that both the send adapter and Electron loss callback use: invalidate pending delivery, stop that document's health/replay timers, re-arm attachment, and either recover through the existing bounded reload policy or reach its existing give-up outcome. Distinguish a delivery failure from an actual process-death diagnostic. It must recover or reach a visible failure even if Electron never emits `render-process-gone`; detaching and waiting forever for an unsolicited ready signal is insufficient. A later loss callback for the same failed document must not schedule a second reload or consume the recovery budget twice. Closing/disposed windows must not be revived. Test these outcomes through the production coordinator seam.

### 4. Delivery evidence must remain truthful

Keep source sequence numbers, trace IDs, stream epochs and frame payloads intact. At actual send, use the existing [traceFrame](/Users/pt/cat-code/app/main/main.ts:455) path for the current document/subscription. The queue does not mint replay attempts or acknowledgements.

Do not stamp `main.ipc.sent`, preload receipt, applied state or committed state at enqueue. Keep queued/sent trace stages at their actual existing IPC boundaries; measure the new pre-send wait separately with bounded numeric benchmark instrumentation. Existing per-frame acknowledgement and applied/commit semantics remain unchanged. No prompt text, message content, credentials or arbitrary paths enter new diagnostics.

## Implementation sequence and ownership

1. **Capture a baseline before editing.** Save the exact source revisions and a deterministic, paced streaming fixture. Count real sends and dispatches and measure process CPU, end-to-end frame latency and backlog. Include queue classification/byte-accounting cost in the treatment measurement. Do not use pre-grouped ten-frame projector calls as the sole evidence.
2. **Build the bounded scheduler and eligibility predicate.** Use virtual-clock tests for every deadline, cap and barrier rule. Keep all existing frame and permission contracts.
3. **Wire the actual main delivery lifecycle.** One owner edits `main.ts`, the scheduler/coordinator and its integration seam together. Cover server frames, host events, readiness, navigation/crash, session eviction and every teardown path. Existing `AttachmentGate` replay behavior stays intact.
4. **Exercise the renderer path.** Drive the existing preload subscription/ack queue, `applyServerFrameBatch` and live transcript reducer with synthetic traffic. Verify full final state and every semantic barrier prefix. The first implementation should not need production `App.tsx` edits; coordinate with its current owner if source changes make that assumption false.
5. **Compare 0/8/16 ms policies, then choose or stop.** Benchmark realistic paced traffic as well as bursts. Keep the smallest policy that gives a material measured gain without violating the correctness/latency bars below. If timer/serialization overhead erases the gain, retain immediate delivery and report that result.
6. **Complete desktop checks and a separately authorized fresh GUI run.** Record actual results and limitations, update canonical batching/diagnostics documentation and the appropriate STATUS entry, and report the performance evidence. Any narrower raw-log follow-up gets a separate plan after the first result is known.

After implementation is authorized, benchmark/fixture preparation can run alongside scheduler development in separate owned files. Timed benchmarks run serially. Main wiring and lifecycle ownership stay with one implementer; an independent reviewer then examines the integrated result. This document is a plan, not a dispatch to start those changes.

## Required correctness cases

| Area | Executable proof |
|---|---|
| Deadline and no idle work | First-frame deadline; no debounce extension; sparse traffic; overdue enqueue; empty queue has no timer; stale timer callback cannot flush a later generation. |
| Ordering and barriers | Interleaved sessions; text/thinking; permissions/questions; tool JSON; message/block lifecycle; result/error; unknown shapes; host update/removal. Flattened deliveries equal accepted source frames in order at every barrier. |
| Budgets | Exact count/byte boundaries, multibyte text, one oversized-but-valid live frame, long bursts and queue high-water marks. No new outbound-frame rejection or replay-array cap. |
| Attachment and recovery | Pre-ready buffering, existing lazy restore/rewind, singleton replay/coalescer output without a replay payload flag, recovered history, repeated same-document ready, navigation/crash between enqueue and timeout, immediate reattach, preview handover, terminal eviction and close/reactivation. |
| Failure handling | Destination unavailable, send exception with and without a later Electron loss event, bounded recovery exhaustion, reentrant send callback, cancelled callback that still fires, repeated disposal. No stranded attached window, unhandled timer error, duplicate reload/send, new session resurrection or false sent/ack evidence. |
| Renderer equivalence | Compare full transcript, raw-log retention, permission/run-control/connection state and active-session selection; check every barrier prefix, not just the final text length. Intermediate ordinary delta paints are allowed to differ because grouping them is the feature. |
| Delivery tracing | Every actually sent frame retains its source identity and existing receipt/applied semantics. No old-document acknowledgement is accepted. Keep stronger `renderer.ui.committed` proof limited to today's active, rendered terminal lifecycle outcomes; background outcomes and ordinary result completion retain applied proof. Do not promise new acknowledgement coverage. |

Suggested new files are `app/main/liveFrameBatcher.test.ts` and a focused delivery-coordinator integration test. Existing coverage to reuse includes [attachmentGate.test.ts](/Users/pt/cat-code/app/main/attachmentGate.test.ts), [replayBuffer.test.ts](/Users/pt/cat-code/app/main/replayBuffer.test.ts), [replayBatchRender.test.tsx](/Users/pt/cat-code/app/renderer/src/replayBatchRender.test.tsx), [transcriptProjector.test.ts](/Users/pt/cat-code/app/renderer/src/transcriptProjector.test.ts), [rawMessageLog.test.ts](/Users/pt/cat-code/app/renderer/src/rawMessageLog.test.ts), [deliveryAcknowledgements.test.ts](/Users/pt/cat-code/app/renderer/src/deliveryAcknowledgements.test.ts), [deliveryAckQueue.test.ts](/Users/pt/cat-code/app/preload/deliveryAckQueue.test.ts) and the existing preload/trace-sink suites. Assert observable contracts, not the implementation's private array layout.

## Measurement and acceptance

Use 1, 4 and 8 synthetic streaming sessions with identical timestamps/content across policies. Include sparse arrivals, evenly staggered traffic, short bursts and barrier-heavy tool exchanges. Before recording scores, freeze a fixture manifest with arrival intervals/phases, payload sizes, barrier placement, history sizes, warm-up/duration, repetitions and aggregation rules; save its seed/content hash with the source revisions. Test empty and long legal retained histories, including state close to existing retention limits. Warm consistently, alternate policy order and retain raw samples. Compare both all sessions active and one visible while others stream; do not disable background processing to manufacture a saving.

Capture main CPU, renderer CPU, outgoing IPC count, renderer dispatch count, commit count/duration, queue count/bytes/age and frame-arrival-to-commit latency. If a headless fixture omits real Electron/React work, label that tier explicitly; a pure scheduler or projector result is not an end-to-end CPU result. Keep per-frame tracing overhead identical across policies.

**Commit latency needs benchmark-only instrumentation.** Existing acknowledgements have no renderer event timestamp, may wait in the preload's 50 ms acknowledgement queue, and are timestamped on receipt by main. Keep arrival-to-ack as a separate diagnostic; it cannot establish the 20/32 ms commit-latency bars. The fixture must correlate frame identities/main arrival times with actual renderer commit timestamps (for example, a test-only React Profiler observer that identifies the batches incorporated into that commit). Define and verify clock alignment before subtracting timestamps from different processes; record its uncertainty and exclude measurements whose uncertainty could change the acceptance decision. Do not infer visible paint from a background session's state commit. Keep this observer scoped to the benchmark, with the same collection overhead for every policy, and do not extend the production acknowledgement schema merely to obtain a measurement. If instrumenting the real app requires renderer build changes, coordinate that ownership and run the renderer checks; if actual commit timing is unavailable, report the latency gate as unverified.

Proposed decision bars, fixed before benchmarking:

- All correctness, security and recovery checks pass; no lost/reordered frames or altered permission outcomes.
- In the declared 4- and 8-session paced workloads, target at least **20% lower combined main+renderer CPU** and report the send-count reduction. This is a success target, not an estimate or promise. If missed, report the data and do not call the optimization worthwhile on a synthetic burst alone.
- In the declared load tests, **added** p95 frame-to-commit latency stays within **20 ms** and added p99 within **32 ms**, compared with immediate delivery. Report timer deadline overruns separately. These are test acceptance thresholds, not absolute runtime guarantees.
- Permissions, tool/control boundaries and completion incur **no configured batching wait**; prior queued frames are flushed synchronously before them. User abort forwarding stays immediate.
- Sparse one-session traffic has no sustained CPU regression greater than **5%** beyond observed run-to-run noise; bound queue memory and demonstrate zero idle wakeups from this scheduler.
- Fresh GUI observation shows smooth streaming, usable typing/scrolling, prompt permission presentation, correct stop/completion, and correct reload/session-switch behavior. A visually acceptable result does not waive a failed correctness or performance bar.

The CPU/latency bars can fail. The response is to keep the baseline or bring an explicit revised proposal with evidence, not silently change the workload or weaken a correctness assertion. No battery-life percentage follows from these tests.

## Verification and completion boundaries

For the implementation, use current [CLAUDE.md](/Users/pt/cat-code/CLAUDE.md) and [phase-5 standing rules](/Users/pt/cat-code/docs/migration/backlog/phase5.md):

```sh
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
```

Run focused new/existing suites first. This change affects IPC delivery, so include hardening even if channel shapes are unchanged. `test:hardening` launches Electron; schedule it with per-run authorization. Run `bun run --cwd app renderer:build` if renderer build inputs change. Add `bun run build:dev:full` and relevant focused engine tests only if implementation expands into engine code. Never use bare whole-repository `bun test` or a known-red raw typecheck as a substitute.

For GUI acceptance, follow [GUI-VERIFICATION.md](/Users/pt/cat-code/docs/migration/process/GUI-VERIFICATION.md): prepare isolated temporary config/workspace fixtures, obtain authorization for that run, launch a fresh development app, wait for renderer readiness, then check simultaneous streaming, permission presentation, stop, tab switching, reload and close/reactivation. Build/HMR alone does not refresh main. Preserve the user's running app and real credentials; synthetic streams do not need provider calls. Hover/focus-only checks remain operator-driven under that process.

Before completion, review effects on delivery traces, public wire/permission schemas, replay budgets, host-event ordering, maps and the STATUS record. No new settings, telemetry payloads, public methods, protocol version or model-provider behavior are expected. Keep the original frame arrays usable through an immediate-delivery policy for benchmark comparison and a simple code rollback. Do not revert another session's work.

For **this planning task**, verification is source-anchor/path checking, document checks and independent plan review. No implementation test, benchmark or GUI result is being claimed.

## Independent review

A fresh subagent, `/root/streaming_plan_review`, reviewed the draft against production source and then reviewed the revisions. All five findings were resolved: commit-latency instrumentation, explicit replay delivery origin, bounded send-failure recovery, exact acknowledgement-proof scope and JSON byte accounting. Its final verdict was **ready to implement once implementation is authorized**, with no material new gap found. See the [review record](../../reports/2026-09-12-live-streaming-batching-plan-review.md). Performance and latency benefits remain unproven until implementation and measurement.
