# Live streaming measurements

These fixtures support the [reviewed implementation plan](../../migration/specs/2026-09-12-live-streaming-batching-plan.md). All inputs are generated, and no command in a synthetic permission request is executed. Arrival rates are declared assumptions, not measurements of the user's providers or transcripts.

`fixture.ts` defines one deterministic workload manifest and generator shared by the headless and Electron harnesses. The study includes sparse traffic, paced 4/8-session streams, long histories, bursts and permission barriers. Session traces have independent sequence counters. Policy order rotates between repetitions. Preserve raw samples and source/fixture hashes.

## Headless component tier

`run-headless.ts` feeds independently paced frames into the production coordinator and `applyServerFrameBatch`. It runs the real transcript, raw-log, permission and connection reducers; the remaining dispatch handlers are counters. The `original` policy is the previous immediate single-frame delivery behavior, while `0` runs the new coordinator with its delay disabled. The other policies use 8 or 16 ms.

This tier measures single-process CPU, delivery/dispatch counts, queue bounds, feeder lateness and arrival-to-reducer-fold latency. It checks accepted frame order at semantic barriers, unchanged input frames, complete final state for its four reducers, and no retained scheduler timer. It omits Electron IPC, attachment/replay buffering, trace logging, preload/ACKs, actual React work and other store reducers. Its latency endpoint is **not a React commit or visible paint**. It cannot pass the plan's app/pipeline CPU and actual-commit acceptance gates by itself.

Run from the repository root, choosing a new output path each time:

```sh
# Functional smoke only; reported CPU values are not performance scores.
bun docs/reports/2026-09-12-live-streaming-measurements/run-headless.ts --smoke --out /tmp/catcode-streaming-smoke.json

# Full component matrix: 3 repetitions × 6 workloads × 4 policies.
# Run while other tests/builds are idle; roughly 6 minutes of paced input plus setup.
bun docs/reports/2026-09-12-live-streaming-measurements/run-headless.ts --out /tmp/catcode-streaming-headless.json

# A targeted sample set; preserve its limited scope when reporting.
bun docs/reports/2026-09-12-live-streaming-measurements/run-headless.ts --workload paced-8 --policy 8 --out /tmp/catcode-streaming-paced8-policy8.json
```

Each non-smoke sample has a separate 1-second warm-up with fresh state, followed by 4 seconds of scored input. Initial history projection and final validation are outside the CPU interval. The runner records every sample, refuses to overwrite an existing result and rejects a run if its listed source inputs changed while measuring. Record machine activity separately; the source check cannot detect unrelated CPU contention.

Preparation verification: the 250 ms functional smoke passed all 24 workload/policy combinations, including synthetic permission barriers and long histories. Frame order, source immutability, the four final reducer states and timer cleanup passed. Those short runs ran during development and are not CPU evidence.

The live coordinator is created even in the `original` sample but is never called there; its construction is outside the measured interval. For the actual baseline check, only direct single-frame delivery and the same renderer handlers execute during that interval. Queue and feeder timer costs are included in treatment CPU. Finite per-frame numeric measurement arrays are bounded by the declared fixture length and are not production telemetry.

## Real Electron tier

The `app/scripts/streaming-benchmark*` harness builds an isolated fixture main, the actual preload, and the actual App with a benchmark-only transform. The transform tracks frames through the raw-log reducer into the exact state observed by a React layout effect. A receipt acknowledgement is recorded separately and is not treated as a commit. Frames that do not change raw-log state are excluded from that latency population and counted separately. The observer does not measure visible paint or all stores' commit latency.

Bulk initial history is untraced, and one traced transcript marker per synthetic session establishes committed bootstrap and its acknowledgement barrier (at most eight markers). This avoids requiring lossless historical diagnostics from the production queue, which intentionally has bounded retention and rate limits, while allowing the real app to select any fixture session. Warmup and scored streaming arrivals retain their full original traces through the real sink, preload queue and rate guard. Bulk historical replay/acknowledgement performance is excluded; this study measures streaming with the declared history already present.

