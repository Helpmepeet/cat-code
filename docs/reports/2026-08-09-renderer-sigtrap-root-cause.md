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

## Defects fixed in this session (both verified by reading before changing)

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

- **Health telemetry cannot distinguish "hidden and throttled" from "hung"** - this
  manufactured the entire freeze narrative. Cheapest fix: include
  `document.visibilityState` (and ideally `performance.memory.usedJSHeapSize`) in the
  health-response payload (schema change: the response validator pins exactly 6 keys,
  `main.ts parseRendererHealthResponse`), or main-side, correlate with BrowserWindow
  show/hide/occlusion state before logging `renderer.health.missed`. Until then, treat
  59,999/1000ms lag readings as visibility artifacts.
- **No renderer memory telemetry.** The OOM had no observable precursor in the logs. Adding
  `usedJSHeapSize` + `process.memory` sampling to health samples would have shown the
  growth curve and would settle the churn-source question on the next occurrence.
- **Transcript render path**: no virtualization, full row rebuild per frame. That makes
  Blink partition churn proportional to transcript length times frame count. Worth its own
  scoped session (virtualization or at least render memoization); do not fix blind from
  this report.
- The operational log's `queue_saturated` drop of 135 records at 21:38:02 means the log
  sink's queue is undersized for peak streaming; whatever those records were is
  unrecoverable. Minor, but it hides evidence exactly when things are busiest.

## Battery (all from repo root)

- `bun run --cwd app typecheck` - pass (fast-refresh lint + tsc clean).
- `bun run --cwd app typecheck:sidecar` - pass, "5561 upstream diagnostics ignored", zero
  owned diagnostics.
- `bun run --cwd app test:hardening` - 19/19 pass.
- `bun test app/` - see final report in session log (run was in flight at writing time;
  committed only after it passed).
