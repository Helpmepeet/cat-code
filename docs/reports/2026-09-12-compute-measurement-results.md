# Measured compute reductions and the remaining power test

Date: 2026-09-12. Follow-up to the [implemented optimizations](2026-09-12-multi-session-compute-implementation.md).

**Measured result: the diagnostic-write workload used 70.7% less CPU time, and paired usage-history aggregation used 35.9–38.7% less CPU time.** These are measurements of the changed operations, not whole-app or battery percentages. The running desktop application was not restarted or replaced.

## Results on this Mac

Machine: Apple M4 Pro, 12 logical CPUs, 24 GiB memory, Darwin 25.6.0. Logging ran in the installed development Electron runtime's embedded Node 20.18.3, in headless Node mode. Stats ran under Bun 1.4.0, the engine runtime. Benchmarks ran serially; other applications and agent sessions were not stopped. Alternating old/new order and repeated samples reduce the effect of background activity, but do not eliminate it.

CPU time adds user and kernel execution time across the measured process's threads. Elapsed time is the clock time until the operation completes. CPU time can exceed elapsed time when multiple threads work concurrently.

| Workload | Old median CPU | New median CPU | CPU reduction | Old → new median elapsed |
|---|---:|---:|---:|---:|
| Write 50,000 diagnostic records across four synthetic session IDs | 723.8 ms | 212.2 ms | **70.7%** | 709.2 → 202.1 ms |
| History: 128 main sessions, 160 transcript files, 20.2 MB | 77.2 ms | 49.5 ms | **35.9%** | 33.6 → 21.5 ms |
| History: 384 main sessions, 480 transcript files, 60.5 MB | 238.8 ms | 150.9 ms | **36.8%** | 95.2 → 62.1 ms |
| History: 768 main sessions, 960 transcript files, 121.1 MB | 493.4 ms | 302.5 ms | **38.7%** | 199.9 → 131.7 ms |

MB in this table means 1,000,000 bytes. History sizes include files that existing date/header filters can skip; they are corpus sizes, not a claim that every byte was parsed on every pass.

Absolute savings matter: logging saved **0.512 CPU-seconds per 50,000 records**; the largest history case saved **0.191 CPU-seconds per refresh**. If that identical warmed history workload ran twelve times per hour, the arithmetic would be about 2.3 CPU-seconds saved per hour. That is an illustration of the existing approximate analytics cadence, not a measured hourly saving from your actual app. These small background operations cannot justify a large battery-life claim by themselves.

For the other two changes, the existing implementation probes established a maximum-size ASCII title example of 98,304 → 4,096 description bytes, and one authenticated fixture usage GET shared by three simultaneous processes plus a later fourth process. Those are input/request counts. This follow-up did not measure provider inference energy or actual network energy. Account sharing also adds local private-cache work, so request count alone is insufficient to claim its net energy benefit.

## How the comparison was controlled

The old and new implementations came from exact git blobs, with the surrounding dependencies held the same within each comparison. No branches were switched, no application code was changed for measurement, and no real conversations or credentials were read. The synthetic stats harness explicitly blocks network requests. Both variants had to preserve their measured outputs.

**Logging:** eight paired rounds, alternating before/after and after/before. Every child process performed a 2,000-record warmup, then explicit garbage collection, followed by 50,000 measured acknowledgement-rejection records. Timing includes writes and `sink.close()` with its rollups. It excludes process/module startup, sink construction, result validation and temporary-directory cleanup. The sink's write calls buffer through the filesystem; durable flush completion was not measured. Record count and the selected kind/schema/session/stream/sequence/reason fields were validated; variable timestamps and rollup content were not compared. Before source: `bbba34b31c5b700cdaa0cfe2edb3c9109898fdac`; after source: `cdbb2fa183c8df3429f6bcd8e31e76d9948f975e`, file `app/main/deliveryTraceSink.ts`.

