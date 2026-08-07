# S03 — swarm, multi-agent spawn, Agent tool

## Verdict

The new allocation state machine in `teamHelpers.ts` is genuinely good work: one
locked read-modify-write path (`transactTeamFile`), a state machine that fails
closed on unexpected transitions, and tombstones that guarantee a recipient name
is never reused. The `spawnMultiAgent.ts` "+537/-535 rewrite" is not a rewrite —
roughly 500 of those lines are re-indentation from wrapping each handler body in
a `try { … } catch { tombstone; throw }`. The only behavioral removals are
`generateUniqueTeammateName` and the inline `sanitizeAgentName`, both correctly
superseded by `allocateTeamRecipient`. Nothing was lost there.

The single most important thing to fix is the **compensation-vs-launch ordering
in the spawn handlers**: the teammate process is started (pane `send-keys`, or
`startInProcessTeammate`) *before* the last two fallible steps, and the catch
block only tombstones the allocation — it never stops the thing it just started.
Because `resolveTeamPrincipalByName` skips `terminated` records, the survivor is
an unaddressable zombie: it cannot be sent a message, cannot be shut down through
the hardened control path, and its own permission requests will fail authority
checks. Secondary but close behind: the initial task prompt is delivered through
the *legacy* mailbox overload that swallows every failure, while the tool result
tells the model "Spawned successfully… the agent is now running."

A large amount of the surface in scope is dead. `handleSpawnSeparateWindow`
(~220 lines), the entire `TeammateExecutor` layer (`PaneBackendExecutor`,
`InProcessBackend`, `getTeammateExecutor`), and the in-process-teammate AgentTool
carve-out are all unreachable — and this branch spent real hardening effort on
two of the three.

## Findings

### [HIGH] Spawn failure after launch tombstones the allocation but leaves the teammate running and unaddressable
- **Where**: `/Users/pt/cat-code/src/tools/shared/spawnMultiAgent.ts:421` → `:466` → `:516-519` (split-pane); `:637` → `:690` → `:740-743` (separate window); `:910` → `:987` → `:1030-1033` (in-process)
- **Type**: correctness
- **What**: In all three handlers the teammate is started first (`sendCommandToPane`, `send-keys`, or the fire-and-forget `startInProcessTeammate`), and only *afterwards* does `transitionTeamRecipient({from:'starting', to:'active'})` run. The catch block calls `tombstoneFailedRecipient` and rethrows. Nothing kills the pane or aborts the in-process controller.
- **Trigger / why it matters**: `transitionTeamRecipient` throws on three real conditions — `TeamFileLockError` (lock retries exhausted: `teamHelpers.ts:293-298` gives ~400ms total, and each concurrent AgentTool spawn takes 3 team-file locks; `AgentTool.isConcurrencySafe()` returns true and `toolOrchestration.ts:11` runs up to 10 spawns at once), `Team "X" does not exist` (`teamHelpers.ts:376-378`, e.g. a concurrent `TeamDelete` or `cleanupSessionTeams` `rm -rf` of the team dir), and `RecipientTransitionError`. On any of them the process is already alive. Because `resolveTeamPrincipalByName` (`/Users/pt/cat-code/src/utils/teammateMailbox.ts:426-428`) filters out `terminated` records, the survivor can no longer be resolved: `SendMessage` to it fails, `writeControlRequestToMailbox` shutdown fails, and its own `sendPermissionRequestViaMailbox` fails. For the pane variants it also keeps a tmux/iTerm2 pane and a full second `cat-code` process (with its own Codex account pool) alive with no roster entry.
- **Fix**: Move the launch to be the *last* fallible step, or give the catch block the handle it needs to undo the launch — capture `paneId`/`backendType` (and `result.abortController` for in-process) in the enclosing scope and, in the catch, kill the pane / abort the controller before tombstoning.

