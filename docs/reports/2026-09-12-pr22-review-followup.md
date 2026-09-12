# PR #22 review follow-up

All seven supplied findings were independently verified by GPT-5.6-Sol agents,
then fixed by fresh GPT-5.6-Sol implementation agents in the requested
`codex/subsystem-fixes` worktree. The orchestrator validated the findings before
fixes, inspected the resulting integration, and re-executed the regressions.
There are two high-severity and five medium-severity findings, all with
user-visible effects; all seven are closed, with historical analytics precision
explicitly disclosed where the old data cannot support an exact reconstruction.

This follows up [PR #22](https://github.com/Helpmepeet/cat-code/pull/22), which
remains unmerged. It covers the supplied findings and affected integration
paths, not a new independent review of every file or the 34 earlier local
commits already included with the user's approval. The original
[subsystem report](2026-09-12-subsystem-fixes.md) remains a historical snapshot.

## Validation before fixes

Reviewed snapshot: `73c4dad393c31abadc9d75c74c3d44828c40beab`. Actual PR base:
`2453710d1a1d58cb29a0065b10583d35bfeed2bc`. The following ledger was recorded in
`ed03e52b` before production edits. Its line references refer to the reviewed
snapshot.

| ID | Severity | Impact | Source | Finding | Verdict |
|---|---|---|---|---|---|
| F1 | HIGH / P1 | user-visible | `src/tools/AgentTool/runAgent.ts:202` | A child cwd substitutes an unapproved MCP configuration for an inherited approved server name. | VALID |
| F2 | HIGH / P1 | user-visible | `src/utils/sessionStorage.ts:4952` | Null-root replacement history after editing the first prompt disappears from cold-resume context. | VALID |
| F3 | MEDIUM / P2 | user-visible | `src/tools/AgentTool/runAgent.ts:780` | Terminal handoff aborts a borrowed parent controller when the child lacks its own controller. | VALID |
| F4 | MEDIUM / P2 | user-visible | `src/tools/AgentTool/runAgent.ts:584` | A startup delivery outcome reaches the first resume but is omitted from persistence and the next resume. | VALID |
| F5 | MEDIUM / P2 | user-visible | `app/renderer/src/composerState.ts:1203` | A known refusal stays hidden behind a missing reply and cleanup discards the retained input. | VALID |
| F6 | MEDIUM / P2 | user-visible | `src/utils/statsCache.ts:14` | A version-3 session-day cache overlaps the new event-day pass on upgrade. | VALID |
| F7 | MEDIUM / P2 | user-visible | `src/utils/stats.ts:583` | Adding daily session fragments overcounts unique sessions and truncates duration. | VALID |

## Final behavior and discriminating evidence

The final production/test snapshot is `05d6c6466c9b9a0cd373b0a2ec0e74c0c9ad37e7`.
Subsequent report and STATUS commits change documentation only.

| ID | Fixed behavior | Executed evidence |
|---|---|---|
| F1 | Named MCP authorization reuses the exact inherited connected client. | Public AgentTool with custom cwd does not launch substituted server B and discovers the approved client's tool. The same test on reviewed production starts B and fails. |
| F2 | Ordinary null roots advance the rewound active branch; compact boundaries retain logical ancestry. | Public QueryEngine rewind in one process, then production cold resume/controller construction and real QueryEngine inspection in another. Fixed seed is 2 messages; reviewed source seeds 0 and fails the same test. |
| F3 | A synchronous worker owns its controller and follows parent cancellation in one direction. Setup failure and completion remove the listener. | Actual disabled-background AgentTool caller publishes a blocked handoff, leaves its parent alive, then successfully runs another AgentTool call on that parent. Reviewed source aborts the parent and fails. Existing pending-permission and parent-cancellation controls pass. |
| F4 | Initial persistence is selected after startup outcome attachments are assembled. | Production ResumeAgentTool first and second requests contain the outcome; stored history and second request contain it exactly once. Ordinary SendMessage durability also passes. Reviewed source loses the outcome and fails. |
| F5 | Known refusals return immediately, in submission order, preserving edits and applying only new attachment effects. All draft writers share one current-state update path. | Forward/reverse batches, three replies around live edits, recall interleaving, duplicate replies, accepted final siblings, and known refusals on either side of unknown submissions pass. Replacing only the reducer with its reviewed body makes both immediate-refusal tests fail. |
| F6 | A separate v4 cache preserves v3 history and checkpoints each parent/worker transcript independently. New appended records are counted without recounting the observed legacy prefix. | Actual-base v3 cross-day fixture upgrades to 1 session, 2 messages, 200 input tokens. Equal-timestamp new UUIDs count; old duplicate UUIDs do not. Parent/worker upgrade preserves 800 tokens and a later worker append reaches 900. Reviewed source inflates the cross-day fixture and fails. |
| F7 | Durable compact session summaries reconcile unique identity and the complete observed duration across daily partitions. | Three rollovers retain 1 session, 3 messages, 300 input tokens and 93,600,000 ms duration. Reviewed source grows to 2 sessions at the second rollover and fails. Missing/restored identity and repeated reads are covered. |

The decisive tests above **DISCRIMINATE**: the same desired assertions pass on
the fixed code and fail on reviewed production or a minimal isolated reversion
of the relevant reducer. No shared production file was temporarily reverted.
Additional helper and integration controls cover cleanup and ordering without
claiming that every assertion was individually mutation-tested.

### Historical analytics constraint

The v1-v3 cache contains aggregate totals without enough provenance to decide
which already-present transcript events it counted. The migration preserves
those aggregates and the original `stats-cache.json`. Compact observed-record
checkpoints establish a boundary for subsequent appends, including worker
transcripts, equal timestamps, and duplicate legacy UUIDs. No transcript bodies
or per-message UUID lists are persisted in the cache. Compact session identities
remain durable so disappearing and restored transcripts are not counted anew.

Activity already present at migration but absent from the old aggregate may
remain understated. CLI Overview, Models, and copied output disclose:
**“Some older activity may be estimated.”** This is an irreducible precision
limit in the old data, not a silent cache reset. No live user cache was migrated
while testing. Separate filenames prevent an older installed v3 writer from
overwriting v4; filesystem locking, a fresh read under the lock, and atomic
writes protect concurrent v4 operations.

## Verification

Tests ran with isolated temporary configuration and synthetic transcripts,
harmless MCP fixtures, and scripted model I/O. There were no live provider,
credential, or account operations. Commands below were run through
`tmp/subsystem-fixes-2026-09-12/run-isolated.ts` where applicable.

| Check | Result |
|---|---|
| `bun test app/` | **4,812 passed, 0 failed**, 28,026 assertions across 293 files. |
| File-isolated integration matrix, 9 files | **23 passed, 0 failed**, 125 assertions. |
| `bun test ./src/utils/stats.test.ts ./src/utils/statsCache.test.ts ./src/utils/statsCache.integration.test.ts --timeout 10000` | **14 passed, 0 failed**, 59 assertions. |
| `bun test ./app/renderer/src/composerState.test.ts --timeout 10000` | **115 passed, 0 failed**, 288 assertions. |
| Storage, rewind, resume focused suites | Sol verified storage **47/0**, QueryEngine rewind **3/0**, resume seed **6/0**; the orchestrator also re-executed the decisive first-message cold-resume test. |
| Fixture type repair suites, file-isolated | Sol verified streaming fallback **5/0**, Codex fetch adapter **116/0**, incomplete response **3/0**, atomic file probes **10/0**. |
| `bun run build:dev:full` | Passed: maps lint, undefined-name lint, branch-diff lint, engine compilation and version print. |
| `bun run --cwd app typecheck` | Passed, including Fast Refresh lint. |
| `bun run --cwd app typecheck:sidecar` | Passed; 5,562 upstream diagnostics ignored by the scoped wrapper. |
| `bun run --cwd app renderer:build` | Passed; existing large-chunk warning remains. |
| Root diagnostic comparison | No introduced diagnostics against the actual PR base with equivalent dependency graph; details below. |
| `git diff --check`, `bun run maps:lint` | Passed; maps retain 7 existing recommended-section warnings. |

The first desktop attempt was blocked by sandbox restrictions on local sockets
and fixture-process inspection. It was cancelled after the complete rerun
outside that sandbox passed with the same isolated configuration. This was an
environmental retry, not a code change to bypass a failing assertion.

The integration matrix contains `querySidecarForce.integration.test.ts`,
`runAgentTerminal.integration.test.ts`,
`AgentTool.disabledBackgroundTerminal.integration.test.ts`,
`queryQueuedPromptRace.test.ts`, `resumeDelivery.regression.test.ts`,
`localSenderOrigin.regression.test.ts`, `workerOutcomeDrain.regression.test.ts`,
`mcpAuthority.regression.test.ts`, and `accountRecovery.test.ts` at their
existing source locations. Local logs and exact command manifests are under
`tmp/pr22-review-followup-2026-09-12/`; scratch evidence is not committed.
External source archive locations and recovery commits are recorded there.

### Actual PR base type comparison

Raw root typechecking at the actual PR base produced 1,875 diagnostics. The
PR's new QueryEngine/sidecar integration test imports desktop code into the root
compiler graph. Adding only that same production sidecar import to an isolated
base archive reproduces 22 additional desktop diagnostics: **1,897** with the
equivalent graph. These desktop files have their own passing strict/scoped
gates above.

The reviewed head had 1,906 diagnostics in that graph. Nine added occurrences
were fixed: one UUID annotation in the cancellation guard and eight fetch or
subprocess fixture annotations. Those fixture repairs also eliminated five
matching inherited occurrences. Final root output is **1,892**, versus the
matched base's **1,897**, with no added file/code occurrences or new diagnostic
causes after path normalization and source inspection. Three AgentTool
TS2322 messages print different schema text due to cwd but retain the same
inherited causes. Raw root typechecking remains known-red; it is not reported
as a passing gate.

## Scope and remaining acceptance

All seven requested fixes are verified closed at the exercised boundaries.
The public disabled-background caller and actual rewind/cold-resume hops now
have execution coverage. F1 still uses a synthetic approved MCP client and
scripted model output. F5 runs the production reducers/restoration transitions
and App wiring checks; mounted React interaction, real IPC disconnect/close,
and GUI acceptance remain unverified.

No fresh Electron GUI run was performed. The previous authorized hardening run
passed **19/19** at the reviewed snapshot. This follow-up leaves Electron main,
preload, and inbound protocol/security-boundary code unchanged; the current
phase's Standing rules require fresh hardening when that boundary is touched.
The passing earlier smoke is historical evidence, not a newly executed check.

§0: requested worktree retained; no locked architecture, security baseline,
new dependency, inbound wire contract, or desktop prototype parity change.
The v4 local analytics cache is an intentional persistence-format change.
Optional visual acceptance can be ordinary use: an edited first prompt should
survive reopening, and refused input should reappear without replacing newer
edits or attachments. Timing-specific acceptance is covered by automated tests.
