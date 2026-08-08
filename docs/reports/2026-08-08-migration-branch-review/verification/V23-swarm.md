# S03 adversarial validation: swarm, multi-agent spawn, Agent tool

> **Verification provenance:** Claude Opus 5, high effort. Read-only source review
> plus three scratch repro scripts (all under
> `/private/tmp/claude-501/.../scratchpad/v23/`, nothing written into the repo except
> this file). Ran **one** scratch `bun test` file of my own authorship against the
> real repo modules; ran **no** repo test suite, no build, no GUI, no desktop app.
> Branch `migration`. **The tip moved under me mid-verification**: it was
> `a17e5e9` when I started and `ad649cc` ("feat(tools): let a spawning agent
> select its subagent's effort", another session) when I finished. The S03
> report's `AgentTool.tsx` line numbers match `a17e5e9` exactly, so every
> `AgentTool.tsx` citation below is validated against `a17e5e9`; `ad649cc` shifts
> them by roughly +18 after line 620. `src/utils/swarm/*` and
> `src/tools/shared/spawnMultiAgent.ts` were unchanged by that commit and are cited
> as they sit on disk.

## Overall verdict

The S03 report is substantially right, and better than most in this set: 8 of 16
findings survive intact, 6 survive in narrower form, and only 2 are invalid. Its
headline meta-claim is also correct and I confirmed it independently:
`git diff -w main...HEAD -- src/tools/shared/spawnMultiAgent.ts` is **84
insertions / 82 deletions** against the raw 537/535, so ~453 lines on each side
are pure re-indentation from wrapping each handler in `try { … } catch
{ tombstone; throw }`. The one finding that most deserves action is the HIGH
spawn-ordering bug, which I **reproduced end to end**: the teammate is launched,
the post-launch transition throws, the allocation is tombstoned, and
`resolveTeamPrincipalByName` then returns `null` for the survivor.

The report's own internal contradiction, which the audit flagged, resolves
cleanly in the report's favour: `handleSpawnInProcess` (in `spawnMultiAgent.ts`)
is not merely reachable, it is the **default** path (`isInProcessEnabled()`
returns true for any session not inside tmux/iTerm2, and it is checked *before*
`use_splitpane`). The dead thing is `InProcessBackend` in
`src/utils/swarm/backends/` — a different layer with a confusingly similar name.
So the in-process HIGH stands on reachability.

Two claims collapse. `resolveSystemSubagentName`'s "permanently-unreclaimable
`reserved` allocation" is unreachable: `AgentTool.call()` returns at
`AgentTool.tsx:655` (`a17e5e9`) whenever `teamName && name` are both set, and the
leaking branch requires exactly that pair. The "teammate prompt omits additional
working directories" claim is wrong: `runAgent` re-wraps the prompt through
`enhanceSystemPromptWithEnvDetails`, which does pass the leader's
`additionalWorkingDirectories` and does render them.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Spawn failure after launch leaves teammate running and unaddressable | CONFIRMED | Reproduced: launched=true, throw, status=terminated, `resolveTeamPrincipalByName` → null |
| F2 | HIGH | Initial task prompt best-effort, tool reports unconditional success | PARTIALLY CONFIRMED | Fully real on the one live call site; the second cited site is in dead code |
| F3 | HIGH | Team-file writes truncate in place; torn read reads as "team does not exist" | PARTIALLY CONFIRMED | Race proven (2.41% under a synthetic writer) but ~1.4µs/write; claimed Ctrl-C trigger is near-certain in the report, ~1e-5 in reality |
| F4 | HIGH | In-process teammate's system prompt built for the leader's model | PARTIALLY CONFIRMED | Path is live (default), but `runAgent` re-wraps with the teammate's model; only the inner body carries the leader's dialect |
| F5 | MED | Built-in and plugin agent types silently dropped for in-process teammates | CONFIRMED | `isCustomAgent` returns false for both sources; falls to `['*']` and no custom prompt |
| F6 | MED | Two divergent copies of the teammate command-line builder, "both live" | PARTIALLY CONFIRMED | Duplication and drift real; the `spawnUtils` copy is consumed only by dead code, and the missing flag is inert |
| F7 | MED | `handleSpawnSeparateWindow` / `use_splitpane` path unreachable | CONFIRMED | Sole caller hardcodes `use_splitpane: true`; `ensureSession`/`hasSession` have no other callers |
| F8 | MED | Entire `TeammateExecutor` layer unreferenced | CONFIRMED | No reference to `getTeammateExecutor` outside `registry.ts` itself, not even tests |
| F9 | MED | In-process AgentTool carve-out statically unreachable | PARTIALLY CONFIRMED | The `AGENT_TOOL_NAME` line is dead, but the "teammates cannot spawn teammates" guard is reachable for tmux teammates |
| F10 | MED | `resolveSystemSubagentName` can leak an unreclaimable `reserved` allocation | INVALID | The explicit-name+team branch is unreachable; the only caller returns first when both are set |
| F11 | MED | Failed permission-request delivery discarded, teammate then waits forever | CONFIRMED | `void`-discarded `Promise<boolean>`, unbounded poll; branch made it worse by adding a lock to the hot path |
| F12 | LOW | `readTeamSnapshot`'s "immutable snapshot" is only shallow-frozen | CONFIRMED | Proven: `snap.members.push(...)` succeeds on the returned value |
| F13 | LOW | `recoverStartingRecipient` has no production caller | CONFIRMED | Only tests and one comment; already recorded in `DONE.md` |
| F14 | LOW | Teammate system prompt omits additional working directories | INVALID | `runAgent` → `enhanceSystemPromptWithEnvDetails` → `computeEnvInfo` renders them |
| F15 | LOW | Identical race handled two different ways | PARTIALLY CONFIRMED | Divergence real, but the cited `:343-345` arm is the dead one; live comparison is `:352` vs `:378` |
| F16 | LOW | `in_process_teammate` names the task type for out-of-process teammates | CONFIRMED | Every sub-claim checks out, including the stale `getDisplayedMessages` comment |

## Per finding

### F1 — [HIGH] Spawn failure after launch tombstones the allocation but leaves the teammate running and unaddressable

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `spawnMultiAgent.ts:421` is `await
  sendCommandToPane(paneId, spawnCommand, !insideTmux)`; `:466` is the
  `starting -> active` `transitionTeamRecipient`; `:516-519` is `catch (error) {
  await tombstoneFailedRecipient(...); throw error }`. Same shape at `:910`
  (`startInProcessTeammate`), `:987`, `:1030-1033` for in-process, and `:637`/
  `:690`/`:740-743` for separate-window. `teammateMailbox.ts:426-428` is exactly
  `find(r => r.name === name && r.status !== 'terminated')`.
- **Reachable in production?**: Yes, on two of the three cited handlers.
  `handleSpawn` (`:1042-1080`) checks `isInProcessEnabled()` *first*, and
  `registry.ts:351-389` returns true for any non-interactive session, any
  `teammateMode: 'in-process'`, and `'auto'` outside tmux/iTerm2 — so
  `handleSpawnInProcess` is the default. Inside tmux/iTerm2 with `use_splitpane:
  true` hardcoded at the only caller, `handleSpawnSplitPane` runs. The
  separate-window handler is dead (see F7), so the report's three cited sites are
  really two.
- **Trigger**: Any throw from `transitionTeamRecipient` after the launch. Two are
  realistic: (a) `TeamFileLockError` — `TEAM_LOCK_RETRY_OPTIONS` at
  `teamHelpers.ts:293-298` is `{retries: 8, factor: 1.5, minTimeout: 10,
  maxTimeout: 100}`, a ~407ms budget, and `AgentTool.isConcurrencySafe()` returns
  true while `services/tools/toolOrchestration.ts:11` allows 10 concurrent tool
  calls, each spawn taking three team-file transactions; (b) `Team "X" does not
  exist` at `teamHelpers.ts:376-378` from a concurrent `TeamDelete` or
  `cleanupSessionTeams`' `rm -rf`.
- **Counter-arguments considered**:
  - *Does the survivor die on its own?* No. It is a full second `cat-code`
    process in a pane (or a detached in-process controller). There is **no
    reaper, TTL, heartbeat, or parent-death detection** anywhere: I grepped
    `recipientRecords` across `src/` (11 files, 5 of them tests) and the only
    lifecycle writers are `allocateTeamRecipient`, `transitionTeamRecipient`,
    `recoverStartingRecipient` (which has no caller, F13) and
    `tombstoneFailedRecipient`. A pane teammate never self-registers a
    `recipientRecord`: `teammateInit.ts:36` only *reads* the team file.
  - *Does the leader's own shutdown clean it up?* **No, and this makes it worse.**
    `cleanupSessionTeams` → `killOrphanedTeammatePanes` (`teamHelpers.ts:1129-1140`)
    filters `teamFile.members`, and the member row is written by the same
    `transitionTeamRecipient` call that just failed. So the pane survives the
    leader's SIGINT cleanup too, then `cleanupTeamDirectories` `rm -rf`s the team
    dir under it.
  - *Is it really unkillable?* Partly not — the report overstates here.
    `registerOutOfProcessTeammateTask` runs at `:452`, **before** the failing
    transition, and its abort listener at `:816-824` kills the pane; the
    in-process equivalent registers inside `spawnInProcessTeammate`
    (`spawnInProcess.ts:113-180`). So the operator can still kill the survivor
    from the background-tasks dialog via `killInProcessTeammate`. What is lost is
    the *hardened control path*: `SendMessage`, `writeControlRequestToMailbox`
    shutdown, and `sendPermissionResponseViaMailbox` (`permissionSync.ts:752-758`)
    all resolve by name and all now return null/refuse.
  - *Does the tombstone always land?* No. On the lock-contention path the
    tombstone takes the same lock. If contention has cleared it commits and the
    record becomes `terminated` (unaddressable). If it has not, the record stays
    `starting`, and `resolveTeamPrincipalByName` **does** resolve `starting`
    records — so the survivor is still addressable, just missing from `members`.
    The catastrophic outcome therefore needs transient, not sustained, contention.
    I proved the transient case below.
- **True consequence**: A live teammate process with no member row and (usually) a
  `terminated` recipient record. It cannot be messaged, shut down, or have its
  permission requests answered through the version-2 control path. It can still be
  killed from the tasks dialog. For pane backends it also outlives the leader's own
  cleanup.
- **Evidence**: Scratch test
  `/private/tmp/claude-501/-Users-pt-cat-code/cdbe5dee-58e0-41f0-8421-b6cd23d30457/scratchpad/v23/f33b.test.ts`,
  run with `bun test <that path>` from the repo root. It mocks only
  `isInProcessEnabled`, `spawnInProcessTeammate`, and `startInProcessTeammate`
  (recording that the launch happened), points `CLAUDE_CONFIG_DIR` at a temp dir,
  and drives the real `spawnTeammate`:

  ```
  [A] launched=true threw=TeamFileLockError status=terminated members=[] resolve=null
  [B] launched=true threw=TeamFileLockError msg=Failed to lock team file for "tb":
      ENOENT: no such file or directory, mkdir '…/teams/tb/config.json.lock'
  2 pass, 0 fail
  ```

  Mode A holds the `config.json.lock` directory from the instant of launch until
  450ms (just past the retry budget), then releases so the compensating tombstone
  can commit. Mode B removes the team directory at launch.
  `resolveTeamPrincipalByName(snapshot, 'researcher')` returns `null` in mode A.
  The existing repo test `spawnMultiAgent.test.ts:110-145` only covers failure
  *before* the launch (`spawnInProcessTeammate` returning `success: false`), so
  this window has no coverage.
- **Branch-new or pre-existing?**: The *ordering* pre-exists —
  `git show main:src/tools/shared/spawnMultiAgent.ts` has the same
  `readTeamFileAsync` + `Team "X" does not exist` throw after `sendCommandToPane`.
  What the branch adds is (a) a lock-contention failure mode that did not exist
  (there was no team lock on `main`), and (b) the tombstone plus
  `resolveTeamPrincipalByName`, which turn "no member row" into "no routable
  identity". `recipientRecords`, `transactTeamFile`, and
  `resolveTeamPrincipalByName` are all absent from `main`. The branch made the
  consequence strictly worse.
- **Disposition**: Apply the report's second option, not its first. Moving the
  launch to be the last step is not actually available: the pane must exist before
  `sendCommandToPane`, and `startInProcessTeammate` needs the task/context that
  `spawnInProcessTeammate` created. Do the compensating version: hoist
  `paneId`/`backendType` (pane) and `result.abortController`/`result.taskId`
  (in-process) into the enclosing scope, and in the `catch` kill the pane / abort
  the controller **before** `tombstoneFailedRecipient`. Cheaper and independently
  worth doing: promote to `active` *before* launching, and tombstone on launch
  failure — the record is already `starting`, so the window shrinks to a single
  transaction. Do **not** simply retry the transition: `transitionTeamRecipient`
  fails closed on `from`-state mismatch and a retry after a partial commit would
  throw `RecipientTransitionError`.

### F2 — [HIGH] The teammate's initial task prompt is delivered best-effort, but the tool reports unconditional success

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes at both cited lines, but one is dead.
  `spawnMultiAgent.ts:490-498` is the positional `writeToMailbox(sanitizedName,
  {...}, teamName)` in `handleSpawnSplitPane` (live). `:714-722` is the identical
  call in `handleSpawnSeparateWindow`, which F7 correctly proves unreachable.
  `teammateMailbox.ts:1053-1064` is the overload dispatcher: a `string` first
  argument routes to `legacyWriteToMailbox`. `legacyWriteToMailbox`
  (`:260-318`) returns on inbox-create failure at `:278-286` and swallows
  lock/read/write failure at `:310-312`; its doc comment at `:251-258` says
  verbatim that new call sites should use the object overload "which throws
  `MailboxWriteError` so callers can report truthful delivery failure". The result
  text is at `AgentTool.tsx:2074-2078` (`a17e5e9`), inside the
  `status === 'teammate_spawned'` branch, with no conditional on delivery.
- **Reachable in production?**: Yes for `:490`. Reached whenever
  `isInProcessEnabled()` is false, i.e. the leader is running inside tmux or
  iTerm2, or has `teammateMode: 'tmux'`. Note the in-process handler deliberately
  does *not* use the mailbox (`spawnMultiAgent.ts:1009-1012`) because the prompt
  is handed directly to `startInProcessTeammate`, so this finding is scoped to
  pane teammates only — the report does not say this.
- **Trigger**: Any `EACCES`/`ENOSPC`/`EROFS` creating or writing
  `~/.cat-code/teams/<team>/inbox/<name>.json`, or `LOCK_OPTIONS` retry
  exhaustion on that inbox during a fan-out. The teammate boots, polls an empty
  inbox, and does nothing; the model is told "Spawned successfully… The agent is
  now running and will receive instructions via mailbox."
- **Counter-arguments considered**: I checked whether anything downstream
  re-delivers or notices. It does not — there is no pending-control record for a
  plain chat write (the `pendingControls` machinery at `teammateMailbox.ts:916-986`
  covers *control* requests only), no ack, and no retry. I also checked whether the
  leader would notice the silence: it would not, because the teammate's idle
  notification is itself a structured message and (per my extra finding M1 below)
  can be dropped. The one genuine mitigation is that `legacyWriteToMailbox` calls
  `logError(error)`, so the failure lands in the debug log — invisible to the model
  and to the operator in normal use.
- **True consequence**: On the pane path only, a spawn can report success while
  the teammate has no task at all. The leader then blocks waiting on a teammate
  that will never speak.
- **Evidence**: `src/tools/shared/spawnMultiAgent.ts:490-498`;
  `src/utils/teammateMailbox.ts:251-318`, `:1053-1064`;
  `git show a17e5e9:src/tools/AgentTool/AgentTool.tsx | sed -n '2070,2078p'`.
  Pre-existing: `git show main:src/tools/shared/spawnMultiAgent.ts` has the same
  positional call.
- **Disposition**: The report's fix is right and small. Switch `:490` to the
  principal overload using the snapshot the `active` transition already produced,
  and let `MailboxWriteError` land in the existing `catch` at `:516`. Do **not**
  also convert `:714` — delete that handler instead (F7). One caution the report
  misses: with F1 unfixed, converting `:490` to a throwing write *adds* a
  post-launch fallible step, so land F1's compensation first or land both together.

### F3 — [HIGH] Team-file writes truncate in place while readers take no lock, so a torn read reads as "team does not exist"

- **Verdict**: PARTIALLY CONFIRMED (mechanism real and proven; claimed trigger
  probability is wrong by orders of magnitude)
- **Cited location holds?**: Yes. `teamHelpers.ts:241-248` `writeTeamFileAsync`
  ends in `await writeFile(path, jsonStringify(...))` (flag `'w'`, i.e.
  `O_TRUNC|O_CREAT`). `:197-208` `readTeamFile` is `readFileSync` + `jsonParse`
  with `catch → null` for anything that is not `ENOENT`. `:213-226`
  `readTeamFileAsync` is the same, unlocked. The unlocked-reader list is accurate
  and I found two more the report omitted: `SendMessageTool.ts:628` and
  `permissionSync.ts:660`.
- **Reconciling this with the report's praise of `transactTeamFile`**: there is no
  contradiction, and the two are the **same** path, not two writers.
  `transactTeamFile` (`:359-396`) is the only version-2 writer and it calls
  `writeTeamFileAsync` at `:381` *inside* the lock. The lock makes it correct
  writer-vs-writer, which is what the praise is about. It says nothing about
  writer-vs-*unlocked-reader*, which is what this finding is about. Both
  statements are true simultaneously.
- **Reachable in production?**: Yes. `setMemberActive` (`:992-1016`) goes through
  `transactTeamFile` and fires on teammate turn boundaries; `killOrphanedTeammatePanes`
  (`:1129-1131`) and `cleanupTeamDirectories` (`:1176`) are unlocked `readTeamFile`
  callers reached from `cleanupSessionTeams`, registered as a shutdown cleanup at
  `src/entrypoints/init.ts:189-194`.
- **Trigger / measured window**: I reproduced the race with two separate `bun`
  processes against a 4.6KB file shaped like a real v2 team file
  (`scratchpad/v23/torn2.ts`):

  ```
  writer: 70141 writes in 4s
  reader: {"reads":134725,"fail":3250,"empty":0,"pct":"2.4123%"}
  ```

  So the torn window is real, and it is **partial content, never an empty file**
  (`empty: 0`) — Node issues the `write()` immediately after the truncating
  `open()`. Working back: 2.41% of 4s across 70,141 writes is ≈**1.4µs of torn
  window per write**. A single-process variant (`torn.ts`) gave 79 failures in
  170,744 reads over 3,416 writes, consistent.
- **Counter-arguments considered**: I specifically tried to make the report's
  stated scenario likely and could not. `setMemberActive` fires on turn
  boundaries — call it 1–10 writes/second for a busy team, not 17,500. At 10
  writes/s the chance that `killOrphanedTeammatePanes`' *single* `readTeamFile`
  lands inside a 1.4µs window is ~1.4e-5. The report presents it as a
  press-Ctrl-C-and-watch-it-happen outcome ("Result is exactly the
  orphaned-teammate-processes case"); it is a one-in-tens-of-thousands race. I also
  checked whether `transactTeamFile` widens the window by holding the lock across
  the write — it does, but that only serialises writers, and unlocked readers do
  not consult the lock at all.
- **True consequence**: A rare, silent misread of the team file as "no such team".
  In the worst landing spot it skips a pane kill that the code then follows with
  `rm -rf` of the team dir. Real, but a tail risk, not the expected behaviour.
- **What the report missed, and it is the stronger half**: the same
  truncate-then-write leaves a **permanently** empty `config.json` if the process
  dies between the `open(O_TRUNC)` and the `write()` — SIGKILL, OOM, power loss.
  That is not a microsecond race, it is durable corruption of the team's only
  state file, and it fails exactly the same way (`jsonParse` throws → `null` →
  "team does not exist"). This is the argument that actually justifies the fix.
- **Evidence**: `scratchpad/v23/torn.ts`, `scratchpad/v23/torn2.ts` and the output
  above; `src/utils/swarm/teamHelpers.ts:197-208`, `:213-226`, `:241-248`,
  `:359-396`, `:992-1016`, `:1129-1140`, `:1172-1200`.
- **Branch-new or pre-existing?**: Pre-existing. `writeTeamFileAsync`,
  `readTeamFile`, `setMemberActive` and `killOrphanedTeammatePanes` all exist on
  `main` (`main:175`, `main:454`, `main:598`). The branch increased write
  *frequency* by routing every mutation through `transactTeamFile`, but did not
  introduce the mechanism.
- **Disposition**: Apply the report's fix — write to `${path}.tmp` then `rename()`
  — but sell it on durability, not on the race. `rename(2)` is atomic on APFS and
  ext4, which closes both the torn read and the crash-leaves-empty-file hazard at
  once. Keep the lock: `rename` makes readers safe, it does **not** make
  read-modify-write safe, and `transactTeamFile`'s lock is still what prevents
  lost updates. Do not "therefore drop the lock", which the report's phrasing
  ("readers then never observe a partial file and need no lock") could be misread
  as licensing for writers too. Severity: downgrade to MED on the race alone; keep
  HIGH if the crash-durability framing is adopted.

### F4 — [HIGH] In-process teammate's system prompt is built for the leader's model and provider, not its own

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes. `inProcessRunner.ts:1126-1131` is
  `deps.getSystemPrompt(tools, toolUseContext.options.mainLoopModel, undefined,
  toolUseContext.options.mcpClients)`. `constants/prompts.ts:728-729` is
  `const requestProvider = resolveRequestProvider(model)` / `const gpt =
  isGPTPromptStyle(requestProvider)`, and `gpt` selects
  `getGPTActionsSection()` vs `getActionsSection()` and siblings. The teammate's
  own model is in scope: `inProcessRunner.ts:1263-1264` computes
  `teammateProvider = getProviderForModel(model) ?? …mainLoopProvider`, and
  `:1476` passes `model: model as ModelAlias | undefined` to `runAgent`. `:1352`
  is `getAutoCompactThreshold(toolUseContext.options.mainLoopModel)`.
- **Settling the dead-code contradiction (the audit's most important question)**:
  the in-process path is **not** dead, and the report's own dead-code findings do
  not touch it. Three distinct things share the name:
  1. `handleSpawnInProcess` in `src/tools/shared/spawnMultiAgent.ts` → **LIVE, and
     the default.** `handleSpawn:1047` returns it whenever `isInProcessEnabled()`,
     which `backends/registry.ts:351-389` makes true for any non-interactive
     session, any explicit `in-process` mode, and `'auto'` outside tmux/iTerm2.
     This is checked *before* `use_splitpane` is even read.
  2. `InProcessBackend` / `PaneBackendExecutor` / `getTeammateExecutor` in
     `src/utils/swarm/backends/` → **DEAD** (F8). This is the layer the report
     calls unreachable, and it is a different code path entirely.
  3. `handleSpawnSeparateWindow` → **DEAD** (F7), also unrelated.

  `handleSpawnInProcess` → `startInProcessTeammate` → `runInProcessTeammate`
  (`inProcessRunner.ts:1202`) → `resolveInProcessRuntime` (`:1241`). So the HIGH
  is reachable. The audit's "if the in-process path is dead, this HIGH is INVALID"
  premise does not fire.
- **Trigger**: Leader on a `claude-*` model, `Agent(name: "w", model:
  "gpt-5.6-terra", team_name: "t")` with in-process backend.
  `resolveTeammateModel` (`spawnMultiAgent.ts:92-100`) returns the caller's model
  verbatim, `runAgent` sends to the Codex path per the model-string rule, and the
  prompt body was rendered in Claude style.
- **Counter-arguments considered — and this is where the report overreaches**:
  `runAgent` does **not** use the pre-built prompt verbatim. `runAgent.ts:592-600`
  calls `getAgentSystemPrompt`, which at `:1031` invokes
  `agentDefinition.getSystemPrompt()` (our closure returning the leader-model
  body) and then at `:1053-1062` wraps it in
  `enhanceSystemPromptWithEnvDetails(prompts, resolvedAgentModel,
  additionalWorkingDirectories, enabledToolNames,
  resolveRequestProvider(resolvedAgentModel, …))`. `resolvedAgentModel` is the
  **teammate's**. So the outer notes block, the colon-note dialect switch
  (`prompts.ts:1122-1124`), and the env block are all rendered correctly for the
  teammate. Only the inner `getSystemPrompt(...)` body — core policy, actions
  section, system-reminders, function-result-clearing — carries the leader's
  dialect. The report's flat "built for the leader's model and provider" is too
  strong.
- **True consequence**: A hybrid prompt. The teammate gets Claude-style core
  sections while its requests route to Codex, and — a concrete symptom the report
  did not surface — **two contradictory environment blocks**: one from
  `computeSimpleEnvInfo(mainLoopModel)` inside `getSystemPrompt` and one from
  `computeEnvInfo(resolvedAgentModel)` from the wrap, so the teammate is told
  "You are powered by the model …" twice, with two different models. The
  compaction-threshold half at `:1352` is real and untouched by the branch.
- **Evidence**: `src/utils/swarm/inProcessRunner.ts:1126-1131`, `:1263-1264`,
  `:1352`, `:1436-1481`; `src/tools/AgentTool/runAgent.ts:585-600`, `:1015-1062`;
  `src/constants/prompts.ts:719`, `:728-729`, `:946-989`, `:1114-1149`.
- **Branch-new or pre-existing?**: Pre-existing.
  `git show main:src/utils/swarm/inProcessRunner.ts` has the identical
  `getSystemPrompt(toolUseContext.options.tools,
  toolUseContext.options.mainLoopModel, undefined, …)` at `main:1007-1012`.
  `git blame -L 1126,1131 HEAD` attributes the current lines to `18090c3c`
  (the branch's hardening commit) only because the call was *moved* into
  `resolveInProcessRuntime`; `:1352` still blames to the `86051a8` root commit.
  The report is right that the extraction fixed the `tools` argument and left the
  `model` argument.
- **Disposition**: Pass `model` at `:1128`. Do **not** blindly also change `:1352`
  as the report proposes without checking `getAutoCompactThreshold`'s alias
  handling — `model` here can be an alias (`'sonnet'`, `'opus'`) while
  `mainLoopModel` is a full model id, and a threshold lookup that does not
  normalise aliases would silently return a default. Verify that first. Separately,
  fix the double env block by having `resolveInProcessRuntime` build the body and
  letting only `runAgent`'s wrap emit env info, or vice versa; shipping two
  "You are powered by" lines is its own defect.

### F5 — [MED] Built-in and plugin agent types are silently dropped for in-process teammates

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `spawnMultiAgent.ts:874-885` is
  `if (foundAgent && isCustomAgent(foundAgent)) { agentDefinition = foundAgent }`.
  `loadAgentsDir.ts:174-178` is `isCustomAgent = agent.source !== 'built-in' &&
  agent.source !== 'plugin'`. `inProcessRunner.ts:1095-1108` falls to
  `agentToolNames = ['*']` when `agentDefinition?.tools` is undefined, and
  `:1138-1160` appends the custom-instructions block only when `agentDefinition`
  is set.
- **Reachable in production?**: Yes, via the default in-process path (see F4).
- **Trigger**: `Agent(name: "scout", subagent_type: "Explore", team_name: "t")`
  with the in-process backend.
- **Counter-arguments considered**: I checked whether the definition is recovered
  further down. It is not: `resolvedAgentDefinition` (`inProcessRunner.ts:1251-1261`)
  is synthesised with `agentType: identity.agentName` and
  `source: 'projectSettings'`, so `isBuiltInAgent()` is false in `runAgent` too and
  even the agent-mode prompt injections (`runAgent.ts:1043-1045`) are skipped. I
  also confirmed the model *is* honoured — `AgentTool.tsx:682`/`:687` (`a17e5e9`)
  reads `agentDef?.model` from the same `activeAgents` lookup and passes it as
  `model: model ?? agentDef?.model` — so the divergence the report describes
  (model honoured, prompt and tools not) is exactly right. The pane handlers do
  pass `--agent-type` (`spawnMultiAgent.ts:388`, `:605`), so the child process
  reloads the built-in definition correctly; the backend divergence claim holds.
- **True consequence**: An in-process teammate labelled `Explore` with none of
  Explore's system prompt, none of its tool restrictions, and `['*']` tools at
  `permissionMode: 'default'`.
- **Evidence**: the lines above; `git show main:src/tools/shared/spawnMultiAgent.ts`
  has the same `isCustomAgent` gate at `main:881`, so this is pre-existing.
- **Disposition**: The report's fix is correct and I would apply it as written —
  widen the gate to any `AgentDefinition`. One addition it omits: also stop
  synthesising `source: 'projectSettings'` at `inProcessRunner.ts:1256` when a
  real definition exists, or `isBuiltInAgent` stays false downstream and the
  prompt injections remain skipped even after the gate is widened.

### F6 — [MED] Two divergent copies of the teammate command-line builder, both live

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes. `spawnMultiAgent.ts:198-265` and
  `spawnUtils.ts:23-133` define same-named `getTeammateCommand` and
  `buildInheritedCliFlags` with near-identical bodies. The drift is exactly as
  described: `spawnUtils.ts:78-80` pushes `--teammate-mode ${sessionMode}` and has
  no `'auto'` branch; `spawnMultiAgent.ts:231-236` has the `'auto'` branch and
  never pushes `--teammate-mode`. `--teammate-mode` is a real option at
  `src/main.tsx:4046`.
- **Reachable in production?**: **Only one copy is.** This is where the finding
  breaks. `rg` for both symbols shows the `spawnUtils.ts` exports are imported by
  exactly one file: `backends/PaneBackendExecutor.ts:14,16` — which F8 (the
  report's own finding, which I confirmed) proves is unreachable. So "both live" is
  false; the `spawnMultiAgent.ts` copy is the only one that ever runs.
- **Counter-arguments considered**: I then tested whether the missing
  `--teammate-mode` matters at all on the live copy. It largely does not. A pane
  teammate is launched *inside* a tmux or iTerm2 pane, so when it reads its own
  mode it gets `'auto'`, and `isInProcessEnabled()` (`registry.ts:378-382`)
  resolves `'auto'` to pane because `isInsideTmuxSync()` or `isInITerm2()` is
  true — the same backend the leader chose. `--teammate-mode in-process` never
  reaches this code at all, because `handleSpawn:1047` short-circuits to
  `handleSpawnInProcess` before any CLI is built. The report's stated consequence
  ("those teammates boot in `auto` and re-run backend detection instead of
  inheriting the operator's explicit choice") is literally true but lands on the
  same answer.
- **True consequence**: Real duplication and real drift, but no observed
  behavioural divergence, because the divergent copy is dead. The concrete cost is
  the one the report lists second: a reader who opens `spawnUtils.ts` learns the
  wrong thing about what a teammate inherits.
- **Evidence**: `rg -n "getTeammateCommand|buildInheritedCliFlags" src/`;
  `src/utils/swarm/spawnUtils.ts:23-133`; `src/tools/shared/spawnMultiAgent.ts:198-265`;
  `src/main.tsx:4046`. Pre-existing: both copies are on `main`
  (`main:src/tools/shared/spawnMultiAgent.ts:193,208`).
- **Disposition**: Invert the report's fix. Do **not** "delete the
  `spawnMultiAgent.ts` copies and import from `spawnUtils.ts`" — that would
  promote the dead, drifted copy into the live path and start pushing
  `--teammate-mode` for the first time, which is an untested behaviour change.
  Delete `spawnUtils.ts`'s `getTeammateCommand`/`buildInheritedCliFlags` along
  with `PaneBackendExecutor` (F8), keep the live copy, and only then decide
  separately whether `--teammate-mode` propagation is wanted. Severity: downgrade
  to LOW; it is a readability hazard, not a behaviour bug.

### F7 — [MED] `handleSpawnSeparateWindow` and the whole `use_splitpane` path are unreachable

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `spawnMultiAgent.ts:526-744` is the handler,
  `:164-191` are `hasSession`/`ensureSession`, `:126`/`:148` are the
  `use_splitpane?: boolean` fields, `:1075-1079` is
  `const useSplitPane = input.use_splitpane !== false`.
- **Reachable in production?**: No. `rg -n "spawnTeammate|use_splitpane" src/`
  gives exactly one non-test caller, `AgentTool.tsx:675-680` (`a17e5e9`), which
  hardcodes `use_splitpane: true`. `rg -n "ensureSession|hasSession" src/` shows
  `spawnMultiAgent.ts:568` (inside the dead handler) as the only call site of
  `ensureSession`, and `:177` as the only call site of `hasSession`.
- **Counter-arguments considered**: I checked for a second entry point —
  `TeammateTool` — and it does not exist: `src/tools/` contains only
  `TeamCreateTool` and `TeamDeleteTool`, and the only surviving `TeammateTool`
  references are the stale comments the report names (`spawnMultiAgent.ts:3`,
  `:142`, `:1088`) plus unrelated `[TeammateTool]` log prefixes in
  `teamHelpers.ts`. I also checked the SDK/print entrypoints for a `use_splitpane`
  consumer; none.
- **True consequence**: ~220 lines of unreachable code that received the full
  `transitionTeamRecipient` + try/catch treatment on this branch, doubling the
  diff a reader must read to answer "what changed in spawn?".
- **Evidence**: the greps above; `sed -n '1,4p;1086,1089p'
  src/tools/shared/spawnMultiAgent.ts`. Pre-existing:
  `git show main:src/tools/AgentTool/AgentTool.tsx | grep -n "use_splitpane: true"`
  → `main:588`.
- **Disposition**: The report's fix is correct. Delete `handleSpawnSeparateWindow`,
  `hasSession`, `ensureSession`, the two `use_splitpane` fields and the branch at
  `:1075-1079`, and fix the three stale `TeammateTool` comments (`:3`, `:142`,
  `:1088` — the report names two). Do this **before** F2's mailbox fix so the
  second call site does not need converting.

### F8 — [MED] The entire `TeammateExecutor` layer is unreferenced, including this branch's shutdown-authority hardening

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `backends/registry.ts:404-409`
  (`getInProcessBackend`), `:425-436` (`getTeammateExecutor`), `:442-446`
  (`getPaneBackendExecutor`).
- **Reachable in production?**: No. `rg -n
  "getTeammateExecutor|getInProcessBackend|getPaneBackendExecutor|new
  PaneBackendExecutor|new InProcessBackend|createInProcessBackend|createPaneBackendExecutor|TeammateExecutor"
  src/` returns hits only inside `backends/registry.ts`,
  `backends/InProcessBackend.ts`, `backends/PaneBackendExecutor.ts`, and the
  `TeammateExecutor` type in `backends/types.ts:276-279`. `getTeammateExecutor`
  has zero external callers and no test references; `getInProcessBackend` and
  `getPaneBackendExecutor` are called only by `getTeammateExecutor`.
- **Counter-arguments considered**: I checked that the report's claimed *live*
  paths really are the live ones. They are: the live spawn path is
  `spawnMultiAgent`'s handlers (F4's trace); the live kill path is
  `killInProcessTeammate` reached from `InProcessTeammateTask.tsx:28`; the live
  shutdown path is the `SendMessage` `shutdown_request` documented at
  `TeamCreateTool/prompt.ts:45`. I also checked whether `isInProcessEnabled` being
  imported by `PromptInput.tsx` and `useSwarmBanner.ts` drags the executors in —
  it does not; those import from `registry.ts` but call only
  `isInProcessEnabled`.
- **True consequence**: The branch rewrote `terminate()` in both executors to use
  `readTeamSnapshot` + `resolveTeamPrincipalByName` + `writeControlRequestToMailbox`
  (`InProcessBackend.ts:241`, `PaneBackendExecutor.ts:275`). That work is correct
  and cannot run. The report's framing of the cost is right and worth repeating:
  an auditor asking "is shutdown authority-checked?" finds a hardened
  implementation and stops looking.
- **Evidence**: the `rg` above. Pre-existing:
  `git show main:src/utils/swarm/backends/registry.ts | grep -n getTeammateExecutor`
  → `main:425`; the layer was already orphaned on `main`, the branch only hardened it.
- **Disposition**: Delete the layer. The report's alternative ("or wire
  `spawnMultiAgent`/`InProcessTeammateTask` through it") is the wrong call here:
  it is a large behavioural change to the one code path this review just found a
  HIGH ordering bug in, and it would be done to satisfy an abstraction nothing
  asked for. Deleting also removes the F6 duplicate builders for free.

### F9 — [MED] The in-process-teammate carve-out for the Agent tool is statically unreachable

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes. `agentToolUtils.ts:135-137` is
  `if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false`, well before the
  `environment === 'in-process-teammate'` branch at `:162-172`.
  `constants/tools.ts:48-65` builds `ALL_AGENT_DISALLOWED_TOOLS` with
  `...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME])` and the same for
  `RESUME_AGENT_TOOL_NAME`. `scripts/build.ts:132-134` is
  `'process.env.USER_TYPE': JSON.stringify('external')`.
- **Reachable in production?**: The `AGENT_TOOL_NAME` line at `:166` is dead —
  confirmed, and I can now close the report's own uncertainty about `USER_TYPE`
  without running a build: the checked-in source of `AgentTool.tsx:2075` already
  reads `if ("external" === 'ant' && …)`, i.e. the literal has been folded in at
  least one site in-tree, and `scripts/build.ts` is the single owner of the define
  for the rest. The `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` line at `:170` is
  reachable — I checked the set (`constants/tools.ts:157-168`: the four Task
  tools, `SendMessage`, plus cron tools under `feature('AGENT_TRIGGERS')`) and
  none of them are in `ALL_AGENT_DISALLOWED_TOOLS`.
- **Where it breaks**: the report says *both* downstream guards at
  `AgentTool.tsx:643-651` are unreachable "for the same reason". Only one is.
  `isTeammate()` (`utils/teammate.ts:125-131`) returns true for **tmux** teammates
  as well, via `dynamicTeamContext`. A tmux teammate is a full CLI session whose
  main-loop tool pool is not built by `filterToolsForAgent`, so it has the Agent
  tool and can reach `AgentTool.call()`. The guard at `:646-648` ("Teammates
  cannot spawn other teammates") is therefore live and load-bearing. Only
  `:650-651` (`isInProcessTeammate() && teamName && run_in_background === true`)
  is dead.
- **Counter-arguments considered**: I checked whether `toolMatchesName` vs
  `.has(tool.name)` could let `AGENT_TOOL_NAME` slip past the early return via its
  `LEGACY_AGENT_TOOL_NAME` alias. It cannot: `tool.name` is `AGENT_TOOL_NAME`
  (`AgentTool.tsx:605`) and the alias lives in `aliases`, so `.has(tool.name)`
  matches first.
- **True consequence**: One dead special case and one dead guard, not two. The
  report's derived claim that nested agent depth is "hard-bounded at 1 by tool
  availability" holds for in-process teammates and for subagents, but not for tmux
  teammates, which can spawn subagents of their own.
- **Evidence**: `src/tools/AgentTool/agentToolUtils.ts:122-176`;
  `src/constants/tools.ts:48-65`, `:157-168`; `scripts/build.ts:132-134`;
  `src/utils/teammate.ts:125-131`; `src/utils/teammateContext.ts:70-72`.
  Pre-existing: `git show main:src/tools/AgentTool/agentToolUtils.ts` has the same
  branch at `main:114-117` under the older `isInProcessTeammate()` gate.
- **Disposition**: Drop the `AGENT_TOOL_NAME` special case at `:166` and the dead
  `:650-651` guard. **Keep** the `:646-648` guard — the report would have you
  delete a live check. Do not take the report's alternative (moving
  `AGENT_TOOL_NAME` out of `ALL_AGENT_DISALLOWED_TOOLS`) without a separate
  decision: that is an authorization-boundary change, and the comment at
  `constants/tools.ts:51-53` says so explicitly.

### F10 — [MED] `resolveSystemSubagentName` can leak a permanently-unreclaimable `reserved` allocation

- **Verdict**: INVALID (unreachable)
- **Cited location holds?**: The code is as described. At `a17e5e9`,
  `AgentTool.tsx:325-352` is the explicit-name branch:
  `allocateTeamRecipient({..., kind: 'local', conflict: 'error'})` followed by
  `if (!tryReserveWorkerName(record.name)) throw new Error(...)` at `:343-345`,
  with no tombstone. `resolveSystemSubagentName` is awaited at `:965`, outside the
  `try` that opens at `:976`, and the compensating `catch` at `:1097` only covers
  work after it. Records are never deleted (`teamHelpers.ts:72-77` doc comment).
- **Reachable in production?**: **No.** The leaking branch requires
  `explicitName && teamName` both truthy. `resolveSystemSubagentName` is called
  from exactly one production site (`AgentTool.tsx:965`; `rg -n
  "resolveSystemSubagentName" src/` shows only that and
  `AgentTool.test.ts`), and it is passed `{ explicitName: name, teamName }`. But
  `AgentTool.call()` has already returned at `:655-712` for precisely the case
  `if (teamName && name)` — that branch runs the teammate spawn and either
  `return`s the result at `:706-711` or rethrows at `:695`. Execution reaching
  `:965` therefore guarantees `!(teamName && name)`, so `if (explicitName) { … if
  (teamName) {` can never both be true.
- **Trigger**: None constructible from production code. The branch is exercised
  only by `AgentTool.test.ts`.
- **Counter-arguments considered**: I looked for a second entry point that could
  reach it with both set — the SDK surface, `resumeAgent.ts`, `runAgent.ts`, and
  `agent-mode/` — and there is none; the symbol has exactly one non-test
  reference. I also checked whether `resolveTeamName` (`AgentTool.tsx:2223-2232`,
  `input.team_name || appState.teamContext?.teamName`) could produce a `teamName`
  *after* the `:655` guard, which would revive the branch. It cannot: `teamName`
  is computed once at `:643` and is the same binding both places. I also verified
  the report's supporting claim independently — `getReservedSubagentNames`
  (`:246-273`) really does not read `activeNames` from
  `src/agent-mode/workerNames.ts:26` — so the *premise* is sound even though the
  branch is dead.
- **True consequence**: None today. It is a latent hazard that becomes real the
  moment anyone adds a second caller, or relaxes the `:655` early return.
- **Evidence**: `git show a17e5e9:src/tools/AgentTool/AgentTool.tsx` lines
  `325-352`, `640-712`, `960-985`, `1090-1110`; `rg -n "resolveSystemSubagentName" src/`.
  Branch-new: `git show main:src/tools/AgentTool/AgentTool.tsx` has
  `resolveSystemSubagentName` at `main:289` with **no** `allocateTeamRecipient` or
  `tryReserveWorkerName` anywhere in the file, so the whole team-allocation body
  arrived with this branch.
- **Disposition**: No fix required, but the code should not be left as a trap.
  The cheapest honest change is to reorder within the branch — call
  `tryReserveWorkerName` *before* `allocateTeamRecipient` — which is one line, is
  correct if the branch ever becomes reachable, and costs nothing. Do **not**
  implement the report's second option (wrapping allocate-and-reserve in a
  compensating try) for dead code; that is more machinery than the situation
  warrants. Downgrade to LOW.

### F11 — [MED] A failed permission-request delivery is discarded and the teammate then waits forever

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `inProcessRunner.ts:401` is
  `void sendPermissionRequestViaMailbox(request)`; `:404-451` is the
  `setInterval` poll at `PERMISSION_POLL_INTERVAL_MS` (`:129` — 500ms) with no
  deadline; the only exits are a matching response (`:440`) or the abort listener
  at `:453-459`. `swarmWorkerHandler.ts:123` is the same `void` call.
  `permissionSync.ts:679-722` returns `false` from a `catch` wrapping
  `readTeamSnapshot`, message construction, and `writeControlRequestToMailbox`.
- **Reachable in production?**: Yes — this is the hot path for every
  permission-gated tool call made by any teammate.
- **Trigger**: `readTeamSnapshot` (`teamHelpers.ts:328-348`) takes the team lock
  and throws `TeamFileLockError` on retry exhaustion (~407ms budget). With several
  teammates hitting permission prompts while spawns are also transacting the team
  file, the request vanishes and the teammate polls forever.
- **Counter-arguments considered**:
  - *Is leader-principal resolution really a failure mode?* No — the report
    overstates one of its three. `sendPermissionRequestViaMailbox` uses
    `resolveLeaderPrincipal`, not `resolveTeamPrincipalByName`, and
    `teammateMailbox.ts:399-411` falls back to a synthetic
    `TEAM_LEAD_NAME`/`leadAgentId` principal, so it effectively cannot return
    null. The real failure modes are the snapshot lock and the control write.
  - *Is "forever" fair?* Mostly. The `abortController` passed into
    `createInProcessCanUseTool` (`inProcessRunner.ts:1444`) is the **per-turn**
    `currentWorkAbortController`, so Escape on that teammate's turn does resolve
    it, and killing the task does too. So an attentive operator has an out. But
    nothing self-heals and nothing is surfaced: the report's "with no message
    anywhere the operator can see" is accurate.
  - *Is there a retry sweeper?* No. `writeControlRequestToMailbox` creates the
    `sending -> written` pending-control record (`teammateMailbox.ts:916-932`)
    *inside* the same call that failed, so when it fails there is no record for
    anything to retry from.
- **True consequence**: The teammate blocks on one tool call indefinitely,
  burning a mailbox read every 500ms, with no operator-visible signal. Recovery
  requires manual Escape or a task kill.
- **Evidence**: the lines above.
  **This one is branch-aggravated and the report is right to call it out:**
  `git show main:src/utils/swarm/permissionSync.ts:676-686` shows the old
  implementation resolved the leader through `getLeaderName` →
  `readTeamFileAsync`, an **unlocked** read that cannot fail on contention. The
  branch replaced it with the lock-taking `readTeamSnapshot`, putting a
  contended lock on a hot path that previously had none. The `void` discard and
  the unbounded poll are pre-existing (`main:393`, `main:123`).
- **Disposition**: Split the report's fix and do the second half first. The
  bounded deadline on the poll is the safe, self-contained change and it fixes the
  hang regardless of cause; do that. Awaiting the boolean and resolving
  `{behavior: 'ask'}` on `false` is also right, but note it changes a
  fire-and-forget into an await *before* the interval is armed — keep the
  callback registration and the poll arming where they are and await the result
  afterwards, or a fast leader response can race the registration. Additionally
  worth considering: revert `sendPermissionRequestViaMailbox` to a non-locking
  read of the leader principal, since it only needs the leader's identity and
  `resolveLeaderPrincipal` has a synthetic fallback anyway.

### F12 — [LOW] `readTeamSnapshot`'s "detached, immutable snapshot" is only shallow-frozen

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `teamHelpers.ts:344` is
  `return Object.freeze(structuredClone(teamFile))`, and the doc comment at
  `:322-327` sells it as "a detached, immutable snapshot".
- **Reachable in production?**: The value is returned to every
  `readTeamSnapshot` caller. No caller mutates today — I checked
  `SendMessageTool.ts:847,934`, `TeamsDialog.tsx:659,722`,
  `permissionSync.ts:752,899`, `useInboxPoller.ts`, `inProcessRunner.ts:859,898`.
- **Trigger**: Any future caller writing `snapshot.members.push(...)` or
  `snapshot.recipientRecords[0].status = …`. Both compile (TypeScript's
  `Readonly<T>` is shallow) and both succeed at runtime.
- **Counter-arguments considered**: I checked whether `structuredClone` itself
  confers any protection (it does not — it produces plain mutable objects) and
  whether the module is compiled under `"use strict"` in a way that would at
  least throw on the top-level assignment. The top-level assignment does throw in
  strict mode, but that is the only case `Object.freeze` covers.
- **True consequence**: A documentation/type promise the code does not keep.
  Latent only.
- **Evidence**: `scratchpad/v23/freeze.ts`:

  ```
  top-level assign throws: Attempted to assign to readonly property.
  after mutation: {"members":[{"name":"a"},{"name":"injected"}],
                   "recipientRecords":[{"name":"r","status":"terminated"}], …}
  Object.isFrozen(snap)=true  Object.isFrozen(snap.members)=false
  ```
- **Disposition**: Freeze the three arrays and their elements at `:344`. Prefer
  that over the report's `DeepReadonly<TeamFile>` alternative: a deep-readonly type
  would ripple through every consumer's local variables for a guarantee the
  runtime freeze already gives, and this file is the only producer.

### F13 — [LOW] `recoverStartingRecipient` has no production caller

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, `teamHelpers.ts:578-621`.
- **Reachable in production?**: No. `rg -n "recoverStartingRecipient" src/ docs/`
  returns the definition, `teamHelpers.test.ts:9,293,320,333,358`, a comment at
  `AgentTool.tsx:705` (`ad649cc`) that only mentions it does not handle
  `reserved`, two maps, and the original plan doc.
- **Trigger**: A leader SIGKILLed between the `reserved -> starting` transition
  and the `starting -> active` one leaves a `starting` record that nothing will
  ever resolve.
- **Counter-arguments considered**: I checked the two plausible wiring points —
  `useSwarmInitialization.ts` and `reconnection.ts` — and neither imports it. I
  also checked whether the F1 tombstone covers the same ground: it does not, since
  a SIGKILLed process runs no `catch`.
- **True consequence**: Inert crash-recovery machinery, as the report says. Note
  this really is a re-confirmation, not a discovery: `DONE.md:25` already records
  "`recoverStartingRecipient` has no production caller yet" as a known deferred
  gap, and `docs/reports/2026-07-13-agent-routing-hardening-review.md:34` states
  it too.
- **Evidence**: the `rg` above; `DONE.md:25`.
- **Disposition**: Wire it, do not delete it — deleting removes the only code that
  distinguishes a dead launcher from a live one and correctly refuses to guess
  (`manual_cleanup_required`). Call it from team reconnection for records whose
  `launcherInstanceId !== PROCESS_INSTANCE_ID`, as the report suggests. Low
  priority relative to F1, which produces the same orphan class far more often.

### F14 — [LOW] Teammate system prompt omits additional working directories

- **Verdict**: INVALID
- **Cited location holds?**: The cited line is accurate —
  `inProcessRunner.ts:1129` does pass `undefined` as the third argument to
  `getSystemPrompt`, so `computeSimpleEnvInfo` (`prompts.ts:719`, rendering at
  `:1024-1029`) emits no additional-working-directory block from *that* call.
- **Why the finding fails anyway**: the teammate's prompt does not end there.
  `runAgent.ts:592-600` builds `agentSystemPrompt` via `getAgentSystemPrompt`,
  which at `:1053-1062` calls
  `enhanceSystemPromptWithEnvDetails(prompts, resolvedAgentModel,
  additionalWorkingDirectories, …)`, where `additionalWorkingDirectories` is
  `Array.from(appState.toolPermissionContext.additionalWorkingDirectories.keys())`
  (`runAgent.ts:588-590`) — the leader's own set, since the in-process teammate is
  handed the leader's `toolUseContext`. `enhanceSystemPromptWithEnvDetails`
  (`prompts.ts:1114-1149`) calls `computeEnvInfo`, which at `prompts.ts:970-984`
  renders `Additional working directories: …` into the `<env>` block. And
  `override.systemPrompt` is *not* set for teammates — `inProcessRunner.ts:1473`
  passes only `override: { abortController: … }` — so this path definitely runs.
- **Counter-arguments considered**: I checked whether the teammate might get a
  different `appState` that lacks the directories. It does not:
  `handleSpawnInProcess` passes `toolUseContext: { ...context, messages: [] }`
  (`spawnMultiAgent.ts:929`), so `getAppState` is the leader's.
- **True consequence**: None as claimed. The teammate *is* told about the
  additional working directories. What is actually wrong here is the F4 problem
  in a different dress: the teammate receives **two** `<env>` blocks with
  different content and two different "You are powered by the model …" lines.
- **Evidence**: `src/utils/swarm/inProcessRunner.ts:1126-1131`, `:1466-1481`;
  `src/tools/AgentTool/runAgent.ts:585-600`, `:1015-1062`;
  `src/constants/prompts.ts:946-989`, `:1114-1149`.
- **Disposition**: No fix for the stated defect. Fold the real issue — the
  duplicated env block — into F4's remediation. If anything is changed at
  `:1129`, it should be to stop `resolveInProcessRuntime` emitting env info at
  all and let `runAgent`'s wrap be the single source, not to add a second copy of
  the directory list.

### F15 — [LOW] Identical race handled two different ways, one line apart in behavior

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: The lines say what the report says. At `a17e5e9`,
  `:343-345` throws on `!tryReserveWorkerName(record.name)`; `:378` calls
  `tryReserveWorkerName(record.name)` and discards the result; `:367` returns
  `{ agentName: agentId, processReservationName: agentId }` with no reservation at
  all; `:292-298` is the comment asserting `processReservationName` "was held in
  the process-local reservation set during async setup". Both paths reach
  `releaseWorkerName(processReservationName)` at `:1079`/`:1196`.
- **Where it breaks**: the report contrasts `:343-345` with `:378`, but
  `:343-345` sits inside the branch F10 proves unreachable. The live contrast is
  `:352` (explicit name, no team — throws) versus `:378` (pooled name, team —
  discards). That contrast is still a genuine divergence, so the finding's core
  survives; its cited evidence does not.
- **Counter-arguments considered**: I checked how likely `:378`'s discarded
  boolean is to be `false`. Much less than implied: `selectWorkerNameCandidate`
  → `getReservedNames` (`agent-mode/workerNames.ts:29-36`) folds `activeNames`
  into the exclusion set, so the candidate was already chosen to avoid
  process-local holders. Only a race across the `await allocateTeamRecipient` can
  make the later `tryReserveWorkerName` fail. I also checked whether the `:367`
  fallback's unreserved `releaseWorkerName(agentId)` can damage anything — it
  cannot, `agentId` is a freshly created unique id no other spawn can hold, so
  the delete is a no-op.
- **True consequence**: If `:378` loses the race, `releaseWorkerName` at `:1196`
  frees a name a concurrent spawn is still using, and a third spawn can then pick
  the same display name. Cosmetic collision in the roster, not a correctness
  failure. The comment at `:292-298` is false for the `:367` path.
- **Evidence**: `git show a17e5e9:src/tools/AgentTool/AgentTool.tsx` lines
  `292-298`, `340-382`, `1079`, `1196`; `src/agent-mode/workerNames.ts:26-36`.
  Branch-new (the whole team-allocation body is absent from `main`).
- **Disposition**: Make `:378` mirror `:352` — throw, or at minimum stop returning
  `record.name` as `processReservationName` when the claim failed, so `:1196`
  cannot release someone else's. Fix the `:292-298` comment or reserve on the
  `:367` path so it becomes true; reserving is one line and makes the invariant
  real, which is the better of the two. Ignore the `:343-345` half of the report's
  fix (dead code, see F10).

### F16 — [LOW] `in_process_teammate` names the task type for out-of-process teammates

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, and every sub-claim checks out.
  `spawnMultiAgent.ts:751-825` is `registerOutOfProcessTeammateTask`, which at
  `:777` calls `generateTaskId('in_process_teammate')`, at `:785` passes
  `'in_process_teammate'` to `createTaskStateBase`, and at `:789` sets
  `type: 'in_process_teammate'` — for tmux and iTerm2 pane teammates. The pane
  variant's state (`:782-808`) omits `messages`, `model`, `spinnerVerb` and
  `pastTenseVerb`, all of which `spawnInProcess.ts:157-180` sets; `messages` is
  optional in `InProcessTeammateTaskState` (`tasks/InProcessTeammateTask/types.ts:52`)
  so it compiles. `spawnInProcess.ts:179`'s comment "Initialize to empty array so
  `getDisplayedMessages` works immediately" cites a function that no longer
  exists — `rg -n "getDisplayedMessages" src/` returns only that comment. The
  downstream consumers the report names all discriminate on the type and cannot
  tell the two execution models apart (`utils/teammate.ts:208,223,246,277`,
  `pillLabel.ts:34`, `sessionStorage.ts:5141`, plus
  `useBackgroundTaskNavigation.ts:82`, `PromptInput.tsx:1443`,
  `PromptInputFooterLeftSide.tsx:323,341,371`,
  `collapseTeammateShutdowns.ts:9` — more than the report listed).
- **Reachable in production?**: Yes, whenever a pane teammate is spawned.
- **Trigger**: N/A — this is a naming/modelling defect, not a runtime failure.
- **Counter-arguments considered**: I checked whether the coincidence the report
  flags is actually load-bearing. It is: `killInProcessTeammate(taskId)`
  (`spawnInProcess.ts:227`) matches pane tasks because they share the
  discriminant, and it happens to do the right thing only because the abort
  listener at `spawnMultiAgent.ts:816-824` calls `killPane`. Remove or reorder
  that listener and pane kill silently becomes a no-op with no type error. I also
  checked whether the missing `messages` field can crash `appendTeammateMessage`
  (`InProcessTeammateTask.tsx`, `appendCappedMessage(task.messages, …)`) — pane
  teammates never route through `inProcessRunner`, so it is not reached today.
- **True consequence**: A discriminant that lies, plus a partially-populated state
  object, held together by an incidental abort listener.
- **Evidence**: the lines above. Pre-existing:
  `git show main:src/tools/shared/spawnMultiAgent.ts | grep -n
  registerOutOfProcessTeammateTask` → `main:475,689,760`.
- **Disposition**: The report's fix is right in shape but should be sequenced
  after F7. Once `handleSpawnSeparateWindow` is deleted there is one pane call
  site left, which makes adding `execution: 'in-process' | 'pane'` a small change.
  Do **not** rename `InProcessTeammateTaskState` to `TeammateTaskState` in the
  same pass — that touches ~14 consumer files for no behaviour, and this branch
  already has more churn than it can prove.

## Findings the original report missed

Only what I verified to the same bar.

**M1 — A tombstoned or unregistered teammate's structured messages are silently
dropped by the leader, which compounds F1 and F11.**
`useInboxPoller.ts:189-205`: `classifyInboxMessages` resolves the sender with
`resolveTeamPrincipalByName(snapshot, m.from)`, and when that returns `null` the
message is `classified = null`. The handler at `:202-205` then does
`if (isStructuredProtocolMessage(m.text)) continue` — i.e. it **drops** it — and
only falls through to `regularMessages` for plain chat. Since permission requests,
idle notifications, and every other control payload are structured JSON, an F1
survivor can neither receive control messages nor have its own reach the leader,
while its plain chat still arrives as an unvalidated regular message. Combined with
F11's unbounded poll, an F1 survivor that hits a permission prompt hangs forever
by construction, not by race. Verified by reading; no repro built.

**M2 — A crash between `open(O_TRUNC)` and `write()` leaves a permanently empty
team file.** Covered in F3 above; restating it here because it is the part of that
finding that actually justifies the atomic-rename fix, and the report did not
raise it. Unlike the ~1.4µs read race, this failure is durable and indistinguishable
from "team does not exist" for the rest of the team's life.

**M3 — `killOrphanedTeammatePanes` cannot see a teammate whose registration
failed.** `teamHelpers.ts:1129-1140` filters `teamFile.members`, and the member row
is written by the same `transitionTeamRecipient` call that F1 shows can fail after
launch. So an F1 pane survivor also escapes the leader's own SIGINT cleanup, and
then `cleanupTeamDirectories` (`:1172-1200`) `rm -rf`s the team directory out from
under it. This is the report's F3 outcome ("orphaned teammate processes in open
panes") reached by a path that has nothing to do with torn reads and is far more
likely than one. Verified by reading plus the mode-A repro output
(`members=[]` after the failed transition).

## Uncertainty

- **Lock-contention frequency.** Like the original report, I did not measure how
  often 30 back-to-back team-file acquisitions actually exhaust the ~407ms budget
  on a real filesystem. My F1 repro forced the lock rather than contending for it,
  which proves the *consequence* but not the *rate*. The second F1 trigger (team
  directory removed mid-spawn) is timing-independent, so the finding does not rest
  on this. A two-process contention probe would settle it; `DONE.md:25` records
  that such a probe was planned and never built.
- **`ad649cc` drift.** HEAD moved during this verification. I re-verified
  `spawnMultiAgent.ts`, `teamHelpers.ts`, `inProcessRunner.ts`,
  `teammateMailbox.ts` and `agentToolUtils.ts` as they sit on disk and confirmed
  `ad649cc` touched only `AgentTool.tsx`. `AgentTool.tsx` also remains dirty with
  further uncommitted work by another session, so any fix landed against these
  citations should re-locate them first.
