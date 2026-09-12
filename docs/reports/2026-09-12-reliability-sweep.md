**Reliability sweep, 12 September 2026**

Completed seven areas of corrective work in `/Users/pt/cat-code`, with ten
implementation commits and regression tests. The initial checkout was `e3864a2f`
on `main`. Other sessions were actively changing the same checkout throughout;
their source edits were preserved.

The agent tool accepted three subagent instances and rejected another instance
with `agent thread limit reached`, even after an agent finished. Those three
agents completed nine bounded assignments across implementation and independent
review. This is the closest available execution to the requested greater-than-five
subagent run; it was not six simultaneous or distinct subagent instances.

**Completed changes**

| Area | Demonstrated failure | Result |
|---|---|---|
| Notebook edits | Rounded modification times and a validation/execution gap allowed replacement files or retargeted links to receive an edit based on unread contents. | NotebookEdit checks the prior Read identity, rechecks after waiting for the mutation lock, uses verified publication, and updates its cache only after success. |
| File reads | Same-time replacement files and retargeted links returned `file_unchanged`. | Read deduplication requires a matching cached identity. Missing identity causes a fresh read. |
| Settings saves | Atomic replacement overwrote settings symlinks, aliases used different locks, and a destination retarget could redirect publication. | Saves preserve normal and dangling symlinks, lock the physical target, retain one read/write destination, and reject retargeting. Two-process contention preserves both updates. |
| Custom agent loading | Ripgrep exit 2 from one absent optional directory rejected the complete agent catalog. | Only a directory independently proven absent is treated as empty. Errors for existing directories still propagate. Desktop startup again receives its custom agents. |
| Codex HTTP streaming | Premature EOF could be reported as successful completion; canceling a returned response left upstream work running. | EOF becomes a connection failure, partial tool calls remain incomplete, safe text continuation retains its existing safeguards, explicit incomplete responses remain provider failures, and response cancellation releases the upstream request/reader. Completed responses finish without waiting for socket EOF. |
| Project configuration | Lock, write, or updater failures entered an unlocked retry that could repeat side effects and publish changes. | Project saves now fail closed, retain diagnostics, and preserve file bytes and cached state. Normal saves and no-ops retain their existing behavior. |
| Build checking | Failure to start TypeScript, checker crashes, malformed configuration, or stderr diagnostics could produce a passing undefined-name check. | The gate distinguishes source diagnostics from failed checker execution, examines both output channels, and rejects partial crash output. Known unrelated source diagnostics remain tolerated. |

Independent review found the settings retarget and partial-checker-crash gaps
after the first fixes. Both were reproduced and corrected. A separate final
transport review exercised cancellation failure and already-aborted callers:
the reader unlocked without unhandled rejections, and aborted callers made no
HTTP request or WebSocket connection.

**Changed files**

These are the eighteen code/test files edited by this run, plus this report.

