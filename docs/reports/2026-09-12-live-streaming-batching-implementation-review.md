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

Final preparation review and its remaining runtime limitations are recorded below when the corrected harness is stable.

## Acceptance still required

The prepared workload compares original immediate delivery, the new coordinator at zero delay, and 8/16 ms candidates across sparse, paced 4/8-session, long-history, burst and permission-barrier cases. Synthetic arrivals are declared assumptions, not captured provider traffic. The headless smoke passed all 24 workload/policy combinations for ordering, immutability, four-store final state and timer cleanup.

Keep the plan's fixed selection bars: at least 20% combined main/renderer CPU reduction in the declared paced workloads, added p95 latency at most 20 ms and p99 at most 32 ms, no sparse-workload regression above 5% beyond noise, and no idle work. These are proposed acceptance targets, not estimates or measured outcomes. Retain immediate delivery if the evidence does not support a candidate.

The focused Electron benchmark omits engine, supervisor and host workers, production recovery/health timers and operational logging outside delivery tracing. Report its results as delivery-pipeline CPU, not whole-application CPU or energy. Actual production hardening and fresh GUI/lifecycle acceptance remain separate gates before enabling batching.
