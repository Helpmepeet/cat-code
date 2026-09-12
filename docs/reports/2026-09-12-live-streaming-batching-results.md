# Live streaming batching measurements

Date: 2026-09-12. Status: **pilot validated; full matrix running; production remains immediate**.

The user authorized the isolated Electron pilot and subsequent workload matrix. No engine or provider runs in this fixture. The existing production setting remains `delayMs: 0` while the evidence is collected.

## Measurement boundary

This measures the instrumented Electron delivery pipeline: real attachment buffering, delivery coordinator, trace sink, preload, acknowledgement queue, and the actual React App. CPU is the sum of interval Browser and Tab cumulative CPU deltas. Main-process `process.cpuUsage` provides a cross-check and is not added a second time.

Latency runs from actual frame arrival in the fixture main to a layout-phase observation of the exact raw-log state containing that frame. It is not a paint timestamp or a commit-duration profile. Engine/supervisor/host workers, production recovery/health timers, operational logs outside delivery tracing, and bulk bootstrap-history tracing are excluded. These results do not measure whole-application energy or battery life.

Every synthetic session receives a small traced bootstrap marker, so the selected session can prove visible transcript readiness. Initial history itself is untraced; all warmup and scored arrivals retain their original traces and real acknowledgement costs. Scoring uses a fresh document after warmup and does not establish long-duration steady-state behavior.

Machine: Apple M4 Pro, 12 logical CPUs, 24 GiB RAM, Darwin 25.6.0, arm64, Bun 1.4.0, Electron 33.4.11. The user's normal background applications remained running. A between-run snapshot at 11:53:44 UTC recorded load averages of 7.70 / 6.56 / 5.79; this was not a dedicated idle machine.

## Validated pilot

The paced four-session pilot completed all four policies and three repetitions: **12 valid samples**. Each contains 812 scored frames with matching expected/observed trace hashes and latency coverage; sends equal dispatches; CPU interval data is valid; final queues are empty. The independent reviewer recomputed the quantiles and found no validity blocker to proceeding with the full matrix.

| Policy | Median combined CPU seconds | Median frame-to-state-commit p95 | Median sends |
|---|---:|---:|---:|
| Original immediate behavior | 1.865 | 4.472 ms | 812 |
| New coordinator, delay 0 | 1.794 | 4.450 ms | 812 |
| 8 ms | 1.595 | 11.989 ms | 412 |
| 16 ms | 1.495 | 20.199 ms | 232 |

Using the ratio of policy medians, pilot CPU reductions against original immediate behavior were approximately **14.5% at 8 ms** and **19.9% at 16 ms**. Those are pilot observations, not the final selection result. Baselines varied, particularly in the first repetition. The worst observed queue wait for the 16 ms policy was 24.791 ms, about 8.79 ms beyond its configured timer window; report this separately from latency percentiles.

The [raw pilot samples and complete summary](2026-09-12-live-streaming-measurements/electron-pilot/summary.md) are preserved separately from the selection matrix. The summary's 12/72 completeness label means this is intentionally the paced-four-session pilot, not a failed 72-sample run.

## Run provenance

The first three attempts produced no samples and are excluded from all performance comparisons. Runtime verification exposed fixture startup problems that prepare-only builds could not establish: an ESM entry without the required module boundary, awaiting Electron readiness at module scope, and a bootstrap marker belonging to a session that was not selected. The fixes use `main.mjs`, start asynchronous work without awaiting readiness at module scope, and provide bounded markers for every synthetic session. Electron's [main-process ESM documentation](https://www.electronjs.org/docs/latest/tutorial/esm) describes the module-boundary and startup-order requirements.

Validated runtime checkpoint: `ded44a7d`. Summarizer checkpoint: `ffdcd5ed`. Pilot archive checkpoint: `b373bf2d`. Every sample preserves source and workload hashes. The frozen workload definitions were not changed during the fixes.

```sh
# Successful pilot (12 samples, exit 0).
bun run app/scripts/streaming-benchmark.ts --run --workload paced-4 --out /tmp/catcode-streaming-electron-pilot-20260912-04

# Full selection matrix (72 samples; in progress at this checkpoint).
bun run app/scripts/streaming-benchmark.ts --run --out /tmp/catcode-streaming-electron-matrix-20260912-01
```

## Remaining acceptance

The full matrix must still satisfy the reviewed CPU/latency/no-regression thresholds. Production hardening, fresh lifecycle/visual checks, assessment of measurement overhead, and commit-duration profiling are separate outstanding evidence. Native inspection via cua-driver did not complete because its permission-status call hung; that owned command was interrupted. No AX-based GUI acceptance is claimed.
