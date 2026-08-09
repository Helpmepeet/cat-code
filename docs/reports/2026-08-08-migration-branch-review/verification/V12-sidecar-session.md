# A12 adversarial validation: sidecar session lifecycle, resume, catalog, subagent history

> **Verification provenance:** Claude Opus 5, high effort. Source review plus five
> standalone scratch scripts run against the operator's real `~/.cat-code` corpus
> (1.0 GB, 1,803 `.jsonl` files) that import the actual repo modules
> (`loadTranscriptFile`, `readTranscriptRunFacts`). One focused test run:
> `bun test app/sidecar/sidecarServer.test.ts -t "bypassPermissions"` (2 pass).
> No GUI, no full suite, no repo file edited except this report. Branch
> `migration` at `a1012b1` (was `a17e5e9` when I started; the two commits in
> between touched only `docs/` and `src/tools/AgentTool`, so nothing under
> `app/` moved beneath these findings).

## Overall verdict

The original report is substantially right about the small stuff and substantially
wrong about its two headline claims. Of 14 findings: **6 CONFIRMED, 4 PARTIALLY
CONFIRMED, 2 OVERSTATED, 1 INVALID, 1 DUPLICATE.** Both HIGHs fail as stated. The
empty-agent-set HIGH is a textbook pattern-match: the mechanism is real but the
consequence is impossible, because `QueryEngine.ts:427,597` hard-codes
`mainThreadAgentDefinition: undefined`, so a desktop session never applies a
main-thread agent whether it is fresh or resumed, and the report's own proposed fix
would not change any observable behavior. The bypass HIGH points at a genuine and
unratified security problem, but its causal story is wrong: the escalation gate was
already gone at HEAD (committed in `b74b583` on Aug 6, with a **passing committed
test** that asserts bypass is accepted while `isBypassPermissionsModeAvailable` is
`false`), so the uncommitted line is not "the last leg" of that chain. What the
uncommitted line actually does is worse in a way the report missed: it overwrites
the value `initializeToolPermissionContext` computed from the Statsig gate **and**
the `permissions.disableBypassPermissionsMode: "disable"` setting, and it silently
turns on the `plan`-mode bypass branch at
`src/utils/permissions/permissions.ts:1288-1289`. The thing in this scope that most
deserves action is that one line, for the reason the report did not give.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Uncommitted change removes the last leg of the bypass gate | PARTIALLY CONFIRMED | Gate was already gone at HEAD (`b74b583`, proven by a passing test); the real harm is defeating the settings/Statsig killswitch and enabling plan-mode bypass |
| F2 | HIGH | Resume wired with an EMPTY agent-definition set loses the agent | OVERSTATED | `QueryEngine` never applies a main-thread agent at all; the discarded field is discarded either way; the proposed fix changes nothing observable |
| F3 | MED | Everything except `messages` discarded; thread goal lost on restore | CONFIRMED | `appState.threadGoal` is only ever written by the paths the sidecar skips; consequence is worse than stated (goal tools break, not just display) |
| F4 | MED | Worktree restore moves cwd out from under `args.cwd` consumers | PARTIALLY CONFIRMED | Divergence is real but identical in the TUI (`main.tsx:1950-1951` vs `:3776`); not a desktop defect, and the proposed fix would break terminal parity |
| F5 | MED | Uncapped parallel read on subagent restore | OVERSTATED | Measured 56-65 ms and ~80 MB transient on the worst session; the multi-MB `acompact` sidechains are structurally excluded (no `.meta.json`) |
| F6 | MED | Catalog enumeration failures are completely undiagnosable | CONFIRMED | Error object discarded at the domain, `reason:'internal'` at the worker, and the driver swallows `outcome:'failure'` with no log |
| F7 | MED | `readTranscriptRunFacts` uncapped read + unreachable early exit | PARTIALLY CONFIRMED | Both mechanisms exact; scale claims wrong (no 19 MB main transcript, 227 not ~3,000 files, ≤32 items/run) and measured cost is ~27 ms |
| F8 | LOW | Raw fs-error leak siblings on rename/branch/tag | DUPLICATE | `A02-sidecar-security.md:78-96` already cites all four sites; V02 §3 CONFIRMED it |
| F9 | LOW | Budget `break` drops branches that would have fit | CONFIRMED | `break` at `:260` after `pending` was already drained at `:235-237`; corpus has a 2,989-record sidechain against a ≤4,000 budget |
| F10 | LOW | `seenUuids` snapshotted once per wave | CONFIRMED | 28 of 257 multi-sidechain sessions have cross-branch uuid overlap; worst case 1,770 frames, **all** absent from the main transcript |
| F11 | LOW | Seed/display uuid alignment treats two missing uuids as a match | INVALID | `Message.uuid` is required; 37,278-record corpus scan found zero records without a uuid |
| F12 | LOW | Backfill worker calls `withRestoredSubagentHistory` with no `onError` | CONFIRMED | `transcriptBackfillWorker.ts:168-170` omits the sink the live path passes at `index.ts:207-211` |
| F13 | LOW | Catalog cache writer unbounded, reader caps at 4 MB | PARTIALLY CONFIRMED | Asymmetry real; "no signal on either side" is false, the emit path logs `[catalog-worker] fatal` and exits 1 every 30 s |
| F14 | LOW | `SessionCatalogEntry.sessionId` is an engine id | CONFIRMED | Field and doc-comment are as cited; the `SessionId` alias line ref is `:82`, not `:2782` |

## Per finding

### F1 — [HIGH] Uncommitted change removes the last leg of the bypass-permissions gate; its stated compensating control does not exist in `app/`

