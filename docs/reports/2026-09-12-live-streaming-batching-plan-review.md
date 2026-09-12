# Live streaming batching plan review

Date: 2026-09-12.

Plan: [Live streaming batching implementation plan](../migration/specs/2026-09-12-live-streaming-batching-plan.md).

Reviewer: fresh subagent `/root/streaming_plan_review`, given the plan and repository paths without the author's prior reasoning. The review was read-only and checked the proposal against current production source. The author subsequently supplied two independently noticed edge cases for evaluation.

## Initial verdict

The reviewer found the design sound and requested three P2 clarifications and two P3 corrections before calling it ready. No need for a broader redesign emerged. These are findings about the proposed plan, not five demonstrated bugs in the current application.

| Finding | Source evidence | Revision |
|---|---|---|
| **P2: Existing acknowledgements cannot establish commit-latency percentiles.** They contain no renderer event time and may wait in a separate 50 ms queue, making receipt timing a confounded metric. | [Acknowledgement shape](/Users/pt/cat-code/app/shared/deliveryTrace.ts:153), [preload queue configuration](/Users/pt/cat-code/app/preload/preload.ts:165), [main receipt handling](/Users/pt/cat-code/app/main/main.ts:2249). | Require benchmark-only actual commit timestamps, frame identity correlation and validated clock alignment. Report arrival-to-ack separately. A missing commit measurement leaves the latency gate unverified. |
| **P2: Preserve delivery origin explicitly.** A one-frame attachment/coalescer output may contain an original live delta without a replay payload flag. This is a latent contract gap; normal initial snapshots contain additional ready/sticky frames. | [Coalescer output](/Users/pt/cat-code/app/main/attachmentGate.ts:167), [replay snapshot](/Users/pt/cat-code/app/main/replayBuffer.ts:480). | Add a main-only origin, default immediate, and opt in only the ordinary live-forwarding path. Test singleton replay/coalescer output. |
| **P2: Define send-failure recovery wiring.** Catching an exception and detaching could leave a still-open window waiting forever if Electron emits no later loss event. | [Current delivery](/Users/pt/cat-code/app/main/main.ts:1163), [renderer-loss callback](/Users/pt/cat-code/app/main/main.ts:1716). | Extract a shared window-owned transition, bounded recovery/give-up, and duplicate-loss handling. Test with and without a later Electron loss event, plus shutdown and recovery exhaustion. |
| **P3: Correct stronger proof wording.** Current UI-committed proof is restricted to the active rendered terminal lifecycle outcome. | [Post-commit effect](/Users/pt/cat-code/app/renderer/src/App.tsx:689), [terminal proof eligibility](/Users/pt/cat-code/app/renderer/src/App.tsx:1155). | Preserve that exact scope. Background outcomes and ordinary result completion retain existing applied proof. |
| **P3: Name the byte-budget metric.** A serialized JSON size is neither Electron's transport size nor heap usage. Existing ordinary live frames already have trace metadata, so current trace undercount was not demonstrated. | [Trace before gate](/Users/pt/cat-code/app/main/main.ts:1888). | Specify UTF-8 JSON accounting including trace metadata and array punctuation. Measure accounting overhead and memory separately. |

The reviewer also found the plan adequately covered FIFO barriers, host-event ordering, bounded replay, StrictMode, teardown, state-equivalence tests and honest performance acceptance.

## Final verification

The same subagent reread the revised plan and confirmed **all five findings resolved**, with **no material new gap introduced**. Final verdict: **ready to implement once implementation is authorized**. It also confirmed that the frozen fixture manifest makes the proposed comparison reproducible and that performance/latency results remain unproven.

Document checks verified all 34 local links and source-line ranges across the plan and this record, with no missing paths or trailing whitespace. Source anchors were also inspected during authorship and review. These checks validate a planning artifact; they are not application test results.

No streaming implementation, performance benchmark, application launch, provider request or live-state change was performed for this planning task.
