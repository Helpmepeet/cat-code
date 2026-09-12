# Live streaming batching measurements

Date: 2026-09-12. Status: **72-sample matrix complete and independently reviewed; retain immediate delivery**.

The user authorized the isolated Electron pilot and subsequent workload matrix. No engine or provider ran in this fixture. **Neither fixed delay met the reviewed requirement of at least 20% lower CPU in both the paced four-session and eight-session workloads.** Production therefore remains at `delayMs: 0`.

## Decision and full-matrix results

Batching reduced CPU for busy workloads, especially eight sessions with long histories. It did not meet the agreed bar for enabling a fixed delay globally. The four-session result is sufficient to reject both candidates under this plan, regardless of the stronger long-history result. No activation or further application launch is needed to make that decision.

The following values compare the median combined main/renderer CPU for three repetitions of each policy with the median original-immediate baseline. Positive means less CPU; negative means more CPU. Repetition-level results and both baseline comparisons are preserved in the [complete matrix summary](2026-09-12-live-streaming-measurements/electron-matrix/summary.md).

| Workload | CPU saved at 8 ms | CPU saved at 16 ms |
|---|---:|---:|
| Sparse, one session | −15.7% | −16.8% |
| Paced, four sessions | 9.1% | 15.7% |
| Paced, eight sessions | 15.2% | 25.2% |
| Long history, eight sessions | 20.3% | 31.9% |
| Bursts, four sessions | 14.4% | 10.8% |
| Permission barriers, four sessions | 9.9% | 15.7% |

Using the new coordinator at zero delay as the comparison instead gives 11.4% / 17.8% savings for paced four-session traffic and 17.6% / 27.3% for paced eight-session traffic (8 ms / 16 ms respectively). Neither candidate clears both workloads against that baseline either. The original baseline bypasses the new coordinator inside the same fixture; it is not a historical whole-app executable.

Sparse traffic produced no send reduction: every policy sent 43 batches. Its original-immediate CPU ranged from 0.461 to 0.675 seconds, and the zero-delay coordinator median was also 17.9% higher than original. The two batching candidates were slightly lower than the zero-delay coordinator. This short, variable study does not isolate a sustained batching-caused regression or establish the required sparse no-regression claim.

| Latency check, worst repetition paired with either immediate baseline | 8 ms | 16 ms |
|---|---:|---:|
| Added p95 state-commit latency | 10.409 ms | 20.141 ms |
| Added p99 state-commit latency | 10.550 ms | 19.422 ms |

The p95 limit is 20 ms; p99 is 32 ms. The 8 ms results remain within both. One sparse 16 ms comparison is borderline: the 20.141 ms added p95 has a conservative clock allowance of approximately ±0.149 ms, giving 19.992–20.290 ms. Treat it as unverified at the boundary, rather than a clean pass or a confident hard failure. All p99 comparisons remain below their limit. The CPU requirement independently fails.

The original raw result field used the maximum of endpoint clock uncertainty and half the observed offset drift. For this analysis, the conservative bound adds those terms, and paired uncertainty adds the candidate and baseline bounds. Raw samples are immutable; their recorded calibration values permit this correction without rerunning or changing observed timings.

All **72/72 samples** passed independent data validation: matched workload/source hashes, unique matrix cells, complete expected raw-state frame/latency coverage, matching trace-order hashes, no observer overflow, valid Browser/Tab CPU intervals, matching send/dispatch counts, and empty final delivery queues. Scored intervals including completion drain were 4.029–4.085 seconds.

At 8 ms, sends fell by 49.3% for paced four-session traffic and 68.2% for paced eight-session traffic; at 16 ms they fell by 71.7% and 83.4%. Those reductions did not translate into equally large CPU reductions. Observed queue high-water marks were seven frames and 4,028 bytes, below the 32-frame / 256 KiB bounds. Maximum queue waits were 14.621 ms at 8 ms and 20.949 ms at 16 ms, overruns of about 6.62 ms and 4.95 ms respectively. These are separate from the latency percentile checks.

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

Validated runtime checkpoint: `ded44a7d`. Initial summarizer checkpoint: `ffdcd5ed`; conservative uncertainty correction: `8bb71176`. The equivalent future-run harness reporting correction is `749a481b`; it was not used to mutate or rerun these samples. Pilot archive checkpoint: `b373bf2d`. Every sample preserves source and workload hashes. The frozen workload definitions were not changed during the fixes.

The final benchmark-focused suite passed **17/17**, strict app typecheck passed, and the derived summaries passed validation against all archived samples. These focused checks supplement the core implementation evidence; they do not claim an unfiltered full desktop-suite pass.

Archive verification confirmed that all 84 raw sample files match their original run outputs byte-for-byte. Documentation checks passed: `git diff --check` was clean and `bun run maps:lint` passed with seven existing recommended-section warnings.

```sh
# Final focused verification: 17 tests passed; strict app typecheck passed.
bun test app/scripts/streaming-benchmark-observer.test.ts app/scripts/streaming-benchmark-cleanup.test.ts app/scripts/streaming-benchmark-runtime.test.ts
bun run --cwd app typecheck

# Successful pilot (12 samples, exit 0).
bun run app/scripts/streaming-benchmark.ts --run --workload paced-4 --out /tmp/catcode-streaming-electron-pilot-20260912-04

# Full selection matrix (72 samples, exit 0).
bun run app/scripts/streaming-benchmark.ts --run --out /tmp/catcode-streaming-electron-matrix-20260912-01

# Reproduce the corrected summary from immutable archived samples.
bun docs/reports/2026-09-12-live-streaming-measurements/summarize-electron.ts --input docs/reports/2026-09-12-live-streaming-measurements/electron-matrix
```

## Remaining acceptance

This fixed-policy proposal stops at immediate delivery because the CPU threshold was not met. A policy aimed specifically at high traffic or long histories would be a new proposal and would need its own measurements; these favorable cases do not authorize a global setting change.

Production hardening, fresh lifecycle/visual checks, assessment of measurement overhead, and commit-duration profiling remain separate outstanding evidence before any nonzero policy could be enabled. Native inspection via cua-driver did not complete because its permission-status call hung; that owned command was interrupted. No AX-based GUI acceptance is claimed.
