# Harness Design Evaluation Map

Last refreshed: 2026-10-12

## Purpose

Route the offline debug/transcript audit and fixed-case task-restoration
evaluation harness. `scripts/harness-design-eval/README.md` owns run commands,
frozen inputs, and authorization boundaries. Offline scripted responses check
transport and data delivery; they do not establish model quality.

## First Files To Inspect

1. `scripts/harness-design-eval/README.md` for workflow and evidence limits.
2. `scripts/harness-design-eval/audit.ts` and `composition.ts` for offline log extraction.
3. `scripts/harness-design-eval/task-restore-manifest.v2.json` for the frozen case and source contract.
4. `scripts/harness-design-eval/task-restore/prepare.ts` for immutable package preparation.
5. `scripts/harness-design-eval/task-restore/run.ts` and `gateway.ts` for isolated execution and provider translation.
6. `scripts/harness-design-eval/task-restore/collect.ts` and `grade.ts` for result validation and grading.
7. `src/services/compact/taskRestoration.ts` and `src/utils/{sessionStorage,sessionRestore}.ts` for the candidate and production resume path.

## Routing Table

| Concern | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Offline log and transcript audit | `scripts/harness-design-eval/audit.ts` | `scripts/harness-design-eval/composition.ts`, `audit.test.ts` | Reads explicitly named directories and writes aggregate output. Joins transcripts only with matching filename and persisted session identity; it does not infer worker joins. |
| Compaction composition proxy | `scripts/harness-design-eval/composition.ts` | `scripts/harness-design-eval/README.md`, `docs/reports/2026-10-11-harness-improvement-execution.md` | Applies current GPT result-size policy as a UTF-16 proxy. It does not reconstruct historical token counts, prompt assembly, cache savings, or task quality. |
| Frozen task-restoration package | `scripts/harness-design-eval/task-restore/prepare.ts` | `scripts/harness-design-eval/task-restore-manifest.v2.json`, `scripts/harness-design-eval/task-restore/fixtures.ts`, `scripts/harness-design-eval/task-restore/isolation.ts`, `scripts/harness-design-eval/task-restore/policy.ts` | Preparation freezes source, installed dependencies, fixtures, and policy into a fresh destination. Reusing or overwriting a completed package is rejected. |
| Offline fixed-case execution | `scripts/harness-design-eval/task-restore/run.ts` | `scripts/harness-design-eval/task-restore/gateway.ts`, `scripts/harness-design-eval/task-restore/seed.ts`, `scripts/harness-design-eval/task-restore/queue-fixture.ts` | Runs paired attempts through the real supervisor, socket, sidecar, and QueryEngine with scripted transport responses. Requires the documented macOS sandbox/socket setup; transport success is not model-behavior evidence. |
| Optional subscription comparison | `scripts/harness-design-eval/task-restore/freeze-subscription.ts` | `scripts/harness-design-eval/task-restore/subscription.ts`, `scripts/harness-design-eval/task-restore/subscription-preload.ts`, authorization examples | Uses the existing subscription through the parent gateway and a frozen policy. Account access requires explicit user authorization; credentials stay outside the fixture process. |
| Result collection and comparison | `scripts/harness-design-eval/task-restore/collect.ts` | `scripts/harness-design-eval/task-restore/grade.ts`, `scripts/harness-design-eval/task-restore/queue-oracle.ts`, `scripts/harness-design-eval/task-restore-subscription-summary.ts` | Validates immutable result records and reports the frozen evaluator's evidence. A failed or completed result is not silently retried or overwritten. |
| Production candidate behavior | `src/services/compact/taskRestoration.ts` | `src/services/compact/{compact,autoCompact,reactiveCompact}.ts`, `src/utils/{sessionStorage,sessionRestore}.ts`, `app/main/mainDecisions.ts` | The candidate adds bounded, request-scoped task/todo reminders after compaction. It is off by default: the build feature and `CAT_CODE_EVAL_COMPACT_TASK_RESTORE` runtime gate must both be enabled. |

## Tests And Validation

| Surface | Focused command |
|---|---|
| Offline audit and composition | `bun test scripts/harness-design-eval/audit.test.ts` |
| Task-restoration execution, queue oracle, and subscription contracts | `bun test scripts/harness-design-eval/task-restore/evaluation.test.ts scripts/harness-design-eval/task-restore/queue-oracle.test.ts scripts/harness-design-eval/task-restore-subscription.test.ts` |
| Candidate compaction behavior | `bun test src/services/compact/taskRestoration.test.ts src/utils/sessionStorage.test.ts` |

## Traps And Stale Assumptions

- An offline run checks infrastructure and scripted data delivery only. Do not describe it as evidence that a model follows the reminders.
- The audit output omits paths, session/account/conversation/tool IDs, commands, and result bodies. Raw input and output locations still require deliberate handling.
- Use a fresh destination and the matching frozen manifest. Results and failures are immutable evidence, not retry slots.
- The candidate stays disabled unless both the compiled feature and explicit evaluation environment gate are enabled.
- Live subscription mode uses real account capacity and requires explicit authorization. The plain live mode is blocked by the harness policy.
