# Desktop logging: four evidence-density fixes proposed from the first real incident

Companion to `docs/reports/2026-08-09-renderer-sigtrap-root-cause.md`. That
investigation was the first time the desktop diagnostics stack was used against
a real failure (a renderer PartitionAlloc OOM plus a phantom 17-minute
"outage" that was hidden-window timer throttling). The stack's design held up:
the closed vocabulary, bounded local files, and transitions-only philosophy
made the logs safe to read and trivial to parse, and negative evidence (the
`unresponsive` handler never firing) carried real diagnostic weight.

Every gap that hurt was the same species: **evidence density is uniform, but
incidents need it front-loaded around anomalies.** Steady-state thrift (sample
dedup, rotation, bare drop counts) is correct until the thirty seconds that
matter, where it becomes the obstacle. The four tasks below were filed as
spin-off chips on 2026-08-10; this report is their shared rationale and
acceptance sketch. None changes the logging system's shape - all four are
additive and closed-vocabulary-compatible.

Every claim below was re-verified against source on 2026-08-10; the
`file:line` citations are current. That pass also found scope the first
draft understated, recorded inline as **Verified** notes. The headline
correction: task 3 is not small, and the record contract forecloses the
obvious encoding for task 1.

## Task 1 - health-sample flight recorder around error events

**What happened.** Renderer health is measured every 5s but a dedup logs at
most one sample per 30s (`shouldSample`,
`app/main/mainDecisions.ts:113-122`, consumed by the
`CH_DELIVERY_HEALTH_RESPONSE` handler in `app/main/main.ts`). The renderer
died at 22:13:46; the last logged sample was 29.8s earlier. Up to six
readings closest to the crash - exactly the ones that could have shown a
terminal lag spike or heap jump - were measured and then silently discarded.

**Proposed change.** Main keeps the last ~12 raw responses (lag, `visible`,
`heapUsedBytes`, monotonic timestamp) in a bounded ring buffer, and flushes
the ring verbatim as one operational record when `renderer.process.gone` or
`renderer.health.unavailable` fires. The dedup stays; the ring only pays
bytes in anomaly neighborhoods.

**Verified.** The probe interval is `setInterval(healthProbe, 5_000)`
(`app/main/main.ts:1115`) and the dedup is
`RENDERER_HEALTH_SAMPLE_INTERVAL_MS = 30_000`
(`app/main/mainDecisions.ts:50`), so the six-reading figure is exact. The
handler at `app/main/main.ts:1769-1787` parses `eventLoopLagMs`, `visible`,
and `heapUsedBytes` and then discards them when `shouldSample` is false, so
the readings really are measured before being dropped.

**Encoding constraint - decide before implementing.** The binding limit is
not `MAX_OPERATIONAL_FIELDS`. `sanitizeOperationalFields`
(`app/shared/operationalLog.ts:178-198`) accepts only string, finite number,
boolean, or null: arrays and objects throw. Twelve readings of four values
can therefore be neither flat fields (16 max) nor an array. Two workable
shapes, implementer picks one and states it in their report:

- One record whose ring is a compact capped string under
  `MAX_OPERATIONAL_STRING_BYTES` (512). About 21 chars per reading, so
  twelve fit in roughly 260 bytes. Needs one new event and one new field key.
- Twelve ordinary `renderer.health.sample` records with backdated
  timestamps. `createOperationalRecord` already accepts `now` and
  `monotonicNow` overrides, so this adds no vocabulary at all - but check
  that the main-process `logOperational` wrapper passes them through.

**Acceptance.** A simulated crash after a burst of 5s samples surfaces
readings the 30s dedup would have dropped; the chosen encoding stays inside
`MAX_OPERATIONAL_FIELDS` and `MAX_OPERATIONAL_STRING_BYTES`; any vocabulary
change is additive.

## Task 2 - attribute what queue_saturated drops

**LANDED 2026-08-10** (`909404c8`, STATUS CC-41). Per-type histogram in the
existing `category` field, top 6 buckets by count, whole buckets dropped
rather than truncated. Delivery-trace drops bucket as `delivery.trace`, taken
from the record's own `recordKind` so it cannot drift. `count` remains the
authoritative total, which the bucket cap deliberately does not try to match.

**What happened.** At 21:38:02, mid-streaming, 135 operational records were
shed with only `log.suppressed { count: 135, reason: "queue_saturated" }` to
show for it. What those records were is unknowable after the fact.