### [HIGH] The teammate's initial task prompt is delivered best-effort, but the tool reports unconditional success
- **Where**: `/Users/pt/cat-code/src/tools/shared/spawnMultiAgent.ts:490-498` and `:714-722`; result text at `/Users/pt/cat-code/src/tools/AgentTool/AgentTool.tsx:2076-2081`
- **Type**: correctness
- **What**: Both pane handlers deliver the entire task via the *positional* `writeToMailbox(name, message, teamName)` overload, which resolves to `legacyWriteToMailbox` (`/Users/pt/cat-code/src/utils/teammateMailbox.ts:260-318`). That function logs and returns on every failure — inbox-create failure at `:278-286`, lock/read/write failure at `:310-312` — and never throws. Its own doc comment (`:251-258`) says new call sites should use the object-form overload "which throws `MailboxWriteError` so callers can report truthful delivery failure."
- **Trigger / why it matters**: Any `EACCES`/`ENOSPC` on `~/.cat-code/teams/<team>/inbox/`, or lock-retry exhaustion on the teammate's inbox during a fan-out, drops the message silently. The teammate boots, polls an empty inbox forever, and does nothing; the leader is told "Spawned successfully. … The agent is now running and will receive instructions via mailbox." The leader then waits on a teammate that has no task. This is the one mailbox write whose loss costs the entire spawn, and it is the one still on the swallowing path — the hardening that made broadcasts truthful stopped short of it.
- **Fix**: Switch these two call sites to the principal-based overload (resolve the recipient from the snapshot already required for the `active` transition) and let `MailboxWriteError` propagate into the existing catch.