- **Verdict**: PARTIALLY CONFIRMED
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/sessionController.ts` and
  `/Users/pt/cat-code/app/sidecar/sessionController.test.ts` are **DIRTY** (this
  finding *is* the dirty hunk). `/Users/pt/cat-code/app/sidecar/permissionDomain.ts`
  and `/Users/pt/cat-code/app/renderer/src/PermissionModeChip.tsx` are also dirty
  with matching comment/UI changes from the same session.
- **Cited location holds?**: Yes, exactly.
  `/Users/pt/cat-code/app/sidecar/sessionController.ts:159-164` is
  `isBypassPermissionsModeAvailable: true` with the comment "The engine's own bypass
  killswitch remains authoritative when the mode is applied", and
  `sessionController.test.ts:448` now asserts `toBe(true)`.
- **Reachable in production?**: Yes. No env gate, no feature flag; the value flows
  into the store at `sessionController.ts:280-293` and is read by the engine at
  `/Users/pt/cat-code/src/utils/permissions/permissions.ts:1286-1299`.
- **Trigger**: Two distinct ones, and the report names the wrong one as new.
  1. *(Not new)* A T1-compromised renderer sends
     `permission.setMode(sessionId,'bypassPermissions')`. This already succeeds at
     HEAD without the dirty change: `handleSetMode`
     (`/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1638-1692`) gates only `auto`;
     `permissionDomain.setMode` calls `transitionPermissionMode`
     (`/Users/pt/cat-code/src/utils/permissions/permissionSetup.ts:597-645`), which
     has no availability check at all; and step 2a at `permissions.ts:1287` allows on
     `mode === 'bypassPermissions'` **regardless of**
     `isBypassPermissionsModeAvailable`.
  2. *(New, and unreported)* With `isBypassPermissionsModeAvailable: true`, the
     second arm of `shouldBypassPermissions` fires:
     `permissions.ts:1288-1289` grants blanket allow whenever
     `mode === 'plan'`. Every desktop session now bypasses all permission prompts
     **in plan mode**, by default, with no renderer involvement.
  3. *(New, and unreported)* The unconditional `true` is spread **over**
     `initializeToolPermissionContext`'s own result, which computed availability from
     the Statsig gate `tengu_disable_bypass_permissions_mode` **and** the settings key
     `permissions.disableBypassPermissionsMode === 'disable'`
     (`permissionSetup.ts:954-963`). So the comment's claim is not merely "unwired":
     the change *overwrites the killswitch's own output* at the only point the
     sidecar ever consults it.
- **Counter-arguments considered**: I checked whether `transitionPermissionMode`,
  `applyPermissionUpdate`, or the permission domain re-checks availability before
  applying the mode (none do); whether any `app/` code calls
  `checkAndDisableBypassPermissions`, `checkAndDisableBypassPermissionsIfNeeded`, or
  `isBypassPermissionsModeDisabled` (zero call sites in `app/`; the only callers are
  `src/main.tsx:2759`, `src/screens/REPL.tsx:740,3136`,
  `src/commands/login/login.tsx:58`, `src/state/AppState.tsx:64`,
  `src/utils/settings/applySettingsChange.ts:63`, and `applySettingsChange` is
  likewise never imported in `app/`); and whether the renderer `disabled` attribute is
  a boundary (it is not, `SECURITY-MINIMUM.md` R2 classifies it as UX). All of the
  report's negative claims here survive. What does **not** survive is the causal
  framing: I proved the boundary was already open at HEAD.
- **True consequence**: The uncommitted line does not open the T1 renderer path; that
  was opened and committed on Aug 6. It (a) makes plan mode permission-free for every
  desktop session, and (b) defeats the operator's and the org's only remaining
  bypass killswitches (settings key + Statsig gate) at the one place the sidecar
  reads them. The code/decision-doc contradiction the report flags is real and
  unamended (`docs/migration/decisions/PERMISSION-BOUNDARY.md:16,199,384`,
  `docs/migration/STATUS.md:111`).
- **Evidence**:
  - `git show b74b583 -- app/sidecar/sidecarServer.ts` shows the deleted block
    `if (raw.mode === 'bypassPermissions' && …isBypassPermissionsModeAvailable !== true)`
    and the rejection message `mode "bypassPermissions" is not available (launch with CATCODE_ALLOW_BYPASS=1)`.
  - The same commit rewrote the boundary test from
    `C2 — bypassPermissions is REJECTED when the trusted launch flag is NOT set` to
    `C2 — bypassPermissions is available without a launch flag`
    (`/Users/pt/cat-code/app/sidecar/sidecarServer.test.ts:3883-3910`). That test
    builds its store with `makePermissionStore()` (`:255-261` → `getDefaultAppState()`
    → `src/Tool.ts:152` `isBypassPermissionsModeAvailable: false`) and asserts
    `toolPermissionContext.mode` becomes `'bypassPermissions'` with no error frame.
  - `bun test app/sidecar/sidecarServer.test.ts -t "bypassPermissions"` → `2 pass, 0 fail`.
    That is a committed, currently-green test proving the gate is gone at HEAD,
    independent of the dirty file.
  - `rg -n "CATCODE_ALLOW_BYPASS" src/ app/` → zero source hits; only docs and reports.
- **Disposition**: Do not ship. The report's fix menu is right in shape but the
  ordering matters: the plan-mode arm (`permissions.ts:1288-1289`) is the part that
  changes behavior for a *non-compromised* operator, so it is the one to reason about
  first. If bypass is to become a normal desktop mode, the honest change is
  `isBypassPermissionsModeAvailable: <whatever initializeToolPermissionContext
  computed>` (i.e. delete the override entirely, keeping the settings/Statsig
  killswitch live) plus an explicit trusted grant for the mode transition, not a
  hard-coded `true`. Restoring only `CATCODE_ALLOW_BYPASS` here would be
  cargo-culted: without also restoring the `!== true` reject in `handleSetMode` it
  gates nothing against a compromised renderer, and *with* it restored the plan-mode
  arm still fires for anyone who does set the env var. Amend
  `PERMISSION-BOUNDARY.md` §3 and the STATUS row in the same change, and delete the
  false killswitch sentence from `sessionController.ts:161-162`,
  `permissionDomain.ts:100-101` and `PermissionModeChip.tsx:16-18`.

### F2 — [HIGH] Resume is wired with an EMPTY agent-definition set, so a restored session silently loses its agent

- **Verdict**: OVERSTATED
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/sessionResume.ts` is clean.
- **Cited location holds?**: Yes.
  `/Users/pt/cat-code/app/sidecar/sessionResume.ts:88-99` passes
  `modeApi: null`, `mainThreadAgentDefinition: undefined`,
  `agentDefinitions: { activeAgents: [], allAgents: [] }`, `cliAgents: []`.
  `/Users/pt/cat-code/src/utils/sessionRestore.ts:236-245` does take the
  "no longer available" branch against an empty array, exactly as described.
- **Reachable in production?**: The code path is reachable; the *consequence* is not.
  A desktop session has no main-thread agent to lose. The sidecar's QueryEngine is the
  only engine surface it has, and `QueryEngine.ts:427` and `:597` both build the
  system prompt with a literal `mainThreadAgentDefinition: undefined`. The
  `agentDefinitions.activeAgents` the sidecar *does* load
  (`sessionController.ts:317`) are passed as `agents:` to
  `createQueryEngineAppSessionConfigFromSetup` (`sessionController.ts:381`), which is
  the **subagent** roster for `AgentTool`, not the main thread. Nothing in `app/`
  calls `setMainThreadAgentType` or ever populates `mainThreadAgentDefinition`
  (`rg -n "setMainThreadAgentType|mainThreadAgentDefinition" app/` returns only
  `sessionResume.ts:94` and `contextBreakdownDomain.ts:119`, both passing `undefined`).