| Area | Files |
|---|---|
| Build gate | [undefinedNamesLint.ts](/Users/pt/cat-code/scripts/undefinedNamesLint.ts), [undefinedNamesLint.test.ts](/Users/pt/cat-code/scripts/undefinedNamesLint.test.ts) |
| Notebook edits | [NotebookEditTool.ts](/Users/pt/cat-code/src/tools/NotebookEditTool/NotebookEditTool.ts), [NotebookEditTool.test.ts](/Users/pt/cat-code/src/tools/NotebookEditTool/NotebookEditTool.test.ts) |
| File reads | [FileReadTool.ts](/Users/pt/cat-code/src/tools/FileReadTool/FileReadTool.ts), [FileReadTool.test.ts](/Users/pt/cat-code/src/tools/FileReadTool/FileReadTool.test.ts) |
| Codex transport | [codex-fetch-adapter.ts](/Users/pt/cat-code/src/services/api/codex-fetch-adapter.ts), [codex-fetch-adapter.test.ts](/Users/pt/cat-code/src/services/api/codex-fetch-adapter.test.ts), [codexPartialStreamRecovery.e2e.test.ts](/Users/pt/cat-code/src/services/api/codexPartialStreamRecovery.e2e.test.ts) |
| Settings | [settings.ts](/Users/pt/cat-code/src/utils/settings/settings.ts), [settingsAtomicWrite.test.ts](/Users/pt/cat-code/src/utils/settings/settingsAtomicWrite.test.ts), [settingsWriteContention.probe.test.ts](/Users/pt/cat-code/src/utils/settings/settingsWriteContention.probe.test.ts), [settingsWriteContention.probe.child.ts](/Users/pt/cat-code/src/utils/settings/settingsWriteContention.probe.child.ts) |
| Discovery | [markdownConfigLoader.ts](/Users/pt/cat-code/src/utils/markdownConfigLoader.ts), [markdownConfigLoader.test.ts](/Users/pt/cat-code/src/utils/markdownConfigLoader.test.ts) |
| Project saves | [config.ts](/Users/pt/cat-code/src/utils/config.ts), [configProjectSave.probe.test.ts](/Users/pt/cat-code/src/utils/configProjectSave.probe.test.ts), [configProjectSave.probe.child.ts](/Users/pt/cat-code/src/utils/configProjectSave.probe.child.ts) |
| Report | [2026-09-12-reliability-sweep.md](/Users/pt/cat-code/docs/reports/2026-09-12-reliability-sweep.md) |

**Verification**

Commands ran from `/Users/pt/cat-code`. Local socket/process/watcher tests used
the required local permissions. Desktop initialization used a synthetic API key;
no live model calls, account rotation, or user-state fixtures were used.

| Command or test group | Final result |
|---|---|
| `bun run build:dev:full` | Passed. Built and executed `cli-dev --version`: `2.1.87-dev.20260912.t064308.sha04ef7289`. Undefined-name count 0. |
| `ANTHROPIC_API_KEY=sk-ant-catcode-synthetic-test-key DISABLE_TELEMETRY=1 bun test app/` | 4,788 pass / 0 fail, 293 files, 27,937 assertions. |
| `bun run --cwd app typecheck` | Passed, including the Fast Refresh boundary check. |
| `bun run --cwd app typecheck:sidecar` | Passed; 5,559 upstream diagnostics ignored, no owned diagnostics. |
| `bun run --cwd app renderer:build` | Passed. Existing large-chunk warning remains. |
| `bun test scripts/undefinedNamesLint.test.ts scripts/workspaceMapLint.test.ts scripts/workspaceMapRefreshState.test.ts scripts/mapRoutingNudge.test.ts` | 39 pass / 0 fail. |
| `bun test src/tools/FileReadTool/FileReadTool.test.ts src/tools/NotebookEditTool/NotebookEditTool.test.ts src/tools/FileWriteTool/FileWriteTool.test.ts src/tools/FileEditTool/FileEditTool.test.ts` | 53 pass / 0 fail. |
| `bun test src/services/api/codex-fetch-adapter.test.ts src/services/api/codexPartialStreamRecovery.e2e.test.ts src/services/api/codex-websocket-transport.test.ts` | 155 pass / 0 fail, independently reviewed after both transport changes. |
| `env -u CHOKIDAR_USEPOLLING bun test src/utils/settings/` | 25 pass / 3 feature-gated skips / 0 fail; native notifications passed without polling. |
| `bun test --feature=TRANSCRIPT_CLASSIFIER --feature=AUTO_MODE_UPSTREAM_PORT src/utils/settings/applySettingsChange.test.ts` | 7 pass / 0 fail; covers the three cases skipped above. |
| `bun test src/utils/markdownConfigLoader.test.ts src/utils/ripgrep.test.ts src/tools/AgentTool/loadAgentsDir.test.ts` | 16 pass / 0 fail. |
| `bun test src/utils/configProjectSave.probe.test.ts src/utils/configSaveResult.test.ts src/migrations/runEngineMigrations.probe.test.ts src/migrations/migrateRetiredClaude46ModelsToClaude5.test.ts src/migrations/migrateRetiredGptModelsToGpt56.test.ts` | 23 pass / 0 fail. |
| `git diff --check` | Passed. |