**Stats:** six paired rounds at each growing corpus size, alternating order after warmup. The old code used the original concurrent separate 7d/30d calls; the new code used the paired aggregator. Each file had 96 synthetic records with repeated message IDs; ages mix recent overlap, month-only history, and older files. One subagent transcript was added per four main sessions. Samples used the same repetition count for both variants: 16, 8 and 4 complete refreshes per sample at the three sizes. Every complete output was compared outside timing. Normal garbage collection remained enabled. Source blobs: `d9f5eef5dad750ceffe411e6913692e8789bc9ca` before and `d58b9f10f7fb6d31a033045bc7321bbccccaf885` after, file `src/utils/stats.ts`.

Both benchmarks use warmed filesystem caches and synthetic workloads. The larger logging effect mostly removes repeated kernel directory operations. The stats experiment retains independent per-range calculations, so its saving is less than halving all computation. Neither experiment measures the full costs of opening, rendering, running or idling a desktop session.

Raw samples and reproducible harnesses:

- [Logging samples](2026-09-12-compute-measurements/logging-results.json) and [benchmark](2026-09-12-compute-measurements/logging-benchmark.ts).
- [Stats samples](2026-09-12-compute-measurements/stats/results.json), [preparation](2026-09-12-compute-measurements/stats/prepare.ts), [runner](2026-09-12-compute-measurements/stats/run.ts) and [reproduction instructions](2026-09-12-compute-measurements/stats/README.md).

The logging methodology received a read-only independent review. The reviewer found a checksum field-name mistake; the harness was corrected and the eight timed pairs above were rerun with the stronger event validation. The earlier preliminary numbers are superseded by the saved final samples. A final independent report review recomputed the results from all 52 raw samples and found no remaining methodological blocker or overclaim.

## Measuring whole-app energy next

Use two isolated desktop builds with the same synthetic session state, changing only the four optimizations. A full historical checkout could include unrelated changes, so the comparison must isolate the four patches. The user's live app and session directory should stay intact.

For one chosen scenario, warm the app consistently and measure **before → after → after → before, five real minutes each**. That is twenty minutes of capture plus setup and warmup. Test idle sessions and identical active work as separate scenarios. Fix session count, visible page, window size, brightness, power source and Low Power Mode; pause unrelated builds and active agents. Record completed work as well as time, so slower progress cannot look like an energy improvement.

Use app-process-group CPU, wakeups and I/O to explain the difference. macOS `powermetrics` can additionally report an energy-impact proxy and estimated CPU/GPU subsystem power. Integrating estimated power over time gives estimated subsystem energy; it does not give exact per-app joules or total laptop battery consumption. Short battery-percentage comparisons are too coarse and noisy for these changes. The full-app difference may be below measurement noise; an honest result can be "no reliable difference detected."

The following command template is supported by this Mac's local `powermetrics` help/manual. It was checked, **not executed**:

```sh
sudo /usr/bin/powermetrics \
  --samplers tasks,cpu_power,gpu_power,disk,network,thermal \
  --show-process-coalition \
  --show-process-energy \
  --show-process-samp-norm \
  --show-usage-summary \
  -i 5000 -n 60 \
  -o /tmp/cat-code-before-01-power.txt
```

Use a distinct private output location for each capture. Verify which process groups contain Electron, Bun sidecars and their children; do not assume one group covers the app or sum overlapping group/process totals. Administrator authentication and an agreed GUI workload are needed for this next phase. Real-provider calls are unnecessary for a deterministic local test and would introduce server variability and account usage.

## Verification

```text
VERIFICATION
- bun run docs/reports/2026-09-12-compute-measurements/logging-benchmark.ts
  → 16 final timed samples; 50,000 records per sample; count and selected event-field validation passed.
- bun run <prepared-stats-directory>/run.ts --smoke
  → Complete before/after output parity passed on 15 synthetic files (preparation agent).
- bun run <prepared-stats-directory>/run.ts
  → 36 timed samples across three sizes; all complete output comparisons passed. Raw calibration and samples saved.
- Local documentation: powermetrics --help; man 1 powermetrics; man 1 top; man 1 time; man 1 ps
  → Supported commands and interpretation checked read-only by the measurement-tooling agent.
- git diff --check and artifact/link validation
  → Clean diff and artifact whitespace; all JSON parses; every report link target exists.
Not run: full-app power capture, GUI comparisons, real-provider calls, battery-discharge study. Production code was unchanged, so the prior implementation test battery was not repeated for these measurement artifacts.
```