- **Trigger**: None that produces the claimed loss. Walking each side effect the empty
  set causes:
  - `setMainThreadAgentType(undefined)` (`sessionRestore.ts:243`) is a **no-op**: the
    sidecar is a fresh process per session (N-process model) and
    `src/bootstrap/state.ts:404` already initializes `mainThreadAgentType: undefined`.
  - The skipped model application (`sessionRestore.ts:250-256`) would be clobbered
    anyway: `initializeSidecarModelProvider` runs **after** resume
    (`index.ts:145` then `:176` → `sessionController.ts:278`) and unconditionally calls
    `setMainLoopModelOverride(selectedModel)` at `sessionController.ts:243`.
  - `restoredAgentDef` and `initialState.agent` (`sessionRestore.ts:823,826`) are
    discarded by `sessionResume.ts:112` regardless of what the agent set contains.
  - `refreshAgentDefinitionsForModeSwitch` (`sessionRestore.ts:795`) only re-derives
    under `feature('COORDINATOR_MODE') && modeWasSwitched`, and its output lands in
    `initialState`, which is discarded.
  So a populated agent set would change exactly one observable: `getMainThreadAgentType()`
  would return the agent name instead of `undefined`, which is read only by
  `src/utils/hooks.ts:319`, `src/utils/sessionStart.ts:131` (hook payload `agentType`)
  and `src/components/StatusLine.tsx:42` (TUI only). The empty set does not *lose*
  that label, it fails to *gain* it.
- **Counter-arguments considered**: I looked specifically for the rehydration the
  prompt asked about and found it. `restoreSessionMetadata`
  (`src/utils/sessionStorage.ts:3464`) does re-seat
  `project.currentSessionAgentSetting = meta.agentSetting`, and
  `sessionStorage.ts:1240` re-writes `agentSetting` into the resumed transcript's
  metadata. So the transcript's record of the agent **survives** a desktop restore
  intact, and a later `claude --resume` in the terminal restores it normally. Nothing
  is silently lost from disk. I also checked whether the desktop has any main-thread
  agent picker that could make the claim matter later (it does not;
  `agentConfigState.ts` is the read-only P4-7 snapshot).
- **True consequence**: A desktop session runs with no main-thread agent, always,
  fresh or resumed. That is a parity gap against the terminal's `--agent`, not a
  resume regression, and it is not caused by the cited lines. The only differential
  effect of the empty set is that a `SessionStart`/`PreToolUse` hook sees
  `agentType: undefined` where the terminal would have shown the agent name.
- **Evidence**: `src/QueryEngine.ts:427,597`; `src/bootstrap/state.ts:404,1681-1687`;
  `app/sidecar/sessionController.ts:243,317,381`;
  `rg -n "setMainThreadAgentType|mainThreadAgentDefinition|agentSetting" app/ --glob '!*.test.*'`.
- **Disposition**: Do not apply the proposed fix as written. Hoisting
  `loadAgentDefinitionsForRuntime(cwd)` above `resumeEngineSession` costs a real
  refactor of `index.ts` and `sessionController.ts` and buys one hook-payload string.
  If it is done at all, do it as a one-line honesty fix instead: pass the already-loaded
  definitions and, in the same change, **fix the comment** at
  `sessionResume.ts:89-92`, which currently claims the degradation is acceptable
  without saying that the field it feeds is discarded four lines later. The finding
  that deserves an owner is the one behind this: `QueryEngine` cannot apply a
  main-thread agent, so `app/` has no path to agent-scoped sessions at all. That is a
  PARITY-LEDGER item, not a `sessionResume.ts` bug, and it should not be filed as
  CLAUDE.md §8 mistake 1 — the sidecar is not passing a stub where the engine passes
  real data, it is passing a stub into a slot the engine also leaves empty.

### F3 — [MED] Everything `processResumedConversation` restores except `messages` is discarded; the thread goal is lost on every restore

- **Verdict**: CONFIRMED
- **Working-tree status**: `sessionResume.ts` clean; `sessionController.ts` is dirty
  but only at `:159-164` (F1), not at the `createStore` seed this finding cites.
- **Cited location holds?**: Yes. `sessionResume.ts:112` returns
  `{ engineSessionId, messages: processed.messages }`; `ProcessedResume`
  (`src/utils/sessionRestore.ts:293-301`) carries `initialState`, `restoredAgentDef`,
  `fileHistorySnapshots`, `contentReplacements`, `agentName`, `agentColor`;
  `sessionController.ts:280-293` builds the store from `getDefaultAppState()` with
  only three overrides (`toolPermissionContext`, `mainLoopModel`, `effortValue`).
- **Reachable in production?**: Yes. No gate. `CreateGoalTool`, `UpdateGoalTool` and
  `GetGoalTool` are registered unconditionally in `src/tools.ts:245-247`, so a desktop
  session can genuinely hold a thread goal.