CPU is measured over scored input and bounded completion/acknowledgement drain using cumulative main/renderer process deltas. Bootstrap, expected-state computation and clock calibration are outside that interval. Before/after clock correlation records alignment uncertainty. Instrumentation and completion polling are included in CPU, so results describe this **instrumented delivery pipeline**. They are not whole-application CPU or energy measurements. Engine, supervisor and host workers, production recovery/health timers and operational logging outside delivery tracing are omitted.

Each sample uses its own temporary config, Electron user-data and session-data directories. No engine or provider starts. The renderer/preload/main bundles live in temporary output directories, preserving shared application build outputs. The runner uses an allowlisted child environment, records source and fixture hashes, writes raw samples to the chosen durable directory without overwriting a sample, and cleans up only the process group it created. Other activity on the machine is not automatically detected; record it alongside the results.

These commands run from the repository root. The first prepares and checks the build without launching Electron. The others require authorization for that run:

```sh
# Build-only preparation; no app launch.
bun run app/scripts/streaming-benchmark.ts

# First pilot: paced 4-session workload, all four policies, three repetitions.
# Opens 12 temporary windows sequentially; about one minute of input plus startup.
bun run app/scripts/streaming-benchmark.ts --run --workload paced-4 --out /tmp/catcode-streaming-electron-pilot-20260912

# Full matrix: six workloads × four policies × three repetitions, rotated policy order.
# Opens 72 temporary windows sequentially; six minutes of input plus startup.
bun run app/scripts/streaming-benchmark.ts --run --out /tmp/catcode-streaming-electron-matrix-20260912
```

Choose a new output directory for each run. A workload has one second of warmup followed by a fresh-document reset and four seconds of scored input. The reload does not preserve the previous renderer document's warmed state; it separates warmup state and counters from scoring. Consequently this short study is not evidence of long-duration steady-state behavior.

For the pilot, verify visible synthetic transcript bootstrap, exact committed frame order/coverage, complete current-document acknowledgements, valid unchanged CPU process membership, clock uncertainty, and confirmed owned-process cleanup before interpreting performance. The `original` policy directly sends each forwarded frame without calling the coordinator: it reproduces the previous delivery behavior within this fixture, rather than running a historical whole-app binary. Compare `original` against `0` to quantify the new coordinator's disabled-path overhead. Compare candidates against both baselines; a coordinator overhead regression cannot be hidden by selecting the weaker baseline. Report raw repetitions and variation, not only an average.

The pilot establishes whether this harness can run and produce credible samples. The full matrix tests the declared performance targets within this measurement scope. Production hardening, actual lifecycle/visual acceptance and assessment of instrumentation overhead remain separate before enabling a nonzero policy. This production React build records commit counts and state-commit latency, but does not supply the commit-duration profiling requested in the plan; that evidence also remains outstanding. Subsequent authorized runs are recorded in the [measurement results](../2026-09-12-live-streaming-batching-results.md); the headless preparation checks below did not establish CPU savings or battery improvement.

Final headless preparation evidence through `8d769d4c`: 14 observer/runtime/cleanup tests passed, including all six bootstrap workloads against the real acknowledgement queue and rate guard; desktop typecheck passed; the isolated transformed renderer/preload/main build passed, including `--workload long-history-8`. No Electron window was launched by these checks.

```sh
bun test app/scripts/streaming-benchmark-observer.test.ts app/scripts/streaming-benchmark-cleanup.test.ts app/scripts/streaming-benchmark-runtime.test.ts
bun run --cwd app typecheck
bun run app/scripts/streaming-benchmark.ts --workload long-history-8
```

The independent reviewer approved preparation through `8d769d4c` for an authorized pilot and this matrix, with the scope limits above. Runtime/performance acceptance remains pending.
