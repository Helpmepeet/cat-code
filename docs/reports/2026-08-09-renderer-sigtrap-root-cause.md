# Renderer SIGTRAP root cause: PartitionAlloc OOM during selection-bounds shaping; the "freeze" was background-tab throttling

Session: app 681b4edd / engine 88dcc00d, dev run of 2026-08-09 21:28-22:23 local (+07).
Symptom as reported: repeating multi-second renderer freezes from 21:50, SIGTRAP death of
the renderer at 22:13:46, permanently black window afterwards.

## Verdict

There were TWO separate phenomena, not one fault progressing.

1. **The 21:50:56-22:08:17 "freeze" was not a freeze.** It is Chromium's hidden-page timer
   throttling of the health probe's measurement timers while the window was hidden or fully
   occluded. The renderer was idle and healthy the whole time.
2. **The 22:13:46 SIGTRAP is a deliberate PartitionAlloc out-of-memory abort** inside Blink,
   proven by symbolication: a small text-shaping allocation failed during selection-bounds
   computation on the compositor's `WillBeginMainFrame`, in a renderer whose Blink partitions
   held 1-2GB committed and whose PartitionAlloc address space had ballooned to 32GB across
   22,959 regions.

## Proof for the crash (verified)

Electron Framework 33.4.11 (matches `app/node_modules/electron` exactly). The crash report's
`instructionByteStream.atPC` decodes to `brk #0` / `hlt #0` / `brk #1` - Chromium's
IMMEDIATE_CRASH sequence, i.e. an intentional abort, not a wild pointer.

Symbolicated the faulting thread against the official
`electron-v33.4.11-darwin-arm64-symbols.zip` breakpad symbols (framework UUID
`4c4c44bc-5555-3144-a1ff-8f155e198779` matches the .ips). Every frame resolves inside a
function, no nearest-symbol guesses:

```
 0-2  partition_alloc::internal::OnNoMemory(Internal) / RunPartitionAllocOomCallback
 3-4  WTF::PartitionsOutOfMemoryUsing1G / WTF::Partitions::HandleOutOfMemory
 5-8  PartitionRoot::OutOfMemory <- PartitionBucket::SlowPathAlloc <- allocator_shim PartitionMalloc
 9    operator new(unsigned long)
10    blink::ShapeResultView::CreateShapeResult()          <- text shaping, small allocation
11-13 FragmentItem/InlineCursor::CaretInlinePositionForOffset, ComputeLocalCaretRect
14-16 LocalCaretRectOfPosition, AbsoluteCaretBoundsOf, FirstRectForRange
17-19 SelectionEditor::UpdateCachedAbsoluteBoundsIfNeeded, FrameSelection::ComputeAbsoluteBounds
20-22 WebFrameWidgetImpl::CalculateSelectionBounds, WidgetBase::UpdateSelectionBounds
23-26 WidgetBase::WillBeginMainFrame <- cc::ProxyMain::BeginMainFrame
27-37 message pump -> content::RendererMain -> ElectronMain
```

Reading: an active **text selection existed in the transcript document**, a main frame was
produced (selection change or any layout invalidation), Blink recomputed the selection's
absolute bounds, that required shaping a text run, the resulting tiny `operator new` could
not get memory from PartitionAlloc, and Chromium aborted on purpose. `Using1G` is the
committed-size bucket: Blink partitions held between 1GB and 2GB at death.

vmSummary corroborates a memory pathology rather than a random bug: Memory Tag 253
(PartitionAlloc in Chromium's page-allocator tag scheme; 254 = Chromium, 255 = V8, whose
1.1T entry is the normal V8 sandbox address reservation) shows **32.0GB of virtual address
space in 22,959 regions**. A healthy renderer has a few hundred MB to low GB there in a few
hundred regions. PartitionAlloc decommits but retains address space, so this is a high-water
mark of allocation churn, and its fixed-size virtual pools are exhaustible: once the pool is
consumed by mostly-decommitted, fragmented super pages, a small allocation that needs a
fresh super page fails even though resident memory is modest. That is exactly how a renderer
with a healthy event loop (4.2-5.1ms lag through 22:13:17, last sample 29s before death)
dies suddenly on a tiny allocation.