- **Trigger**: Create a thread goal in a desktop session (the model calls
  `CreateGoalTool`, or the goal rides a submit's `goalSnapshot`), quit, restore.
  `loadConversationForResume` reads the goal
  (`src/utils/conversationRecovery.ts:489-491`) and `processResumedConversation`
  returns it (`src/utils/sessionRestore.ts:829`), but nothing writes it into the
  sidecar's store, so `createSidecarGoalDomain.getSnapshot()`
  (`app/sidecar/goalDomain.ts:19`) reads `null` and `sidecarServer.ts:2740-2746` emits
  a null `thread-goal.snapshot`.
- **Counter-arguments considered**: I checked every writer of `appState.threadGoal` in
  the engine (`rg -n "threadGoal" src/ --glob '!*.test.*'`). There are exactly three:
  `src/utils/threadGoalActions.ts:51,71,97` (the goal tools and `/goal`),
  `src/utils/sessionRestore.ts:118` (`restoreSessionStateFromLog`, the REPL-only path),
  and `initialState` at `:829`. The sidecar reaches none of them on restore. I also
  checked whether `restoreSessionMetadata` helps: it caches
  `project.currentSessionThreadGoal` (`sessionStorage.ts:3467-3468`) so the goal is
  re-persisted to the transcript, but nothing reads that cache back into app state.
  And I checked whether the renderer could recover the goal from a frame
  (`parseThreadGoal` at `sidecarServer.ts:63` feeds the inbound
  `AppSessionController.goalSnapshot` submit option, a different field).
- **True consequence**: Worse than the report says. Beyond the empty goal surface
  (`MetadataInspector.tsx:167-179` via `App.tsx:3149`), the **engine's own goal tools
  break** on a restored session: `UpdateGoalTool.validateInput`
  (`src/tools/UpdateGoalTool/UpdateGoalTool.ts:101-106`) returns
  "No current thread goal exists" for a session that plainly has one, and
  `CreateGoalTool.validateInput`
  (`src/tools/CreateGoalTool/CreateGoalTool.ts:55-62`) will happily mint a **second**
  goal because it sees `null`.
- **Evidence**: `src/utils/conversationRecovery.ts:489`, `src/utils/sessionRestore.ts:829`,
  `app/sidecar/sessionResume.ts:112`, `app/sidecar/sessionController.ts:280-293`,
  `app/sidecar/goalDomain.ts:19`, `src/tools/UpdateGoalTool/UpdateGoalTool.ts:101`,
  `src/tools/CreateGoalTool/CreateGoalTool.ts:55`.
- **Disposition**: Apply essentially the proposed fix, narrowed. Return
  `processed.initialState.threadGoal` from `resumeEngineSession` (a `ThreadGoal | null`,
  not the whole `AppState` — seeding a whole foreign `AppState` into `createStore`
  would also carry `agentDefinitions: []` from F2's empty set and an `agent` field the
  desktop cannot honor), and seed it beside the existing three overrides. Do **not**
  also thread `agent` as the report suggests, for the reason in F2. Add a regression
  test that a goal-bearing transcript restores with a non-null
  `createSidecarGoalDomain().getSnapshot()`.

### F4 — [MED] Worktree restore moves the process cwd out from under every consumer that uses `args.cwd`

- **Verdict**: PARTIALLY CONFIRMED
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/index.ts` is clean.
- **Cited location holds?**: Yes. `index.ts:145` resumes with `args.cwd`; `:178` passes
  `cwd: args.cwd` to `createSidecarSessionController`, which roots
  `getCommands(cwd)` (`sessionController.ts:175,316`),
  `getAgentDefinitionsWithOverrides(cwd)` (`:196,317`),
  `loadAvailableSettingOptions(cwd)` (`:588`),
  `createSidecarWorkspaceTrustDomain(cwd)` (`:605`) and
  `createSidecarRemoteSettingsDomain({ cwd })` (`:608`).
  `restoreWorktreeForResume` (`src/utils/sessionRestore.ts:350-384`) does
  `process.chdir` + `setCwd` + `setOriginalCwd` + cache clears, called from
  `processResumedConversation` at `:741`.
- **Reachable in production?**: Yes. `isWorktreeModeEnabled()` returns a hard `true`
  (`src/utils/worktreeModeEnabled.ts:9-11`), so `EnterWorktreeTool`/`ExitWorktreeTool`
  are in every session's tool set (`src/tools.ts:259`). The registry row's `cwd` is
  fixed at session creation (`app/host/host.ts:286,366`), so a restore of a
  worktree-resident session does pass the parent path.
- **Trigger**: Constructible as described. But so is the identical trigger in the
  terminal.
- **Counter-arguments considered**: This is where the finding breaks. The TUI's
  `--resume` has **exactly the same ordering**. `src/main.tsx:1950-1951` kicks
  `getCommands(preSetupCwd)` / `getAgentDefinitionsWithOverrides(preSetupCwd)` and
  `:2051` joins them, all long before the resume at `:3776-3778` /`:3817-3819`
  /`:3861-3870` calls `processResumedConversation` → `restoreWorktreeForResume`. The
  `worktreeEnabled ? null :` guard at `:1950` covers only the `--worktree` **CLI flag**
  (which chdirs inside `setup()`), not a transcript-restored `EnterWorktreeTool`
  worktree. So after a terminal `--resume` into a worktree, the terminal's slash
  commands, agent definitions and settings also describe the parent repo. The engine
  furthermore states this anchoring is deliberate:
  `sessionRestore.ts:372-376` explains that `projectRoot` is intentionally left
  unset so "skills/history stay anchored to the original project."
- **True consequence**: The divergence is real, but it is engine-wide resume behavior
  faithfully reproduced by the sidecar, not a desktop defect. Blast radius is
  therefore zero relative to the terminal, which is the parity bar this program uses.
- **Evidence**: `src/main.tsx:1940-1951,2046,2051,3776-3778`;
  `src/utils/sessionRestore.ts:350-384,741`; `src/utils/worktreeModeEnabled.ts:9`;
  `app/host/host.ts:286,345-366`.
- **Disposition**: Do **not** apply the proposed fix. Re-reading `getCwd()` after
  resume and rooting the domains there would make the desktop diverge from the
  terminal in the opposite direction and would contradict the engine's own stated
  anchoring intent, for a case (`getCommands` in a git worktree, where `.claude/` is
  usually absent) where the parent-repo answer is the more useful one. If the two-cwd
  situation is genuinely a problem it is an **engine** finding against
  `restoreWorktreeForResume`, and it should be filed there with the terminal as the
  primary reproduction. The one thing worth doing in `app/` is a stderr line at
  `index.ts:146` when `getCwd() !== args.cwd` after resume, so the disagreement is at
  least visible.

### F5 — [MED] Subagent restore loads every reachable sidechain transcript in full, in parallel, before the frame budget is applied

- **Verdict**: OVERSTATED
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/subagentHistory.ts` is clean.
- **Cited location holds?**: Yes. `subagentHistory.ts:239-256` is an uncapped
  `Promise.all` over `matched`; the budget is only consulted afterwards at `:257-263`.
  `getAgentTranscriptForSession` (`src/utils/sessionStorage.ts:5035-5046`) calls
  `loadTranscriptFile(agentFile)` with **no** `maxReadBytes`, so each file is read
  whole. The report's core observation — the budget bounds retention, not reads — is
  correct.
- **Reachable in production?**: Yes, on any restore with subagents.
- **Trigger**: Restore a session whose Agent `tool_use` frames sit inside the restored
  window. On this machine the worst case is
  `/Users/pt/.cat-code/projects/-Users-pt-cat-code/3f88d40c-…/subagents`
  (53 sidechains, 21.3 MB) and `00d21f29-…/subagents` (33 sidechains, 27.8 MB).
- **Counter-arguments considered**: Two, both material.
  1. **The big files are structurally excluded.** `loadBranchCandidates`
     (`subagentHistory.ts:180-196`) sources candidates from
     `listAgentMetadataForSession`, which enumerates **only** `agent-*.meta.json`
     files (`src/utils/sessionStorage.ts:418-430`), and then drops any candidate
     without `parentToolUseId` (`:188-189`). The multi-MB transcripts in this corpus
     are all `agent-acompact-*.jsonl` autocompact sidechains, which have **no**
     `.meta.json` at all. The report's "largest single sidechain file 19 MB" is the
     18.1 MB `9962367c-…/subagents/agent-acompact-c3988211871f076b.jsonl`, which this
     code can never read, and it is not in the `00d21f29` directory the report
     attributes it to (largest there is 6.1 MB).
  2. **The measured cost is small.** I ran the real
     `loadTranscriptFile` in parallel over both worst-case directories.
- **True consequence**: A transient memory spike of roughly 80 MB and ~60 ms of wall
  time on the worst session on this machine, in the sidecar's startup path. Real, but
  not a MED-severity resource defect.
- **Evidence** (scratch script importing the repo module, output verbatim):
  ```
  # 3f88d40c (53 sidechains, 21.3 MB)
  files=53 elapsedMs=56 totalMessages=5297 rssMB=302
  # 00d21f29 (33 sidechains, 27.8 MB)
  baselineRssMB=220
  files=33 elapsedMs=65 msgs=3443 peakRssMB=298
  ```
  Baseline 220 MB is the engine module import itself; the load adds ~78 MB.
  `ls .../subagents/*.jsonl | wc -l` → 53; `.meta.json` absent for every
  `agent-acompact-*` file checked.
- **Disposition**: Downgrade to LOW and fix cheaply rather than restructuring. The
  report's proposed sequential loop trades the (measured, negligible) parallelism for
  latency on the exact path that must not be slow. The correct minimal change is to
  give `getAgentTranscriptForSession` the same byte cap its sibling already uses
  (`loadTranscriptFile` accepts `maxReadBytes`; `transcriptBackfillWorker.ts:152-158`
  and `index.ts:190-198` both pass `MAX_HISTORY_REPLAY_BYTES * 2`), which bounds the
  worst case without serializing anything. Fixing F9 in the same edit is the higher
  value change.

### F6 — [MED] Catalog enumeration failures are completely undiagnosable

- **Verdict**: CONFIRMED
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/sessionsCatalogDomain.ts`,
  `sessionsCatalogWorker.ts` and `/Users/pt/cat-code/app/main/sessionsCatalogRunner.ts`
  are all clean.
- **Cited location holds?**: Yes. `sessionsCatalogDomain.ts:86-90` is a bare
  `catch { return null }` around `loadAllProjectsMessageLogsProgressive` +
  `buildSessionsCatalogSnapshot` + `annotateCwdExistence`, with the error binding
  omitted entirely. The worker's failure emit is at
  `app/sidecar/sessionsCatalogWorker.ts:63-73` (report said `:67-71`; same block) and
  the contrasting cache-write log at `:78-85` (report said `:82-84`).
- **Reachable in production?**: Yes. The worker is respawned every 30 s by main's
  driver (`sessionsCatalogRunner.ts` `SESSIONS_CATALOG_REFRESH_INTERVAL_MS`).
- **Trigger**: Any throw inside the try. `loadAllProjectsMessageLogsProgressive`
  reads the whole projects tree, so an `EACCES` on `~/.cat-code/projects`, a loader
  crash on a malformed transcript, or an OOM at
  `SESSIONS_CATALOG_ENRICH_LIMIT = 600` (`sessionsCatalogDomain.ts:62`) all land here.
- **Counter-arguments considered**: I traced the whole chain looking for a place the
  reason survives. `runSessionsCatalogWorker` **does** forward worker stderr to
  `options.log` (`sessionsCatalogRunner.ts:190-191`), which would have rescued this —
  but the domain wrote nothing to stderr, so `diagnostics` is empty. The worker then
  emits `reason: 'internal'`, the runner sets `outcome = 'failure'` and returns
  **normally** (`:152-155`), and `createSessionsCatalogDriver.tick` only logs on a
  *rejected* `run()` (`:280-287`). A `'failure'` outcome is therefore swallowed
  everywhere. I also checked `parseSessionsCatalogWorkerResult`
  (`app/shared/sessionsCatalogWorker.ts:63-71`): the wire vocabulary admits exactly one
  `reason` value, so even a richer worker message could not currently cross.
- **True consequence**: Exactly as claimed. The Sessions page freezes on the last good
  snapshot indefinitely and no log line anywhere names a cause.
- **Evidence**: `app/sidecar/sessionsCatalogDomain.ts:86-90`;
  `app/sidecar/sessionsCatalogWorker.ts:63-85`;
  `app/main/sessionsCatalogRunner.ts:152-155,190-191,280-287`;
  `app/shared/sessionsCatalogWorker.ts:63-71`.
- **Disposition**: Apply the proposed fix as written
  (`catch (error) { process.stderr.write(...); return null }`), matching the
  cache-write path's format. It is the smallest change that makes the failure
  nameable, and the runner already has the plumbing to surface it. Widening the wire
  `reason` union is not needed and would be a protocol change for no gain.

### F7 — [MED] `readTranscriptRunFacts` reads whole transcripts uncapped, and its early-exit is unreachable on non-Codex sessions

- **Verdict**: PARTIALLY CONFIRMED
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/transcriptRunFacts.ts` and
  `transcriptBackfillWorker.ts` are clean.
- **Cited location holds?**: Yes, both halves, precisely.
  `transcriptRunFacts.ts:76` is `readFileSync(path, 'utf8').split('\n')` with no cap;
  `:118-126` requires `facts.effort !== null` in the early-exit condition; the sibling
  bounded read is at `transcriptBackfillWorker.ts:153-158`; the per-item call is at
  `:186` (report said `:188`).
- **Reachable in production?**: Yes. Both mechanisms are exactly as described, and I
  confirmed the causal claim about `effort`: `recordRunFacts`'s own doc-comment states
  effort comes "from Codex WS completion telemetry (`recordCodexSendPath`, hence
  absent on Anthropic, HTTP-fallback and aborted turns)"
  (`src/utils/sessionStorage.ts:609-611`), and `recordCodexSendPath` has exactly one
  caller, `src/services/api/codex-fetch-adapter.ts:255`. So on an Anthropic session
  `facts.effort` stays `null` forever and the exit never fires. The report is right
  that only `usedTokens` is still needed once `snapshot !== null`, because
  `:135-137` overwrite the other three wholesale.