Failure investigation was part of the work. The first sandboxed desktop run was
stopped after blocked process/socket probes and missing-auth initialization
failures made it unsuitable as a baseline. A rerun with local permissions and
synthetic authentication reached 4,786 pass / 2 fail. Both remaining failures
reproduced in the isolated startup file and disappeared after the real discovery
fix. The final full suite passed. Watcher failures under restricted execution
were also rerun successfully with native local notifications.

Before/after regression evidence includes three stale-notebook failures, three
false-unchanged read failures, five truncated/incomplete transport cases, two
cancellation failures, symlink and retarget failures, two discovery failures,
three project-save failure paths, and failed-checker cases. Settings alias
contention was additionally checked by temporarily restoring only the original
lock identity: one update was lost. That mutation was restored immediately;
subsequent verification used the fixed source. Later review probes used scratch
copies only.

Impact and stale-reference review found no need to change schemas, generated
types, tool discovery registries, prompts, permission rules, feature sets, or
dependencies. Existing failure diagnostics were retained or reused. The removed
unlocked config helper has no remaining production call sites. Current maps
remain accurate; unrelated in-progress map edits and `DONE.md` were untouched.
The map checker retains seven pre-existing recommended-section warnings. Root
lint is only a parse check in this repository; it is not used as correctness
evidence.

**Checkpoints and concurrent work**

| Commit | Change |
|---|---|
| `82215c74` | Reject failed checker execution. |
| `38ecd9e8` | Protect notebook edits against stale reads. |
| `9e68807b` | Reject truncated HTTP responses. |
| `9261adfe` | Preserve settings symlinks and canonical lock identity. |
| `ff60d999` | Require identity matches for read deduplication. |
| `5b3dd84d` | Cancel upstream HTTP requests with response bodies. |
| `692fc67f` | Retain custom agents when optional directories are absent. |
| `e6c7913a` | Reject settings destination retargeting. |
| `396089c4` | Reject partial checker crashes and invalid configuration. |
| `04ef7289` | Remove unlocked project-save retries. |

Commit `396089c4` also captured another session's concurrently staged
[multi-session compute audit](/Users/pt/cat-code/docs/reports/2026-09-12-multi-session-compute-audit.md).
This run did not author or alter that report's contents. No history rewrite or
deletion was used to rearrange it. Later commits use explicit file selection at
commit time to exclude other staged work. Nothing was pushed.

**Remaining limits and the next three tasks**

1. Unify general file-mutation lock identity across symlink aliases, then prove
   two-process contention across Edit, Write, NotebookEdit, and patch callers.
   [atomicFile.ts](/Users/pt/cat-code/src/utils/atomicFile.ts:25) still locks the
   caller's path with `realpath: false`. Separate aliases can therefore take
   separate cooperative locks. A lost-write interleaving was not reproduced in
   this run; this is a source-observed follow-up requiring wider caller review.
2. Handle explicit `response.incomplete` termination in the WebSocket transport
   and verify its continuation/accounting semantics. The HTTP path now has an
   explicit terminal classification; the
   [WebSocket loop](/Users/pt/cat-code/src/services/api/codex-websocket-transport.ts:1402)
   handles completed and failed terminals without the corresponding incomplete
   branch. Reproduce before changing its connection-reuse behavior.
3. Exercise and correct HTTP SSE parsing for no-space and multiline `data:`
   fields. The
   [HTTP parser](/Users/pt/cat-code/src/services/api/codex-fetch-adapter.ts)
   currently recognizes `data: ` and parses each line separately. The parser
   limitation was inspected; a provider-facing reproduction remains to be built.

Filesystem identity checks followed by rename are not a general filesystem
compare-and-swap guarantee against noncooperating writers. Live-provider behavior,
GUI interaction, and Electron hardening were not exercised; no desktop files or
security boundaries were changed. The successful renderer build still reports a
large bundle chunk, which remains a separate performance candidate.