What churned gigabytes through Blink partitions is **inferred, not proven**: the 21:35-21:47
turn streamed ~17,000 frames while the transcript rendered with no virtualization and
rebuilt every row per frame (`TranscriptView.tsx` documents both:
"`selectNestedTranscriptRows` rebuilds every row each frame" on "a render path with no
virtualization"). 19 minutes of full-transcript relayout and reshape over a growing
131-tool-call document is a plausible source of the churn; there is no renderer memory
telemetry to confirm the growth curve (renderer.health.sample carries only sessions +
eventLoopLagMs).

What triggered the fatal main frame at 22:13:46 is also **inferred**: the stack proves a
selection existed and its bounds cache was invalid; likely the operator was selecting or
copying the final report text. The catalog/pool pushes at 22:13:21-22 predate death by 24s
and are a weaker candidate for the invalidation.

## Proof for the "freeze" being throttling (verified signature, inferred visibility)

The lag values are quantized at Chromium's two background-throttling constants, not at
plausible GC durations:

- 21:50:56-21:52:56: five consecutive samples at **999.7-1000.8ms** - the 1-second minimum
  timer clamp for hidden pages (the probe's measurement chain in `preload.ts:92-97` is a 5s
  `setInterval` whose nesting level exceeds 5, plus a nested `setTimeout(0)`; both are
  ordinary throttleable web timers).
- 21:53:26-22:08:17: samples pinned at **59,998.8-60,000ms** - intensive wake-up throttling,
  one timer wake per minute. A `setTimeout(0)` scheduled from a once-a-minute interval tick
  runs at the NEXT minute-aligned wake, measuring ~60,000ms.
- The missed->unavailable->recovered saw-tooth (onsets 21:55:36, 21:57:36, 21:59:37,
  22:03:37, 22:07:37; ~120s cadence) fits probe responses arriving in once-per-minute
  bursts plus macOS App Nap suspending the occluded process in stretches.

Corroboration: the sidecar's 30s/60s catalog and pool worker cadence never wavered
(min gap 29.993s, max 30.037s across 112 spawns), Electron's own `unresponsive` event never
fired, engine.produced -> renderer.state.queued latency was flat ~310ms during the whole
streaming period, and lag snapped from 59,999 to 6.9ms in one step at 22:08:17 (window made
visible again) then sat at 4.5-4.7ms for five minutes. Direct proof of window visibility is
not recorded anywhere; that instrumentation gap is listed below.

Timeline restated: turn completes 21:47:38; operator reads the report; window
hidden/occluded ~21:50:30-56; classic then intensive throttling until 22:08:17 when the
operator returns; five genuinely healthy minutes; OOM abort at 22:13:46 while visible.

The 22:24:00 "Electron Helper" SIGABRT report is unrelated: a helper shim launched at
22:23:59 (parent launchd, 0.03s lifetime, abort in the 65KB shim binary before framework
main) during/after the operator's ~22:23:34 teardown. Shutdown artifact.

## Fixes landed in this session

Three commits on `migration`:

- `6ee65a56` - the two crash-handling defects below.
- `fb518346` - health telemetry: the probe response now carries `visible` and
  `heapUsedBytes` (validated fail-closed in main, 8 pinned keys);
  `renderer.health.sample`/`recovered` log both, and `missed`/`unavailable` are
  annotated with last-known visibility. This closes the hidden-vs-hung ambiguity
  that manufactured the freeze narrative, and gives the next memory incident a
  growth curve.
- `2fc7440c` - fixes for all valid findings from a two-agent review of
  `6ee65a56`, plus removal of the never-emitted `renderer.navigation.completed`
  vocabulary entry. The review caught one HIGH bug in the recovery mechanism as
  first shipped: the renderer's ready signal (mount effect) can beat
  `did-finish-load`, and the still-set `rendererGone` flag then silently
  discarded the one-shot attachment-gate replay - a recovered window with an
  empty transcript. Fixed by clearing the flag in the renderer-ready handler.
  Also fixed: a failed recovery load previously left the app permanently mute
  (did-fail-load now re-enters the capped policy as 'load-failed'); post-crash
  frames now buffer for replay (gate re-armed at render-process-gone); recovery
  goes through the real dev/packaged load path instead of webContents.reload()
  (which can no-op before a first committed entry); recovery bookkeeping split
  from the send gate so clean-exit cannot mint a bogus recovery.succeeded and
  the give-up dialog re-arms after a genuine recovery; decide() takes a closed
  RendererDeathReason union; boundary tests added.

## Defects fixed in `6ee65a56` (both verified by reading before changing)

1. **`render-process-gone` was log-only** (`app/main/main.ts:1177`): nothing recreated the
   document, so any renderer death is a permanently black window; packaged builds got no
   surface at all. Fixed: abnormal deaths now reload the window through
   `createRendererRecoveryPolicy` (`app/main/mainDecisions.ts`) - up to 3 reloads per
   10-minute sliding window, then one error dialog; `clean-exit` ignored; recovery outcomes
   logged as `renderer.recovery.started/succeeded/exhausted` (operationalLog vocabulary
   extended). The existing F2 renderer-ready replay restores state after the reload, the
   same path a manual reload uses.
2. **Sends kept targeting a dead renderer**: a crashed renderer leaves the window open and
   `webContents.isDestroyed()` false, so the health probe (every 5s) and every host event
   threw "Render frame was disposed" indefinitely, while the health monitor simultaneously
   logged the renderer as unavailable. Fixed: a `rendererGone` flag set on
   `render-process-gone` and cleared on the next `did-finish-load` now gates all three send
   sites (`deliver`, `sendHostEvent`, health probe), and the health timer stops while main
   positively knows the renderer is gone, restarting on recovery.

## Not fixed here, recommended

- **Transcript render path**: no virtualization, full row rebuild per frame. That makes
  Blink partition churn proportional to transcript length times frame count. Worth its own
  scoped session (virtualization or at least render memoization); do not fix blind from
  this report.
- The operational log's `queue_saturated` drop of 135 records at 21:38:02 means the log
  sink's queue is undersized for peak streaming; whatever those records were is
  unrecoverable. Minor, but it hides evidence exactly when things are busiest.

## Battery (all from repo root, final state after `2fc7440c`)

- Focused suites (`mainDecisions`, `attachmentGate`, `historyReplayReload`,
  `operationalLog`) - 79 pass / 0 fail.
- `bun run --cwd app typecheck` - pass (fast-refresh lint + tsc clean).
- `bun run --cwd app typecheck:sidecar` - pass, "5562 upstream diagnostics ignored", zero
  owned diagnostics.
- `bun run --cwd app test:hardening` - 19/19 pass.
- `bun test app/` - 3019 pass / 11 fail. All 11 are real-engine probe tests
  (roundtrip/resume/idle-park) that spawn live engine sessions; each dies on
  "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required" because the
  diagnosing session's shell has no credentials. Environmental, not caused by
  these changes (verified: identical failures in isolation, and the engine auth
  path is unreachable from Electron main / the log vocabulary). Re-run from an
  operator shell to confirm green.

## Outstanding operator verification (GUI, cannot be closed headless)

With the dev app running: `pgrep -f "Cat Code Dev"` to find the renderer helper
pid, `kill -9` it, and confirm the window reloads with its transcript intact
instead of staying black, with `renderer.process.gone` ->
`renderer.recovery.started` -> `renderer.recovery.succeeded` in the operational
log.