- **Trigger**: Any Anthropic-provider transcript in a backfill manifest.
- **Counter-arguments considered**: I looked for the scale the MED severity rests on
  and it is not there. The manifest is capped at
  `MAX_TRANSCRIPT_BACKFILL_SESSIONS = 32` (`app/shared/transcriptBackfill.ts:27`),
  processed sequentially in a **disposable child process**
  (`transcriptBackfillWorker.ts:110`), never on the UI or engine thread. The report's
  corpus figures are also wrong: the largest *main* transcript on this machine is
  16.5 MB / 2,725 records, not 19 MB (the 18.1 MB file is an `acompact` sidechain this
  function never opens), and there are 227 main transcripts, not "~3,000 files"
  (1,803 `.jsonl` total including sidechains).
- **True consequence**: Roughly 27 ms and ~35 MB transient per worst-case item, at
  most 32 items per background run. A LOW-severity tidy-up, not a MED resource defect.
- **Evidence** (scratch scripts, verbatim):
  ```
  # real readTranscriptRunFacts on the largest main transcript (16.5 MB, Codex → early exit)
  {"model":"gpt-5.6-sol",...} elapsedMs=31
  # forced worst case: read + split + JSON.parse every line of the same file
  lines=1913 parsed=1912 readSplitMs=8 parseAllMs=19 rssMB=116
  ```
  `find ~/.cat-code/projects -maxdepth 2 -name '*.jsonl' | wc -l` → 227;
  `find ~/.cat-code/projects -name '*.jsonl' | wc -l` → 1803.
