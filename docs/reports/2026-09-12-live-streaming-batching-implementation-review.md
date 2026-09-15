# Live streaming implementation and measurement preparation review

Date: 2026-09-12. Implementation by the requested **Sol** subagent; independent review by a separate subagent. This record distinguishes source review from runtime acceptance.

## Core verdict

**No unresolved material source-review findings.** The core is ready for isolated Electron verification. Production remains explicitly at `delayMs: 0` in `app/main/main.ts`; there is no claim of active compute or battery savings.

The reviewer checked the production call sites as well as the coordinator. Review-driven fixes cover synchronous send failure and bounded recovery, reentrant delivery, virtual timer deadlines, FIFO eviction before persistence, replay retention through window shutdown, and new-document readiness even when navigation notification is missed. Same-document repeat readiness preserves pending frames.

The reviewed design keeps one FIFO across sessions within a renderer document, with an oldest-frame deadline and frame/byte caps. Permissions, completion, host events and other barriers flush the existing prefix before their own delivery. Navigation discards only pending copies; retained attachment state supplies the new document. Actual sends retain truthful trace staging.

The focused core suite passed **70 tests**. The credential-free non-probe desktop subset passed **4,782 tests**. App and scoped sidecar typechecks passed. The unfiltered desktop suite did not pass under the attempted environment; see the [implementation report](2026-09-12-live-streaming-batching-implementation.md) for the exact limitations. These results do not substitute for Electron, hardening or visual checks.

## Measurement preparation review

The initial benchmark required corrections before an app run would produce credible evidence. Independent review found receipt timestamps being mistaken for commit timestamps, startup CPU contaminating the interval, incomplete completion detection, missing visible bootstrap evidence, Electron directory creation ordering, validation work inside the scored interval, incomplete process cleanup, and reload/acknowledgement identity drift.

The measurement implementation now uses a benchmark-only wrapper around the actual raw-log reducer and a layout-phase observer of the exact committed state. This associates frame identities with a real React state commit. It does not claim to measure paint or all reducer commits. The production renderer source is not instrumented by this work; a temporary build applies checked transform anchors.

The reviewer accepted the corrected small synthetic pilot through `f773ff7a`. Directories are created before Electron path configuration; current-document/subscription identity is checked before accepting ACKs; expected coverage is computed before timing; completion polls return bounded counters; missing CPU baselines invalidate a sample safely. Interruption and normal completion share process-group cleanup, prevent another sample from starting, and retain ownership and scratch if termination cannot be confirmed.

A subsequent headless check found a separate long-history preparation issue: the 9,632-frame initial replay can exceed the real preload's bounded diagnostics queue, so requiring an applied ACK for every historical frame is not a valid completion condition. This is an intentional production diagnostics limit, not evidence of lost application state. Commit `8d769d4c` makes bulk bootstrap history untraced and uses one traced transcript marker for committed/bootstrap acknowledgement readiness. All warmup/scored arrivals retain full tracing and production diagnostics limits are unchanged. Bulk replay/ACK performance is explicitly outside this streaming measurement.

Final headless harness checks: **14 pass, 0 fail** across observer, runtime and cleanup tests; app typecheck passed; isolated transformed build passed, including long-history preparation. The real acknowledgement queue/guard test covers all six bootstrap workloads. See the [measurement README](2026-09-12-live-streaming-measurements/README.md) for exact preparation and run commands.

**Final independent preparation verdict through `8d769d4c`: no unresolved preparation blocker; approved for a separately authorized synthetic pilot and the declared workload matrix.** This is source/build approval only. No Electron launch, runtime result or performance acceptance is claimed. Documentation validation passed with seven existing recommendation warnings; owned-file whitespace validation passed.

## Acceptance still required

The prepared workload compares original immediate delivery, the new coordinator at zero delay, and 8/16 ms candidates across sparse, paced 4/8-session, long-history, burst and permission-barrier cases. Synthetic arrivals are declared assumptions, not captured provider traffic. The headless smoke passed all 24 workload/policy combinations for ordering, immutability, four-store final state and timer cleanup.

Keep the plan's fixed selection bars: at least 20% combined main/renderer CPU reduction in the declared paced workloads, added p95 latency at most 20 ms and p99 at most 32 ms, no sparse-workload regression above 5% beyond noise, and no idle work. These are proposed acceptance targets, not estimates or measured outcomes. Retain immediate delivery if the evidence does not support a candidate.

The focused Electron benchmark omits engine, supervisor and host workers, production recovery/health timers and operational logging outside delivery tracing. Report its results as delivery-pipeline CPU, not whole-application CPU or energy. Actual production hardening and fresh GUI/lifecycle acceptance remain separate gates before enabling batching.

## Authorized measurement follow-up

Subsequent runtime checks exposed and fixed fixture-only module loading, readiness-await and selected-session bootstrap issues through `ded44a7d`. Bootstrap now has one bounded traced marker per synthetic session, at most eight; bulk history remains untraced and all scored frames preserve full tracing. The initial one-marker preparation description above records the earlier checkpoint.

The independent reviewer validated the complete **12-sample pilot and separate 72-sample matrix**, reproduced the quantiles, and confirmed the decision: **retain production delay 0**. Neither fixed delay reached 20% lower CPU in paced four-session traffic. The sparse 16 ms p95 boundary remains borderline after conservatively including clock drift; sparse CPU attribution is uncertain because the immediate baselines also vary. Full findings and archived evidence are in the [measurement report](2026-09-12-live-streaming-batching-results.md). Production hardening and full GUI acceptance are not claimed by these measurements.
