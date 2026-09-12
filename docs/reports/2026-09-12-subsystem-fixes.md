# Subsystem review fixes

All **24 confirmed findings** from [the ten-subsystem review](2026-09-12-ten-subsystem-review.md) are fixed in `codex/subsystem-fixes`. The final headless checks passed: **4,803 desktop tests**, **20 file-isolated integration regressions**, the engine build, app typecheck, scoped sidecar typecheck, and renderer build. Electron hardening and visual acceptance remain unrun.

Worktree: `/Users/pt/cat-code/.worktrees/subsystem-fixes`. Starting commit: `a375ab57`. GPT-5.6-Sol workers implemented the fixes and regression coverage; the parent reviewed their evidence, requested stronger integration tests where needed, and ran the final verification. Changes remain on this worktree branch, unmerged and unpushed.

The account UI amendment reviewed as AC3 was still uncommitted in the original working tree. Its three relevant files were imported as a baseline before the account worker began: `App.tsx`, `leaseState.ts`, and `leaseState.test.ts`. The exact import is preserved locally at `tmp/subsystem-fixes-2026-09-12/account-ui-baseline.patch`. The original working tree was not edited, and its other uncommitted changes were not imported.

## Findings closed

Every row below is fixed. Counts in the evidence column overlap with other suites and should not be added together.