- **Disposition**: Apply the first half of the proposed fix and skip the second.
  Dropping `facts.effort !== null` from the exit condition once `snapshot !== null` is
  a one-line, strictly-correct change with a clear test (a synthetic Anthropic
  transcript with a `run_facts` line near the tail must not parse the head). Adding a
  byte cap is where the proposed fix is wrong: the read must be a **tail** read to
  keep the newest-first scan meaningful, and `readFileSync` has no tail form, so
  "give it the same byte cap as its sibling" would silently truncate the *end* of the
  file and lose the newest `run_facts`. Either leave the read alone at this scale, or
  do a real tail read with a `read`+offset like
  `src/utils/sessionStorage.ts:3235-3245` already does.

### F8 — [LOW] Sibling instances of the raw-fs-error leak already confirmed on `export`

- **Verdict**: DUPLICATE
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/sessionActionsDomain.ts` is clean.
- **Cited location holds?**: Yes. `sessionActionsDomain.ts:160-163` (rename),
  `:177-180` (export), `:194-197` (branch), `:218-221` (tag) all interpolate
  `error.message`, and the underlying writes are real
  (`saveCustomTitle`/`saveTag` → `appendEntryToFile`, which retries once with
  `mkdirSync` and then rethrows, `src/utils/sessionStorage.ts:3215-3227`).
- **Reachable in production?**: Yes; an `EACCES` or a full disk under
  `~/.cat-code/projects` produces a path-bearing Node error that reaches the renderer.
- **Trigger**: As described.
- **Counter-arguments considered**: The premise, not the mechanism, is what fails.
  The report frames `export` as "the established finding" and the other three as
  newly-reported siblings, arguing a fix might otherwise be applied to one of four
  call sites. But `/Users/pt/cat-code/docs/reports/2026-08-08-migration-branch-review/A02-sidecar-security.md:85`
  already cites **all four** explicitly (`:160-161`, `:177-178`, `:194-195`,
  `:218-219`) plus `handleSessionActionVerb`'s own `.catch`, and
  `verification/V02-sidecar-security.md:31-34` verified it CONFIRMED with the renderer
  consumers named. There are no siblings left to add.
- **True consequence**: Nothing new. The defect is real and already owned.
- **Evidence**: `A02-sidecar-security.md:78-96`; `verification/V02-sidecar-security.md:30-35`.
- **Disposition**: Fold into A02's item; do not track separately. Prefer V02's
  disposition (redact only **failure** messages before frame construction) over this
  report's `redactActionError(verb, error)` helper, because A02/V02 correctly note
  that success messages intentionally carry user titles and server URLs and must not
  go through the same filter.

### F9 — [LOW] Budget `break` drops subagent branches that would have fit

- **Verdict**: CONFIRMED
- **Working-tree status**: clean.
- **Cited location holds?**: Yes. `subagentHistory.ts:258-263`:
  `for (const branch of loaded) { if (branch === null) continue; if (branch.frames.length > budget) break; … }`.
  The candidates were already drained from `pending` at `:235-237`, before the load, so
  nothing skipped by the `break` is ever retried on a later wave.
- **Reachable in production?**: Yes; no gate.
- **Trigger**: Two, and the ordinary one is more common than the report's dramatic one.
  (a) A single oversized branch: the corpus contains a 2,989-record sidechain
  (`2927630a-…/agent-ab6d5e4f8db1ef4da.jsonl`) against a budget of at most 4,000 minus
  the display load. (b) Far more common: budget exhaustion mid-list. With
  `budget = 4000 - assembled.length` and a largest main transcript of 2,725 records, a
  session with several chatty subagents drains the budget after two or three branches,
  and the **next** branch — however small — aborts the loop, dropping every remaining
  branch including ones that would have fit in the leftover.
- **Counter-arguments considered**: I checked whether the outer `while` recovers
  (it does not: `pending` no longer contains the skipped candidates, and
  `branches.length === 0` breaks the outer loop entirely), and whether the renderer
  degrades gracefully (it does — the Agent card renders with no children, which is
  precisely the silent wrong-looking outcome). I also checked whether ordering makes
  the oversized branch usually last (it does not; `matched` follows `spawnedAt` sort
  order from `:181-185`, which is uncorrelated with size).
- **True consequence**: Restored Agent cards come back empty even though replay budget
  remained. Silent.
- **Evidence**: `app/sidecar/subagentHistory.ts:229-266`; `app/shared/limits.ts:141`
  (`MAX_HISTORY_REPLAY_FRAMES = 4_000`); corpus scan
  `maxMainTranscriptLines=2725`, `maxSidechainLines=2989`.
- **Disposition**: Apply the proposed fix (`continue` instead of `break`). It is a
  one-word change and strictly better: the loop already tracks `budget` per branch, so
  `continue` cannot overrun it. Extend `subagentHistory.test.ts` with a case where an
  oversized branch precedes a fitting one, since the existing tests
  (`:58-60,77-78,104-112`) do not cover the budget arm.

### F10 — [LOW] `seenUuids` is computed once per wave, so sibling fork-agent branches cannot dedupe against each other

- **Verdict**: CONFIRMED
- **Working-tree status**: clean.
- **Cited location holds?**: Yes. `subagentHistory.ts:238`
  `const seenUuids = collectUuids(assembled)` is captured before the `Promise.all` at
  `:239`, so every branch in the wave sees the same pre-wave set. The fork-agent uuid
  sharing the doc-comment cites is real: `src/utils/sessionStorage.ts:1678-1684`
  deliberately skips dedupe for agent-sidechain local writes so fork-inherited parent
  messages keep their original uuids.
- **Reachable in production?**: Yes.
- **Trigger**: Two or more branches accepted in the same wave that carry uuids the
  assembled main history does not have. Wave 1's `assembled` is the merged display
  history, so branches spawned from the main thread are all in wave 1 and cannot see
  each other.
- **Counter-arguments considered**: My first instinct was that this is unreachable —
  fork agents inherit from the **main** session, so their duplicated uuids should
  already be in `assembled` and caught by the pre-wave `seenUuids`. I tested that
  empirically instead of assuming, and it is wrong: in the worst session on this
  machine, **all 1,770** cross-branch duplicate uuids are absent from the main
  transcript. (The inherited context that gets copied into sidechains is not the
  same set of records that ends up in the main `.jsonl`.) I also confirmed nested
  branches are unaffected: wave 2's `seenUuids` is recomputed from the newly-spliced
  `assembled`, so cross-wave dedupe works.
- **True consequence**: Wasted replay budget, exactly as claimed, and the renderer's
  own uuid dedupe (`transcriptProjector.ts:952-955,1039`) means the cost is invisible:
  real content is evicted for frames that are then discarded. Worst measured case is
  1,770 frames against a budget of at most ~2,000.
- **Evidence** (scratch scripts, verbatim):
  ```
  sessionsWith>=2Sidechains=257 withCrossBranchUuidOverlap=28 worstOverlapFrames=1770 (729f6822-…)
  worstCrossBranchDupNotInMainTranscript=1770 (ofTotalCrossBranchDup=1770) session=729f6822-…
  ```
  11% of multi-sidechain sessions are affected.
- **Disposition**: Apply the proposed fix, folded into the F9 edit since it is the
  same loop: make `seenUuids` a mutable working set and add each accepted branch's
  uuids as it is spliced. Note the ordering consequence and accept it: dedupe becomes
  order-dependent (the first branch in `spawnedAt` order keeps the shared frames), which
  is the same rule the cross-wave case already follows.

### F11 — [LOW] Seed/display uuid alignment treats two missing uuids as a match

- **Verdict**: INVALID
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/historyProjection.ts` is clean.
- **Cited location holds?**: The line is where the report says
  (`historyProjection.ts:48`, `displayHistory[start + index]?.uuid === message.uuid`),
  and `undefined === undefined` would indeed be `true`. The *reachability* is what
  fails.