### [HIGH] Team-file writes truncate in place while readers take no lock, so a torn read reads as "team does not exist"
- **Where**: `/Users/pt/cat-code/src/utils/swarm/teamHelpers.ts:241-248` (`writeTeamFileAsync`), `:197-208` (`readTeamFile`, sync + unlocked), `:213-226` (`readTeamFileAsync`, unlocked)
- **Type**: correctness
- **What**: Every version-2 mutation ends in `writeFile(path, json)` — `O_TRUNC` then write — so the file is empty or partial for the duration. The lock protects writer-vs-writer only. The unlocked readers are numerous (`useSwarmInitialization.ts`, `teamDiscovery.ts`, `reconnection.ts`, `teammateInit.ts`, `TeamCreateTool`, `TeamDeleteTool`, and `teamHelpers`' own `killOrphanedTeammatePanes`/`cleanupTeamDirectories`), and `readTeamFile` maps a JSON parse failure to `null` — indistinguishable from "no such team."
- **Trigger / why it matters**: `setMemberActive` fires on every teammate turn boundary, so writes are frequent. Press Ctrl-C while any teammate flips active/idle: `cleanupSessionTeams` → `killOrphanedTeammatePanes` (`:1129-1131`) reads `null`, returns early without killing anything, and then `cleanupTeamDirectories` `rm -rf`s the team dir anyway. Result is exactly the orphaned-teammate-processes-in-open-panes case that `killOrphanedTeammatePanes` exists to prevent, with no error surfaced.
- **Fix**: Write to `${path}.tmp` and `rename()` into place (atomic on POSIX) in `writeTeamFileAsync`/`writeTeamFile`. Readers then never observe a partial file and need no lock.

### [HIGH] In-process teammate's system prompt is built for the leader's model and provider, not its own
- **Where**: `/Users/pt/cat-code/src/utils/swarm/inProcessRunner.ts:1126-1131`
- **Type**: correctness
- **What**: `resolveInProcessRuntime` calls `getSystemPrompt(tools, toolUseContext.options.mainLoopModel, …)`. Inside, `/Users/pt/cat-code/src/constants/prompts.ts:728` does `resolveRequestProvider(model)` and `isGPTPromptStyle(requestProvider)` to pick the prompt style. The teammate's actual model is `config.model` — the runner already computes `teammateProvider = getProviderForModel(model)` at `:1263-1264` and passes `model` to `runAgent` at `:1474`. The same wrong model is used for the teammate's compaction threshold at `:1352`.
- **Trigger / why it matters**: Leader on a `claude-*` model, `Agent(name: "w", model: "gpt-5.6-terra", team_name: "t")` with the in-process backend. Per the repo's own routing rule the model string wins, so requests go to the Codex/OpenAI path while the system prompt was rendered in Claude style. The mismatched compaction threshold additionally fires at the wrong point for the teammate's own context window. This predates the branch, but `resolveInProcessRuntime` is new code extracted specifically for "prompt/tool-pool consistency" (`:1066-1079`) — it fixed the `tools` argument and left the `model` argument, which selects the prompt *dialect*, still pointing at the leader.
- **Fix**: Pass `model` (the teammate's) instead of `toolUseContext.options.mainLoopModel` at `:1128`, and at `:1352`.

### [MED] Built-in and plugin agent types are silently dropped for in-process teammates
- **Where**: `/Users/pt/cat-code/src/tools/shared/spawnMultiAgent.ts:874-885`
- **Type**: correctness
- **What**: `agentDefinition` is only set when `isCustomAgent(foundAgent)` — and `/Users/pt/cat-code/src/tools/AgentTool/loadAgentsDir.ts:174-178` returns false for both `'built-in'` and `'plugin'` sources. When it stays undefined, `resolveInProcessRuntime` falls to `agentToolNames = ['*']` (`inProcessRunner.ts:1095-1108`) and appends no custom instructions.
- **Trigger / why it matters**: `Agent(name: "scout", subagent_type: "Explore", team_name: "t")` on the in-process backend produces a teammate with none of Explore's system prompt and none of its tool restrictions — a full-privilege generic teammate wearing the Explore label. This is the same class as the resume path that wired an empty agent-definition set. It is also a backend divergence: the pane handlers pass `--agent-type` on the command line (`:388`, `:605`) so the child process reloads the built-in definition correctly, and `AgentTool.tsx:682` already reads `agentDef?.model` off the same lookup — so the model is honored while the prompt and tools are not.
- **Fix**: Widen the gate to accept any `AgentDefinition` and pass it through; `resolveInProcessRuntime` only needs `.tools`, `.disallowedTools`, `.getSystemPrompt()`, `.memory`, `.model`, all of which built-in and plugin definitions have.

### [MED] Two divergent copies of the teammate command-line builder, both live
- **Where**: `/Users/pt/cat-code/src/tools/shared/spawnMultiAgent.ts:198-265` vs `/Users/pt/cat-code/src/utils/swarm/spawnUtils.ts:23-133`
- **Type**: quality
- **What**: `getTeammateCommand` and `buildInheritedCliFlags` exist twice with the same names and near-identical bodies, and they have drifted in *both* directions. `spawnUtils.ts:78` pushes `--teammate-mode ${sessionMode}` and has no `permissionMode === 'auto'` branch; `spawnMultiAgent.ts:231-236` has the `'auto'` branch and never pushes `--teammate-mode`.
- **Trigger / why it matters**: `--teammate-mode` is a real CLI option (`/Users/pt/cat-code/src/main.tsx:4046`). A leader started with `--teammate-mode tmux` spawns pane teammates through `spawnMultiAgent`'s copy, so those teammates boot in `auto` and re-run backend detection instead of inheriting the operator's explicit choice. The auto-permission-mode inheritance is inverted between the two. Whichever copy a reader opens, it is 50% wrong about what a teammate actually inherits.
- **Fix**: Delete the `spawnMultiAgent.ts` copies, import from `spawnUtils.ts`, and merge the `'auto'` branch into the surviving one.

### [MED] `handleSpawnSeparateWindow` and the whole `use_splitpane` path are unreachable
- **Where**: `/Users/pt/cat-code/src/tools/shared/spawnMultiAgent.ts:526-744` plus `:164-191` (`hasSession`, `ensureSession`), `:126`, `:148`, `:1075-1079`
- **Type**: dead-code
- **What**: `spawnTeammate` has exactly one call site — `/Users/pt/cat-code/src/tools/AgentTool/AgentTool.tsx:675` — and it hardcodes `use_splitpane: true`. `handleSpawn`'s `input.use_splitpane !== false` therefore always selects the split-pane handler. `TeammateTool` no longer exists in the tree (only `TeamCreateTool` and `TeamDeleteTool` remain), yet the module header at `:1-4` and the `spawnTeammate` doc at `:1086-1089` still describe it as shared with `TeammateTool`.
- **Trigger / why it matters**: ~220 lines of unreachable code that the branch spent effort re-indenting into the new try/catch, and which will keep attracting maintenance (it received the same `transitionTeamRecipient` treatment). It also doubles the surface a reader must diff to answer "what changed in spawn?"
- **Fix**: Delete `handleSpawnSeparateWindow`, `hasSession`, `ensureSession`, and the `use_splitpane` field; collapse `handleSpawn` to the in-process/split-pane choice. Update the two stale `TeammateTool` doc comments.

### [MED] The entire `TeammateExecutor` layer is unreferenced — including the shutdown-authority hardening this branch added to it
- **Where**: `/Users/pt/cat-code/src/utils/swarm/backends/PaneBackendExecutor.ts`, `/Users/pt/cat-code/src/utils/swarm/backends/InProcessBackend.ts`, `/Users/pt/cat-code/src/utils/swarm/backends/registry.ts:404` and `:425`
- **Type**: dead-code
- **What**: A repo-wide search for `getTeammateExecutor`, `getInProcessBackend`, `new PaneBackendExecutor`, and `new InProcessBackend` finds no reference outside those four files and one stale doc comment — not even in tests. The live spawn path is `spawnMultiAgent`'s handlers; the live kill path is `killInProcessTeammate` from `/Users/pt/cat-code/src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx:28`; the live shutdown path is `SendMessage` with `{type: "shutdown_request"}` (`/Users/pt/cat-code/src/tools/TeamCreateTool/prompt.ts:45`).
- **Trigger / why it matters**: This branch rewrote `terminate()` in both executors to use `readTeamSnapshot` + `resolveTeamPrincipalByName` + `writeControlRequestToMailbox` — correct, careful, authority-checked work applied to code that cannot run. The cost is not just the lines: a reader auditing "is shutdown authority-checked?" finds a hardened implementation and stops looking.
- **Fix**: Delete the layer, or wire `spawnMultiAgent`/`InProcessTeammateTask` through it. Do not leave it in the middle.

### [MED] The in-process-teammate carve-out for the Agent tool is statically unreachable
- **Where**: `/Users/pt/cat-code/src/tools/AgentTool/agentToolUtils.ts:163-168`
- **Type**: dead-code
- **What**: `filterToolsForAgent` returns false at `:135` for anything in `ALL_AGENT_DISALLOWED_TOOLS`, long before the `environment === 'in-process-teammate'` branch at `:163`. `/Users/pt/cat-code/src/constants/tools.ts:55-56` puts `AGENT_TOOL_NAME` and `RESUME_AGENT_TOOL_NAME` in that set unless `process.env.USER_TYPE === 'ant'`, and `/Users/pt/cat-code/scripts/build.ts:133` compiles `process.env.USER_TYPE` to the literal `'external'`. So the `AGENT_TOOL_NAME` line at `:166` can never be reached in any shipped build. (The `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` line at `:170` *is* reachable — those tools are not on the disallow list.)
- **Trigger / why it matters**: This branch rewrote exactly this branch (`isInProcessTeammate()` → `environment === 'in-process-teammate'`) as part of the prompt/tool-pool consistency work, so it reads as load-bearing. Downstream, the two guards at `/Users/pt/cat-code/src/tools/AgentTool/AgentTool.tsx:643-651` ("Teammates cannot spawn other teammates", "In-process teammates cannot spawn background agents") are unreachable for the same reason. This is also the answer to whether nested agent depth is bounded: it is hard-bounded at 1, by tool availability rather than by any depth counter.
- **Fix**: Drop the `AGENT_TOOL_NAME` special case at `:166` and the now-unreachable guards, or move `AGENT_TOOL_NAME` out of `ALL_AGENT_DISALLOWED_TOOLS` into the async-only list if nested spawn from teammates is actually wanted.

### [MED] `resolveSystemSubagentName` can leak a permanently-unreclaimable `reserved` allocation
- **Where**: `/Users/pt/cat-code/src/tools/AgentTool/AgentTool.tsx:335-345`, called from `:965` — outside the compensating `try` that starts at `:976`
- **Type**: correctness
- **What**: The explicit-name branch performs the durable `allocateTeamRecipient` first, then throws at `:344` if `tryReserveWorkerName(record.name)` returns false. Nothing tombstones the record. `TeamRecipientRecord`s are never deleted (`teamHelpers.ts:72-77`), so the key stays occupied for the life of the team, and `recoverStartingRecipient` only handles `starting`. The caller cannot compensate: `resolveSystemSubagentName` is awaited at `:965`, and the `catch` at `:1077` that *does* tombstone (`:1082-1087`) only covers work after `:976`.
- **Trigger / why it matters**: `getReservedSubagentNames` (`:246-273`) reads `agentNameRegistry` + persisted metadata + tracked workers; it does **not** read the process-local `activeNames` set that `tryReserveWorkerName` guards (`/Users/pt/cat-code/src/agent-mode/workerNames.ts:26`). So a name held only by a concurrently-launching subagent passes the `:331` pre-check, wins the team allocation, then fails the process-local claim. The window is narrow, but the damage is permanent and silent, and the shape is fragile by construction: an irreversible side effect followed by fallible work with no compensation.
- **Fix**: Either reserve the process-local name *before* `allocateTeamRecipient`, or wrap the allocate-and-reserve pair so the `throw` path calls `tombstoneFailedRecipient` first.

### [MED] A failed permission-request delivery is discarded and the teammate then waits forever
- **Where**: `/Users/pt/cat-code/src/utils/swarm/inProcessRunner.ts:401` and `:404-451`; same pattern at `/Users/pt/cat-code/src/hooks/toolPermission/handlers/swarmWorkerHandler.ts:123`
- **Type**: correctness
- **What**: `void sendPermissionRequestViaMailbox(request)` discards a `Promise<boolean>` whose `false` means the request was never delivered. `sendPermissionRequestViaMailbox` (`/Users/pt/cat-code/src/utils/swarm/permissionSync.ts:679-720`) returns false on `readTeamSnapshot` lock failure, on leader-principal resolution failure, and on `writeControlRequestToMailbox` failure. The polling loop that follows has **no timeout** — it polls the teammate's inbox at `PERMISSION_POLL_INTERVAL_MS` indefinitely; the only exit is `abortController`.
- **Trigger / why it matters**: `readTeamSnapshot` takes the *team* lock, and this now runs on the hot path of every permission-gated tool call for every teammate. With several teammates hitting permission prompts concurrently, lock-retry exhaustion (`teamHelpers.ts:293-298`) makes the request vanish; the teammate then hangs on that tool call for the rest of the session, burning a poll every interval, with no message anywhere the operator can see.
- **Fix**: Await the result and, on `false`, resolve the decision as `{behavior:'ask'}` with a delivery-failure message; independently, give the poll a bounded deadline.

### [LOW] `readTeamSnapshot`'s "detached, immutable snapshot" is only shallow-frozen
- **Where**: `/Users/pt/cat-code/src/utils/swarm/teamHelpers.ts:344`
- **Type**: quality
- **What**: `Object.freeze(structuredClone(teamFile))` freezes the top-level object only; `snapshot.recipientRecords`, `snapshot.members`, and `snapshot.pendingControls` remain mutable arrays. `Readonly<TeamFile>` is shallow too, so `snapshot.members.push(...)` both compiles and mutates.
- **Trigger / why it matters**: No caller mutates today, but the doc comment at `:322-327` sells the return value as immutable and callers hold it across awaits. The next consumer that "just filters in place" gets no compile error and no runtime error.
- **Fix**: Freeze the arrays too, or type the return as `DeepReadonly<TeamFile>`.

### [LOW] `recoverStartingRecipient` has no production caller
- **Where**: `/Users/pt/cat-code/src/utils/swarm/teamHelpers.ts:578-621`
- **Type**: dead-code
- **What**: Referenced only by `teamHelpers.test.ts` and by a comment at `AgentTool.tsx:692`. Its whole purpose is reclaiming a `starting` allocation whose launcher died, and nothing ever invokes it.
- **Trigger / why it matters**: A leader killed with SIGKILL mid-spawn leaves a `starting` record that no code path will ever resolve — the recovery routine written for exactly that case is not wired to any startup or sweep. (`DONE.md` already lists this as a known deferred gap, so this is a confirmation, not a discovery.)
- **Fix**: Call it during team reconnection/startup for records whose `launcherInstanceId` differs from `PROCESS_INSTANCE_ID`, or delete it.

### [LOW] Teammate system prompt omits additional working directories
- **Where**: `/Users/pt/cat-code/src/utils/swarm/inProcessRunner.ts:1129`
- **Type**: correctness
- **What**: The third argument to `getSystemPrompt` is `undefined`, so `computeSimpleEnvInfo` (`/Users/pt/cat-code/src/constants/prompts.ts:717`) renders no additional-working-directory block. `AgentTool.tsx:997` passes `Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys())` for ordinary subagents.
- **Trigger / why it matters**: A leader with `/add-dir` directories spawns an in-process teammate that inherits the permission context but is never told those directories exist, so it will not use them unprompted.
- **Fix**: Thread the leader's `additionalWorkingDirectories` through, as the subagent path already does.

### [LOW] Identical race handled two different ways, one line apart in behavior
- **Where**: `/Users/pt/cat-code/src/tools/AgentTool/AgentTool.tsx:343-345` vs `:378`
- **Type**: quality
- **What**: The explicit-name branch throws when `tryReserveWorkerName` returns false; the pooled-name branch discards the same boolean and proceeds. Both then hand `processReservationName` to `releaseWorkerName` at `:1079`/`:1196`, so the pooled branch can release a reservation another in-flight spawn owns.
- **Trigger / why it matters**: The two branches disagree about whether the process-local claim is authoritative, and the comment at `:292-298` asserts the reservation is always held — which is false for the `:367` fallback, which returns `agentId` without reserving it at all.
- **Fix**: Make both branches treat the boolean the same way, and reserve on the `:367` fallback path so the "always held" invariant is true.

### [LOW] `in_process_teammate` names the task type for out-of-process teammates
- **Where**: `/Users/pt/cat-code/src/tools/shared/spawnMultiAgent.ts:777`, `:785`, `:789`
- **Type**: convention
- **What**: `registerOutOfProcessTeammateTask` — a function whose name says out-of-process — builds an `InProcessTeammateTaskState` with `type: 'in_process_teammate'` and `generateTaskId('in_process_teammate')`, for tmux and iTerm2 pane teammates. Every downstream consumer (`utils/teammate.ts:208/223/246`, `BackgroundTasksDialog.tsx:205`, `pillLabel.ts:34`, `sessionStorage.ts:5141`) then cannot distinguish the two execution models. The state is also inconsistently populated: the pane variant omits `messages`, `model`, `spinnerVerb`, and `pastTenseVerb`, and `spawnInProcess.ts:179`'s comment justifying `messages: []` cites `getDisplayedMessages`, a function that no longer exists.
- **Trigger / why it matters**: A name that actively lies, on a discriminant. `killInProcessTeammate(taskId)` matches pane tasks and happens to work only because the abort listener at `spawnMultiAgent.ts:816-824` kills the pane; the correctness is coincidental rather than expressed.
- **Fix**: Add a `backendType` (or `execution: 'in-process' | 'pane'`) field to the task state rather than reusing the type discriminant, and rename `InProcessTeammateTaskState` to a neutral `TeammateTaskState`.

## What is good here

- `transactTeamFile` (`teamHelpers.ts:359-396`) is the right shape: lock → fresh-read → validate → apply once → write once → unlock, with a genuinely thoughtful edge case — a lock-release failure *after* a committed write returns a `warning` instead of throwing, precisely so a caller does not retry and double-apply. Every mutation helper in the file was converted to it, so there is now exactly one write path.
- The recipient state machine fails closed on both axes: `transitionTeamRecipient` matches allocation ID *and* expected `from` state, and `tombstoneFailedRecipient` deliberately does not require an exact `from` because a compensating catch cannot know how far setup got (`:623-634`). The reasoning for that asymmetry is written down where the code is.
- `resumeAgentBackground`'s ownership transfer (`resumeAgent.ts:78-107`) is a real fix for a real class of bug: the lock is now held until the *detached lifecycle promise* settles, not until launch setup returns, with a supplementary fresh-read status check at `:281-291` because the set only guards same-`agentId` callers. Both the mechanism and its limits are stated.
- `resolveAgentTools`' provider-alias handling (`agentToolUtils.ts:241-251`, `:279-291`) closes a subtle capability hole in both directions — a role that disallows `Edit` also loses `Apply_patch`, and a role that requests `Edit` resolves to `Apply_patch` on the OpenAI path — so a provider swap cannot silently change a role's logical permissions.
- Explicit `AgentToolEnvironment` instead of the ALS-derived `isInProcessTeammate()` is the correct call, and the doc comment at `agentToolUtils.ts:87-95` explains exactly why an ALS read gives the wrong answer when tools are resolved before the context exists. The same discipline appears at `inProcessRunner.ts:110-115`, where the shutdown poll resolves the principal by name specifically because it runs outside the teammate's ALS scope.

## Not reviewed / uncertain

- **Lock-contention thresholds.** I established that each concurrent AgentTool team spawn takes three team-file lock transactions and that the retry budget is ~400ms (`teamHelpers.ts:293-298`), and that up to 10 spawns run concurrently by default (`toolOrchestration.ts:11`). I did **not** measure whether 30 back-to-back acquisitions actually exhaust that budget on a real filesystem. This affects how *often* the HIGH ordering bug fires, not whether it exists — the other trigger (team directory removed mid-spawn) is independent of timing. A two-process contention probe would settle it; `DONE.md` records that such a probe was planned and never built.
- **`process.env.USER_TYPE`.** I concluded the in-process AgentTool carve-out is dead from `scripts/build.ts:133` inlining `'external'`. If any build path leaves `USER_TYPE` as a runtime variable, that finding becomes conditional rather than static. I did not run a build to confirm the inlining.
- **`app/` side of `agent_name`.** The audit asked about identity stability across resume for the recent `agent_name`-on-nested-frames commits. The engine side is clean (names are allocation-unique per team and case-collision-safe via `recipientNameKey`; `resolveAgentTarget` now matches case-insensitively). Whether the desktop projector keys frames by `agent_name` in a way that survives restore is `app/` territory and outside this scope.
- I did not run any test suite; per the contract this was a read-only review. Every finding above was verified by reading source, and each cites the file and line where the behavior is decided.