**Where it lives (corrected).** The shedding is the SIDECAR's operational
logger, not the main-process sink: `app/sidecar/operationalLogger.ts` drops a
record when the stream backlog exceeds `MAX_PENDING_BYTES` (`enqueue`,
~line 85) and reports the count on drain (`reportDrops`, ~line 95-105). The
first chip filed for this pointed at `app/main/operationalLogSink.ts` and was
replaced.

**Verified, and the correction is provable.** `enqueue`
(`app/sidecar/operationalLogger.ts:84-88`) drops once `writableLength`
exceeds `MAX_PENDING_BYTES` (256KB), and `reportDrops` (:93-105) emits
exactly `{ count, reason: 'queue_saturated' }`. The main sink sheds too, but
stamps `reason: 'rate_dedupe'` (`app/main/operationalLogSink.ts:129`).
`queue_saturated` is uniquely the sidecar's word, so the observed record
could only have come from there. No inference required.

**Proposed change.** Accumulate a per-event-type count next to
`droppedRecords` and surface it in the `log.suppressed` record. The
vocabulary is closed and fields are flat, so the least-invasive encoding is a
compact capped string (for example `"renderer.health.sample:130,diagnostic:5"`)
or a small fixed set of count fields - implementer's choice, stated in their
report.

**Two details the histogram must not miss.** `deliveryStage`
(`app/sidecar/operationalLogger.ts:159-161`) increments the same
`droppedRecords` counter, but a delivery-trace record carries a `stage`, not
an `event`. Bucketing strictly by event type would silently under-account
exactly the records task 3 is about, so give them a defined bucket. And
`log.suppressed` currently allows only `['count','reason']`
(`app/shared/operationalLog.ts:113`); `category` is already in the key
universe, which makes it the cheapest slot for the histogram string.

**Acceptance.** A saturation test shows the histogram matching the dropped
records by type, including dropped delivery-trace markers; the record stays
within `MAX_OPERATIONAL_STRING_BYTES` / `MAX_OPERATIONAL_FIELDS`.

## Task 3 - do not mistake a dropped source marker for a dropped frame

**LANDED 2026-08-10** (`efa80f9d`, STATUS CC-42). Continuity moved to a new
`socketReceived` watermark fed by `supervisor.socket.received`; missing sidecar
markers now emit the additive `trace.source.incomplete` kind. The unbounded
emission was solved by remembering the hole each detector already reported
rather than by a rate cap, so one hole costs one record and a second, distinct
hole is still reported. `firstMissing` trusts a source watermark only in the
one direction FD 3 loss cannot fake: a source stage that still OUTRUNS arrival
really does mean the frame never landed.

**What happened.** On 2026-08-09, the sidecar restored 376 transcript messages
and then reported `log.suppressed { count: 1923, reason: "queue_saturated" }`.
Delivery-stage markers share that intentionally lossy FD 3 queue. Electron main
later received a source marker at sequence 2581 while its contiguous
`engine.produced` watermark still expected 135, and emitted thousands of
`trace.sequence.gap` records. The underlying Unix-socket frames were not shown
to be missing.

**Where it lives.** `app/sidecar/operationalLogger.ts` deliberately sheds
diagnostic records when its nonblocking FD 3 queue is full. In
`app/main/deliveryTraceSink.ts`, `mark()` infers a source gap from missing
`engine.produced` markers, and `updateWatermarks()` cannot advance beyond the
first absent marker. The diagnostic path is therefore being treated as
authoritative evidence about the separate frame-transport path.

**Verified, exactly as described.** `app/main/deliveryTraceSink.ts:297-301`
raises `trace.sequence.gap` solely off `engine.produced`; `updateWatermarks`
(:403) derives `produced` contiguously and sets `nextExpected = produced + 1`,
so one absent marker pins it indefinitely. And `engine.produced` is FD 3 only:
`SidecarDeliveryStageRecord['stage']` is restricted to the four sidecar
stages (`app/shared/deliveryTrace.ts:105`), all of which ride the lossy queue.

**The fix is already half-built.** `DeliveryTrace` is envelope metadata
carried with the frame over the socket, and `app/main/main.ts:329` already
detects a frame arriving at `supervisor.socket.received` with no envelope and
logs `missing_source_envelope`. The comment directly above it - do not infer
or backfill sidecar stages after a socket receipt - shows the separation was
understood and simply never carried into gap detection.