- **Reachable in production?**: No. Both sides of the comparison come from
  `projectResumedHistory(Message[])` → `toSDKMessages`
  (`src/utils/messages/mappers.ts:190-258`), which copies `uuid: message.uuid` from
  `Message`, where `uuid: UUID | string` is a **required** field on every variant
  (`src/types/message.ts:60,89,118,125,134,221,234,268`). `SDKMessage.uuid` is
  optional only for wire tolerance. Additionally the messages come from
  `loadTranscriptFile`, which keys them into a `Map<UUID, TranscriptMessage>`, so at
  most one uuid-less record per file could even survive.
- **Trigger**: None constructible. I scanned 37,278 `assistant`/`user`/`system`
  records across two project directories for a missing or empty `uuid` and found
  **zero**.
- **Counter-arguments considered**: The report's supporting argument is that
  `subagentHistory.ts:91,:122` runtime-check `typeof message.uuid === 'string'`, so an
  absent uuid "is a real possibility on this type." Those checks are `collectUuids`
  and `projectBranchFrames` narrowing an optional field before inserting into a `Set`
  — a type-level obligation, not evidence of a real occurrence. I also verified the
  index cannot go out of range (`start` runs from
  `displayHistory.length - seedHistory.length` down to 0, so `start + index` is always
  in bounds), so the `?.` is doing nothing but the uuid narrowing.
- **True consequence**: None observed or constructible.
- **Evidence**: `src/types/message.ts:60,89,118`; `src/utils/messages/mappers.ts:190-258`;
  corpus scan `records=37278 missingUuid=0 {}`.
- **Disposition**: No change required. If someone wants the belt-and-braces version,
  the guard is one clause (`typeof message.uuid === 'string' && message.uuid.length > 0 && …`)
  and harmless, but it should be filed as hardening with no claimed defect, not as a
  correctness finding. Do not add a test that pretends to reproduce a real transcript
  shape, because none exists.

### F12 — [LOW] Backfill worker calls `withRestoredSubagentHistory` with no `onError`, so nesting failures are fully silent there

