# Desktop logging: three evidence-density fixes proposed from the first real incident

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
matter, where it becomes the obstacle. The three tasks below were filed as
spin-off chips on 2026-08-10; this report is their shared rationale and
acceptance sketch. None changes the logging system's shape - all three are
additive, closed-vocabulary-compatible, and small.

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

**Acceptance.** A simulated crash after a burst of 5s samples produces a
flight-recorder record containing readings the 30s dedup would have dropped;
vocabulary change is additive; `MAX_OPERATIONAL_FIELDS` respected.

## Task 2 - attribute what queue_saturated drops

**What happened.** At 21:38:02, mid-streaming, 135 operational records were
shed with only `log.suppressed { count: 135, reason: "queue_saturated" }` to
show for it. What those records were is unknowable after the fact.

**Where it lives (corrected).** The shedding is the SIDECAR's operational
logger, not the main-process sink: `app/sidecar/operationalLogger.ts` drops a
record when the stream backlog exceeds `MAX_PENDING_BYTES` (`enqueue`,
~line 85) and reports the count on drain (`reportDrops`, ~line 95-105). The
first chip filed for this pointed at `app/main/operationalLogSink.ts` and was
replaced.

**Proposed change.** Accumulate a per-event-type count next to
`droppedRecords` and surface it in the `log.suppressed` record. The
vocabulary is closed and fields are flat, so the least-invasive encoding is a
compact capped string (for example `"renderer.health.sample:130,diagnostic:5"`)
or a small fixed set of count fields - implementer's choice, stated in their
report.

**Acceptance.** A saturation test shows the histogram matching the dropped
records by type; the record stays within `MAX_OPERATIONAL_STRING_BYTES` /
`MAX_OPERATIONAL_FIELDS`.

## Task 3 - renderer PID and window-visibility transitions

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
- **Transcript virtualization** (the likely true source of the OOM) is
  tracked in the incident report's recommendations, not here.