| Findings | Resulting behavior | Implementation | Focused evidence |
|---|---|---|---|
| UA1–UA4 · Usage Analytics | Activity is counted by event date, including resumed sessions and subagent-only active days. Streaming usage increments are counted once. Read failures preserve last-good desktop data. Model colors remain stable across windows. | `8c302e35`, `e0381f57`; [stats aggregation](../../src/utils/stats.ts), [display state](../../app/renderer/src/statsState.ts) | 134 focused tests passed; the additional subagent-only daily-activity regression passed. |
| RS1–RS3 · Resumed subagents | Local instructions are persisted after confirmed delivery to the provider and survive another resume. Sibling messages retain teammate provenance. Delivery-failure outcomes reach the worker during tool rounds, after a no-tool response, and on its first resumed request. | `a3c21169`, `83d9bf09`; [delivery callback](../../src/query.ts#L1105), [worker persistence](../../src/tools/AgentTool/runAgent.ts#L1144), [origin projection](../../src/utils/attachments.ts) | Worker/runtime suite 42 passed. Real public SendMessage/ResumeAgent, sender-origin, and outcome-drain regressions passed in the final matrix. |
| PE1–PE2 · Peer session tools | Queued peer instructions use the existing resumed-history projection. Search examines the complete allowlisted tool target before display caps, and truncated output is reported truthfully. | `7a9d666e`; [peer history projection](../../app/sidecar/readPeerTool.ts#L922) | Combined peer/composer/App suite 245 passed. |
| AC1–AC3 · Account switching and failover | A delayed cap on A can retry an already-selected healthy B, and a late worker can use the sole healthy alternative. If the current lease is also unavailable, recovery selects another healthy account. A successful own-session idle switch clears obsolete retained failover identity. | `b885d3d2`; [retry handling](../../src/services/api/withRetry.ts), [account pool](../../src/services/api/codexAccountPool.ts), [lease display](../../app/renderer/src/leaseState.ts) | Recovery 3, pool 85, lease 36, retry 2, and desired-behavior probes 3 passed. Recovery regressions passed again in the final matrix. |
| MC1 · MCP connections | A repository agent's named MCP references can use only connected servers from an inherited authorized runtime. A pending project server is not started through AgentTool; the existing standalone CLI path remains available. | `a3c21169`; [worker runtime resolution](../../src/tools/AgentTool/runAgent.ts) | Public project-agent regression proves no pending-server process or child tool exposure. Existing MCP approval/lifecycle controls: 13 passed. |
| QU1–QU2 · Queued messages and interruption | Send now during attachment preparation leaves the instruction deliverable exactly once. Once delivery has removed queue ownership, a late force is refused without duplicating the turn. Refused submissions return in original submission order ahead of the live draft, including out-of-order reply batches and images. | `46af30b8`, `7a9d666e`; [query](../../src/query.ts), [composer settlement](../../app/renderer/src/composerState.ts#L1198); coverage in `864190fc`, `4d5b41d2` | Full QueryEngine/sidecar text-and-image matrix 6 passed; preparation/ownership tests 4 passed; composer/App coverage included in the 245-test suite. |
| PR1–PR2 · Session parking and restore | Restore owns the transcript before loading mutable conversation and queue state, and releases ownership on rejection. Wrong-project restores keep their existing missing-session result. A decoded frame batch stops when parking closes the server. | `a56684a6`, `caa965ab`, `d72d53fc`; [owned restore helper](../../app/sidecar/sessionResume.ts#L70), [sidecar dispatch](../../app/sidecar/sidecarServer.ts) | Maintained resume process suite 5 passed; spawn configuration 6 passed; sidecar server 299 and session resume 11 passed. The original timing race fails against pre-fix code. |
| HI1–HI2 · Conversation history and branching | Active branch selection follows compact-boundary logical ancestry. Recovered history that is deliberately not retained makes replay incomplete and supplies a fresh view anchor, allowing another disk read after renderer reload. | `a56684a6`, `135bd399`; [branch ancestry](../../src/utils/sessionStorage.ts#L4960), [replay completeness](../../app/main/replayBuffer.ts#L366) | Replay 41, storage 46, projector 147, and load-earlier 19 passed. The load-earlier regression proves the disk-read count changes from one to two. |
| CO1–CO3 · Context usage and compaction | Typed API-error summaries are rejected in full, partial, and reactive compaction. Transient reactive failures do not consume the hard-failure budget. Compaction uses the current iteration's resolved model/provider while retaining the base model for leaving plan mode. | `b78b71e2`; [summary validation](../../src/services/compact/compact.ts), [reactive outcome](../../src/services/compact/reactiveCompact.ts), [query model context](../../src/query.ts) | With `REACTIVE_COMPACT`: 137 passed, one intentional feature-off skip, zero failures. |
| SP1–SP2 · Subagent permissions and escalation | Alias resolution stays within the allowed tool set. A terminal ask-parent handoff cancels tools still awaiting permission, rechecks cancellation before execution, and waits for effects that already started before publishing the blocked outcome. | `c4543282`, `46af30b8`; [execution boundary](../../src/services/tools/toolExecution.ts#L1330), [streaming settlement](../../src/services/tools/StreamingToolExecutor.ts#L341); integration coverage in `864190fc` | Alias/authority and executor tests passed. Two real runAgent/query/AskParentSession tests cover delayed permission and an already-started effect. |

## Integration evidence

The permanent PR1 process test uses a real SessionStart hook to hold the original load-before-ownership window open. Against pre-fix `b885d3d2`, the reader returns a stale QueryEngine seed and the marker assertion fails. Against the fix, the first attempt returns busy before the hook; a retry after the writer appends and releases includes the marker. A separate controlled loader rejection keeps its process alive while a second process acquires the released lease, distinguishing explicit cleanup from process-exit recovery.

The first full desktop run found a regression in PR1: a restore from the wrong project returned busy instead of the established missing-session result. `d72d53fc` adds a metadata-only current-project existence check before acquisition; mutable transcript content is still read under ownership. The final full run passed all 4,803 tests. `9d137863` subsequently makes the maintained probe fixtures exit promptly after completing their assertions; that fixture change is included in the final full run.

QU1 coverage crosses the real sidecar controller, app-session adapters, QueryEngine, query loop, and queue. It tests text and image input with no force, force during preparation, and force at the externally visible delivery boundary. SP2 coverage crosses real runAgent, query, and AskParentSession execution, including polling completed tools while model streaming continues. Model I/O and timing barriers are scripted fixtures; these results do not claim live provider or GUI timing.

## Final verification

All commands ran from the worktree. The local `tmp/subsystem-fixes-2026-09-12/run-isolated.ts` runner creates temporary configuration directories, supplies an inert fixture key, disables nonessential traffic, and removes the temporary configuration afterward. The full desktop suite required local socket/process access beyond the filesystem sandbox; no Electron app or live account was used.

| Check | Result | Local log |
|---|---|---|
| `bun test app/` | **4,803 passed, 0 failed**; 27,997 assertions across 293 files | `tmp/subsystem-fixes-2026-09-12/full-app-tests.log` |
| Eight file-isolated regression suites listed below | **20 passed, 0 failed**; 106 assertions | `tmp/subsystem-fixes-2026-09-12/final-regressions.log` |
| `bun run build:dev:full` | Passed; undefined-name lint zero; maps lint passed; engine compiled and version printed | `tmp/subsystem-fixes-2026-09-12/final-engine-build.log` |
| `bun run --cwd app typecheck` | Passed, including Fast Refresh lint | `tmp/subsystem-fixes-2026-09-12/final-app-typecheck.log` |
| `bun run --cwd app typecheck:sidecar` | Passed; wrapper reports 5,563 upstream diagnostics ignored | `tmp/subsystem-fixes-2026-09-12/final-sidecar-typecheck.log` |
| Raw engine type diagnostic comparison | **Zero introduced diagnostics** across all 29 changed/new `src/` paths: 88 normalized baseline diagnostics and the same 88 current diagnostics | `tmp/subsystem-fixes-2026-09-12/all-changed-src-{base-confirmation,current-confirmation-after,introduced-confirmation-after}-normalized.log` |
| `bun run --cwd app renderer:build` | Passed; existing large-chunk warning remains | `tmp/subsystem-fixes-2026-09-12/final-renderer-build.log` |

The raw repository typecheck remains known-red; it is not reported as passing. The comparison used an exact archive of base `a375ab57`, the same installed dependencies, and normalized file/diagnostic messages without line-number drift. Introduced fixture type errors found during integration were corrected before the final comparison. The engine build retains 18 ignored-app-file lint warnings, with zero lint errors.

The final regression matrix runs each file in a fresh isolated process with `bun test <path> --timeout 10000`:

- `src/querySidecarForce.integration.test.ts`
- `src/tools/AgentTool/runAgentTerminal.integration.test.ts`
- `src/queryQueuedPromptRace.test.ts`
- `src/tools/AgentTool/resumeDelivery.regression.test.ts`
- `src/tools/AgentTool/localSenderOrigin.regression.test.ts`
- `src/tools/AgentTool/workerOutcomeDrain.regression.test.ts`
- `src/tools/AgentTool/mcpAuthority.regression.test.ts`
- `src/services/api/accountRecovery.test.ts`

Current callers and tests were checked for the tool execution/delivery callbacks, owned resume helper, history projection, and changed compaction/account behavior. The analytics map was corrected because opening-header date filtering no longer describes the implementation. The account maps now distinguish general rotation from recovery relative to a failed request account, where one healthy alternative suffices. The final documentation commit records `maps:lint` and `git diff --check` results in the migration status entry.

## Remaining acceptance and scope

`bun run --cwd app test:hardening` remains **unrun**: its runner launches Electron. [CLAUDE.md §3](../../CLAUDE.md#L143) says, “Launching is a GUI action requiring authorization for that run (§8).” Approval for that run is still needed. After approval, run the hardening command through the same temporary-config runner and require every smoke check to pass. It is a security smoke check, not a substitute for visual acceptance.

The changed renderer behaviors have headless coverage; their GUI acceptance remains unverified. In an authorized operator session, check the Accounts usage windows for consistent model colors and resumed activity; complete an own-session idle account switch after failover and verify the selected account label; refuse multiple queued submissions with images and verify that the composer restores their original order ahead of the current draft. Provider-backed exercises require their own live-account authorization.

No locked architecture decision, inbound protocol union, security baseline, dependency, or prototype parity requirement was changed. No GUI acceptance is claimed. Unverified suggestions and previously deferred work in the historical review remain outside these 24 confirmed findings.