- **Verdict**: CONFIRMED
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/transcriptBackfillWorker.ts`
  and `index.ts` are clean.
- **Cited location holds?**: Yes, off by four lines.
  `transcriptBackfillWorker.ts:168-170` is
  `await withRestoredSubagentHistory(item.engineSessionId, merged.history)` with the
  optional third argument omitted; the live path passes
  `message => process.stderr.write(...)` at `index.ts:207-211`. The parameter is
  optional at `subagentHistory.ts:213-217`.
- **Reachable in production?**: Yes. The catch that would have called `onError`
  (`subagentHistory.ts:268-275`) fires on any throw from `listAgentMetadataForSession`
  or `getAgentTranscriptForSession`.
- **Trigger**: An unreadable or corrupt sidechain file during a backfill run.
- **Counter-arguments considered**: I checked whether the worker logs the failure some
  other way. It does not: the whole nesting result is swallowed into `nested`, and the
  worker's own stderr is used for four *other* diagnostics
  (`:148-150` identity drift, `:189-191` secret block, plus emit failures), which is
  exactly the inconsistency the finding names. I also confirmed the divergence claim:
  `index.ts` and the worker call the same function on the same transcript, so a
  failure here produces cached previews with childless Agent cards beside a live
  restore that has children.
- **True consequence**: As claimed.
- **Evidence**: `app/sidecar/transcriptBackfillWorker.ts:161-170`;
  `app/sidecar/index.ts:203-211`; `app/sidecar/subagentHistory.ts:213-217,268-275`.
- **Disposition**: Apply as proposed. One argument, using the `process.stderr.write`
  form the worker already uses; prefix it `[backfill-worker]` to match its siblings
  rather than reusing `index.ts`'s `[sidecar]` prefix.

### F13 — [LOW] Catalog cache writer is unbounded while its only reader caps at 4 MB

- **Verdict**: PARTIALLY CONFIRMED
- **Working-tree status**: `/Users/pt/cat-code/app/sidecar/sessionsCatalogCache.ts` and
  `/Users/pt/cat-code/app/main/sessionsCatalogBaseline.ts` are clean.
- **Cited location holds?**: Yes. `sessionsCatalogCache.ts:54-88` performs no size
  check; `sessionsCatalogBaseline.ts:34,54` rejects
  `> MAX_SESSIONS_CATALOG_CACHE_BYTES` (4 MiB) before parsing and returns `null` with
  no log. `resolveEntryTitle` (`sessionsCatalogDomain.ts:267-276`) has no length cap
  and `SESSIONS_CATALOG_ENRICH_LIMIT` is 600 (`:62`), raised from 50.
- **Reachable in production?**: Structurally yes, but far off. The live cache file is
  99,698 bytes (`~/.cat-code/desktop/sessions-catalog.json`), 42x under the reader's
  limit, matching the report's estimate.
- **Trigger**: A corpus whose 600 enriched rows carry long enough first prompts.
- **Counter-arguments considered**: The claim "the failure is permanent and produces
  no signal on either side" is false for the emit half. `emit()` throws at the same
  4 MiB (`sessionsCatalogWorker.ts:110-113`), and that throw is caught by
  `void main().catch(...)` at `:126-129`, which writes
  `[catalog-worker] fatal: catalog result exceeds record limit` to stderr and exits 1.
  The runner then hits `if (code !== 0) throw` (`sessionsCatalogRunner.ts:202-206`),
  which the driver logs as `[catalog-runner] refresh failed: …` every 30 s
  (`:280-287`). So the oversize case is *loud*, repeatedly. Only the cold-launch
  read is silent — and by then the catalog has already been failing audibly for the
  whole previous session.
- **True consequence**: A real writer/reader asymmetry worth closing, but it cannot
  produce the silent-forever failure described: crossing 4 MiB breaks the *live* path
  first and noisily.
- **Evidence**: `app/sidecar/sessionsCatalogWorker.ts:110-113,126-129`;
  `app/main/sessionsCatalogRunner.ts:202-206,280-287`;
  `app/main/sessionsCatalogBaseline.ts:34,52-56`;
  `ls -l ~/.cat-code/desktop/sessions-catalog.json` → 99,698 bytes.
- **Disposition**: Apply the writer half only. Have `writeSessionsCatalogCache` refuse
  (with a stderr line) anything over `MAX_SESSIONS_CATALOG_CACHE_BYTES` rather than
  writing an unreadable file — that is the asymmetry, and it is three lines. Skip the
  proposed `resolveEntryTitle` length cap: it changes displayed titles for a
  hypothetical corpus and the real risk is already bounded by the loud emit failure.
  Adding a stderr line to `readSessionsCatalogCache`'s oversize branch would also be
  cheap and is the better diagnostic than truncating titles.

### F14 — [LOW] `SessionCatalogEntry.sessionId` is an engine session id in a codebase where `SessionId` means the app-session address

- **Verdict**: CONFIRMED
- **Working-tree status**: `/Users/pt/cat-code/app/shared/protocol.ts` and
  `sessionsCatalogDomain.ts` are clean.
- **Cited location holds?**: Yes for the field.
  `protocol.ts:2495-2497` is `/** The transcript session id (matches a live row's
  \`engineSessionId\`). */ sessionId: string`, populated at
  `sessionsCatalogDomain.ts:189`. The `SessionId = string` alias is at
  **`protocol.ts:82`**, not `:2782` as the report states (`:2782` is inside
  `CatCodeBridge`). Minor mis-cite; the alias itself is exactly as described.
- **Reachable in production?**: The naming hazard is live. The join happens at
  `app/renderer/src/sessionsCatalogState.ts:318`
  (`candidate.sessionId === descriptor.engineSessionId`) and `:427`
  (`{ kind: 'history', engineSessionId: row.sessionId }`), which is exactly the
  translation point.
- **Trigger**: Not a runtime defect; a future edit swapping an app id for an engine id
  at the join type-checks clean, since the field is a bare `string` and `SessionId` is
  a `string` alias.
- **Counter-arguments considered**: I checked whether the field is actually typed
  `SessionId` (it is not — it is a plain `string`, so the confusion is with the
  *convention*, not a shared alias), and whether other wire members that mean the
  transcript key really do spell it out (they do:
  `transcriptBackfillWorker.ts:180`, `index.ts:219`, and
  `sessionsCatalogState.ts:427` all use `engineSessionId`). The finding stands on the
  convention argument, which is the one the two-id model depends on.
- **True consequence**: Review and maintenance hazard at the single place a catalog row
  is joined to a registry row. No current defect.
- **Evidence**: `app/shared/protocol.ts:82,2495-2497`;
  `app/sidecar/sessionsCatalogDomain.ts:189`;
  `app/renderer/src/sessionsCatalogState.ts:99,318,427`.
- **Disposition**: Apply, but as a plain rename rather than the proposed accept-both
  migration. This type crosses a host event and a disk cache that both have
  fail-closed `hasExactKeys` validators
  (`app/shared/sessionsCatalogWorker.ts:96-100`, `app/main/sessionsCatalogBaseline.ts`),
  so an "accept both, prefer the new one" window means widening a closed-vocabulary
  gate — the opposite of the posture those parsers were built for. The cache file is
  regenerated every 30 s and is `null`-safe on a parse miss, so a straight rename with
  the validators updated in the same commit costs at most one stale cold-launch read.

## Findings the original report missed

Two, both inside F1's own dirty hunk, both verified to the same bar and reported there
rather than duplicated here:

1. `isBypassPermissionsModeAvailable: true` is spread **over**
   `initializeToolPermissionContext`'s computed value
   (`src/utils/permissions/permissionSetup.ts:954-963`), so it defeats the settings key
   `permissions.disableBypassPermissionsMode: "disable"` and the Statsig gate
   `tengu_disable_bypass_permissions_mode` at the only point the sidecar reads them.
   This makes the comment's "the engine's own bypass killswitch remains authoritative"
   not just unwired but inverted.
2. It activates the second arm of `shouldBypassPermissions`
   (`src/utils/permissions/permissions.ts:1288-1289`): every desktop session in
   **plan** mode now returns `behavior: 'allow'` for every tool. This affects ordinary
   operators, not only a compromised renderer, and is the more urgent half of F1.
   (`01-synthesis-and-verification.md:290-292` names "plan-mode bypass" as a Tier-0
   item; A12 did not connect it to its own HIGH.)