**Scope correction: this is the largest of the four, not a small one.**
Two things the first draft missed. `supervisor.socket.received` has no
watermark at all today (`updateWatermarks` tracks produced, socketSent,
hostReceived, ipcSent, preloadReceived, applied, committed), so this adds a
watermark rather than swapping an input. And `appendAnomaly` (:259-278) has
no rate cap, so once the watermark is pinned every subsequent frame writes a
full anomaly record without bound. That is the mechanism behind "thousands",
and it needs fixing alongside the attribution itself.

**Proposed change.** Separate frame continuity from source-stage coverage.
Detect continuity from the delivery envelope observed at
`supervisor.socket.received`, which is the actual Unix-socket frame path.
Treat missing FD 3 source markers as incomplete diagnostic coverage, not as a
missing conversation frame. Preserve source-stage markers when present so the
trace can still identify a true first missing downstream stage. Connect
`queue_saturated` suppression to the affected session's delivery-trace summary
without inventing an exact missing sequence range.

**Acceptance.** A test that drops a run of FD 3 delivery markers but delivers
every Unix-socket frame emits a diagnostic-coverage warning and no
`trace.sequence.gap`. A test that omits a delivery envelope between two
received sequence numbers still emits a frame-continuity gap. A downstream
stage failure remains attributable when its source marker was retained. A
sustained pinned watermark does not emit unbounded anomaly records.

## Task 4 - renderer PID and window-visibility transitions

**What happened, twice.**
- Matching the macOS crash report to the session required launch-timestamp
  forensics, because no operational record names the renderer's OS pid:
  `window.created` logs no fields (`app/main/main.ts:1121`) and
  `renderer.process.gone` carries only `reason` + `exitCode`.
  `webContents.getOSProcessId()` is currently unused in main.
- The 21:50-22:08 phantom outage stayed a mystery for most of the
  investigation because nothing records window visibility: the saw-tooth of
  `missed`/`unavailable`/`recovered` events had no "the window was hidden the
  whole time" row next to it. The probe now reports `visible` per response
  (landed 2026-08-09, `fb518346`), but main-side show/hide/occlusion
  transitions - which are free and would bracket such episodes exactly - are
  still unlogged.

**Proposed change.** Log the renderer OS pid on `window.created` (post-load)
and `renderer.process.gone`; add one info-level transition event for window
visibility changes (a few records per user action, never per frame).

**Verified, and smaller than it looks.** `window.created` logs no fields
(`app/main/main.ts:1121`) and structurally cannot: it has no entry in
`OPERATIONAL_EVENT_FIELD_KEYS`, so the `?? []` fallback
(`app/shared/operationalLog.ts:189`) forbids every field.
`renderer.process.gone` allows exactly `['reason','exitCode']` (:97).
`getOSProcessId()` has zero call sites in `app/main`. Because `pid` is
already in the key universe (`process.started` uses it), the pid half is two
allowlist edits plus the call. The visibility half is the real work:
`lastKnownRendererVisible` (`app/main/main.ts:232`) is only ever written from
a renderer response (:1777) and read as a decoration on health events
(:1103), so main has no independent visibility source and needs a real
BrowserWindow listener plus one new event name.

**Acceptance.** A dev run's log shows the pid that DiagnosticReports will
name; hiding and revealing the window brackets the interval with two
transition records.

## Related, deliberately not filed

- **Delivery-trace retention vs incident evidence.** 11 stages/frame at 17k
  frames churned the full 100MB retention in 19 minutes; the run's first
  two-thirds of traces were gone before diagnosis began. The fix space
  (sampled full-stage tracing, per-minute rollup records that survive
  rotation, bigger caps) is a design trade-off about what delivery tracing is
  FOR, so it needs an owner decision rather than a drive-by chip.
  `MAX_DELIVERY_TRACE_TOTAL_BYTES` is confirmed at 100MB
  (`app/main/deliveryTraceSink.ts:19`). **Sequence this after task 3.** The
  uncapped anomaly records were writing into the same budget. They are not
  the dominant consumer - 17k frames at 11 stages swamps a few thousand
  anomalies - so this stays a separate question, but measuring the trade-off
  before task 3 lands measures a bug alongside the design.
- **Transcript virtualization** (the likely true source of the OOM) is
  tracked in the incident report's recommendations, not here.

## Dispatch order

Task 3 first: it corrupts the evidence the other three produce, and its
uncapped anomaly records distort the retention question left open above.
Tasks 1 and 2 should carry their encoding decision in the dispatch prompt
rather than leaving it to the implementer, because the record contract
forecloses the obvious approach in both. Task 4 is independent and can run
at any point.
