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

A separate `app/scripts/streaming-benchmark*` harness is being prepared to exercise the coordinator, preload and actual App in isolated temporary state. It must identify its measurement boundary, verify frame-to-committed-state association and clock uncertainty, and preserve the user's app/profile. An Electron run is separately authorized only after the harness/build and exact run matrix are reviewable. No real Electron performance result is claimed by this document.
