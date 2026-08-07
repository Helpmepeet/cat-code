# A13 — sidecar permission, run control, tasks, agent, memory domains

## Verdict

Nine of the ten domains are well-built read/write seams that genuinely call the engine's own
machinery rather than re-deriving it, with unusually good doc comments citing `src/…:line`.
The exception is the permission surface, and it is serious: the **uncommitted** change to
`app/sidecar/sessionController.ts:161-163` hardcodes `isBypassPermissionsModeAvailable: true`,
which — via `src/utils/permissions/permissions.ts:1286-1289` — makes **plan mode auto-allow
every tool call with no prompt** in every desktop session, and simultaneously discards the
correctly-computed value that `initializeToolPermissionContext` already returned. The comment
added alongside it ("the engine's own bypass killswitch remains authoritative") is false: no
bypass killswitch call exists anywhere in `app/`. The single most important thing to fix is that
line. Second-order: four of the ten domains pass the app-state store's raw `subscribe` straight
through, so every store mutation re-broadcasts four full snapshots, one of which does a disk read.

`permissionDomain.ts`'s "ZERO transport knowledge" header holds — it imports nothing from
`protocol.ts` except a type, touches no frame, no socket, no limit. It also owns no rule storage,
matching, or persistence; those stay engine-side, so the `persistPermissionUpdates` lost-update
race is not reachable from this module (detail in Not reviewed).

## Findings

### [HIGH] Hardcoded bypass-availability turns plan mode into a full permission bypass
- **Where**: `app/sidecar/sessionController.ts:161-163` (UNCOMMITTED — `git blame` reports "Not
  Committed Yet"), consumed at `src/utils/permissions/permissions.ts:1286-1289`
- **Type**: security
- **What**: `loadSidecarToolPermissionContext()` spreads the context returned by
  `initializeToolPermissionContext` and then overwrites `isBypassPermissionsModeAvailable` with a
  literal `true`. The engine's permission gate treats that flag as "this session was launched with
  `--dangerously-skip-permissions`" and short-circuits on it *in plan mode*:

  ```ts
  const shouldBypassPermissions =
    appState.toolPermissionContext.mode === 'bypassPermissions' ||
    (appState.toolPermissionContext.mode === 'plan' &&
      appState.toolPermissionContext.isBypassPermissionsModeAvailable)
  ```
- **Trigger / why it matters**: fresh desktop session → user clicks the Plan chip →
  `permission.setMode {mode:'plan'}` → `permissionDomain.setMode('plan')` sets `mode:'plan'` and
  leaves the flag `true`. The model then calls `Bash`. `hasPermissionsToUseToolInner` passes 1a
  (no deny rule), 1b (no ask rule), 1e/1f/1g (Bash returns a plain `ask`, not a `rule`-ask, not a
  `safetyCheck`), reaches 2a, and **returns `allow` with no permission request emitted**. Plan mode
  in this engine is enforced by a system-prompt reminder (`src/utils/attachments.ts:1269`), not by
  a hard tool gate, so nothing else stops it. This is strictly worse than the already-recorded
  server-side gate removal (`docs/migration/reviews/2026-08-07-status-truth-audit/lane-02-security-baseline.md`
  F1), which covers only the explicit `mode:'bypassPermissions'` path: here a user who never
  selects Bypass, and only picks Plan — the mode users pick *because* it is the safe one — gets
  silent full bypass.
  The same edit deletes the test that guarded exactly this. `app/sidecar/sessionController.test.ts:448`
  (also uncommitted) flips `expect(...isBypassPermissionsModeAvailable).toBe(false)` to `true` and
  removes the comment that named the reason: "§3 pin: no trusted desktop grant surface exists for
  bypass, so the loader must keep the engine-side availability backstop OFF."
- **Fix**: delete the override. `initializeToolPermissionContext` already computes the right value
  at `src/utils/permissions/permissionSetup.ts:962-964` (Statsig gate OR
  `permissions.disableBypassPermissionsMode === 'disable'`), so `return toolPermissionContext`
  unchanged. Making `bypassPermissions` selectable in the app is a separate concern and is already
  handled by the wire allowlist (`app/shared/protocol.ts:99-106`); it does not require lying about
  how the session was launched.

### [HIGH] The "engine's own bypass killswitch remains authoritative" claim is false in the sidecar
- **Where**: `app/sidecar/permissionDomain.ts:99-101` (UNCOMMITTED comment change),
  `app/sidecar/sessionController.ts:161-162` (UNCOMMITTED), `app/shared/protocol.ts:91-92` and
  `:2796-2797`
- **Type**: security
- **What**: three places now assert that the engine's bypass killswitch still gates bypass once the
  mode is applied. Nothing in `app/` calls it. `rg 'isBypassPermissionsModeDisabled|disableBypassPermissionsMode' app/`
  returns zero hits. `transitionPermissionMode` (`src/utils/permissions/permissionSetup.ts:597-646`),
  which `permissionDomain.setMode` calls, guards `auto` only and has no bypass branch at all. The
  two real killswitch paths are React-only: `useKickOffCheckAndDisableBypassPermissionsIfNeeded`
  (`src/utils/permissions/bypassPermissionsKillswitch.ts:57-69`, mounted from `src/screens/REPL.tsx:257`)
  and the settings watcher `applySettingsChange` (`src/utils/settings/applySettingsChange.ts:61-66`,
  wired only through `src/state/AppState.tsx`). The sidecar builds its store with plain
  `createStore(getDefaultAppState())` and mounts neither.
- **Trigger / why it matters**: an org sets managed `permissions.disableBypassPermissionsMode: "disable"`
  in `managed-settings.json`. The CLI honours it three ways (startup mode selection at
  `permissionSetup.ts:802`, context flag at `:962`, mount-time disable at `AppState.tsx:64`). The
  desktop honours it zero ways: the boundary schema accepts `bypassPermissions`
  (`sidecarServer.ts:3620-3624`), `handleSetMode` special-cases only `auto` (`:1644-1657`), and the
  domain applies it. Managed policy is silently inert on this surface, and the comments say the
  opposite, so a future reader will not go looking.
- **Fix**: guard it where the bridge already does. `src/hooks/useReplBridge.tsx:427-440` is the exact
  precedent, and `src/bridge/replBridge.ts:181-191` states the contract in words: the caller "must
  guard `auto` (isAutoModeGateEnabled) and `bypassPermissions` (isBypassPermissionsModeDisabled AND
  isBypassPermissionsModeAvailable) BEFORE calling transitionPermissionMode." Add that check next to
  the existing `auto` check in `handleSetMode`, then either fix the comments or drop them.

### [MED] Four domains pass the raw store subscription through, so every app-state mutation re-broadcasts four snapshots and reads a file
- **Where**: `app/sidecar/tasksDomain.ts:51-54`, `app/sidecar/goalDomain.ts:21-23`,
  `app/sidecar/agentModeDomain.ts:147-150`, `app/sidecar/leaseDomain.ts` (same shape); consumed at
  `app/sidecar/sidecarServer.ts:488-514`
- **Type**: correctness (resource)
- **What**: each is `subscribe(listener) { return appStateStore.subscribe(listener) }` — an
  unfiltered firehose. The server wires each one straight to a full snapshot broadcast with no
  change detection, no debounce, and (for agent-mode) no in-flight coalescing:
  `void this.broadcastAgentModeSnapshot()` at `:504-506`. `agentModeDomain.getSnapshot()` awaits
  `readPersistedAgentModeState()` → `readSessionState(sessionId)`
  (`src/agent-mode/sessionState.ts:662`), a fresh `.agent-mode-state.json` disk read + parse, on
  **every** notification, **per connection**.
- **Trigger / why it matters**: run one subagent. `appendMessageToLocalAgent`
  (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:242-247`) calls `setAppState` for every message the
  worker emits. Each one fires: one `.agent-mode-state.json` read + parse, plus four full snapshot
  builds each paying `prepareOutboundPayload` (structuredClone + JSON-safety walk + secretGuard
  sweep) and one frame per attached window. Three of the four snapshots are byte-identical to the
  one sent a millisecond earlier. `AppState.tasks` is never pruned (`src/state/AppStateStore.ts:500`
  is the only assignment), and `tasksSnapshot`'s `subagents` array (`tasksDomain.ts:73`) has no
  terminal-status filter, so the redundant payload grows monotonically with every subagent the
  session has ever spawned. Two domains in this same set already solved this and say why:
  `runControlsDomain.ts:398-410` ("stays silent through the flood of per-token store mutations
  during a turn") and `permissionDomain.ts:122-146` (reference compare). The other four did not.
- **Fix**: give each of the four the same treatment `runControlsDomain` has — a cheap signature over
  the slice it actually owns (`state.tasks` reference for tasks/agent-mode, `state.threadGoal`
  reference for goals) and re-emit only on change. Separately, add an in-flight/pending guard to
  `broadcastAgentModeSnapshot` mirroring `contextBreakdownInFlight` (`sidecarServer.ts:3037-3064`),
  since it is the only async one.

### [MED] `contextBreakdown.snapshot()` returning null on every error disarms the caller's 15-second cost floor
- **Where**: `app/sidecar/contextBreakdownDomain.ts:186-195`, caller at
  `app/sidecar/sidecarServer.ts:3003-3007` and `:3043-3048`
- **Type**: correctness (resource)
- **What**: the domain catches everything and returns null. The server's freshness floor is
  `if (this.contextBreakdownLast && age < CONTEXT_BREAKDOWN_MIN_INTERVAL_MS)`, and both
  `contextBreakdownLast` and `contextBreakdownComputedAt` are assigned **only after a non-null
  result** (`:3047-3048`). So the rate limiter is armed by success and never arms at all while the
  analyzer is failing — exactly when you want it armed.
- **Trigger / why it matters**: whatever makes `analyze()` throw, it throws at
  `contextBreakdownDomain.ts:107` (`deps.getMainLoopModel()`), which is the **last** argument
  evaluated. Everything before it has already run: `getLastSessionLog` + `loadFullLog` (a full
  transcript read off disk), `deserializeMessages` over the whole transcript,
  `getMessagesAfterCompactBoundary`, and `await microcompactMessages(apiView)`
  (`src/services/compact/microCompact.ts:253`, which can take the cached-microcompact path). All of
  that re-runs on every single `context-breakdown.request` — i.e. every popover open — with no
  floor, forever, because the floor can never arm. A user who opens the donut popover ten times in
  a minute pays ten full transcript loads.
  On the model question: reaching for the default main-loop model is legitimate — the breakdown's
  denominator is the model's context window and `analyzeContextUsage` needs it — but this domain is
  the only one in the set with no fallback ladder for it. `diagnosticsDomain.resolveSessionModel`
  (`diagnosticsDomain.ts:41-49`) prefers `state.mainLoopModelForSession` → `state.mainLoopModel` →
  `getMainLoopModel()` → null, and `buildRunControlsSnapshot` wraps the same call in `safe()`
  (`runControlsDomain.ts:429`). Here it is a bare call whose throw kills the whole snapshot.
- **Fix**: two independent changes. (a) In `sidecarServer.handleContextBreakdownRequest`, stamp
  `contextBreakdownComputedAt = Date.now()` on the failure path too (or track a separate
  `lastAttemptAt`), so a failing analyzer is rate-limited like a succeeding one. (b) Give the
  executor the same model ladder `diagnosticsDomain` uses — take `getMainLoopModel` from app-state
  first and only fall back to the engine resolver — so a session whose model is already pinned in
  the store never touches default-model resolution.

### [MED] `agentConfigDomain` re-implements the engine's MCP-requirement matching one line away from calling the engine's own copy
- **Where**: `app/sidecar/agentConfigDomain.ts:143-153` (local copy) vs
  `src/tools/AgentTool/loadAgentsDir.ts:229-242` (engine's `hasRequiredMcpServers`, imported at
  `agentConfigDomain.ts:3` and used at `:89`)
- **Type**: design (the §10 "duplicating engine machinery in `app/`" recurring mistake)
- **What**: `missingRequiredMcpServers` re-writes the engine's rule verbatim —
  `availableMcpServers.some(server => server.toLowerCase().includes(pattern.toLowerCase()))`. The
  same `buildAgentConfigSnapshot` call computes `missingMcpServers` from the copy (`:55`) and
  `available` from the engine's original (`:89`), 34 lines apart.
- **Trigger / why it matters**: change the engine's matcher (substring → exact, or glob) and
  `available` follows while `missingMcpServers` does not. The Agents page then renders an agent as
  available while listing servers as missing, or the reverse. Nothing fails; the page just lies.
- **Fix**: derive the missing list from the engine predicate — filter each pattern with
  `hasRequiredMcpServers({ ...agent, requiredMcpServers: [pattern] }, [...availableMcpServers])` —
  or export a `missingRequiredMcpServers` from `loadAgentsDir.ts` and delete the copy.

### [MED] The memory snapshot is a one-shot read that never refreshes, behind a `subscribe` that promises otherwise
- **Where**: `app/sidecar/memoryDomain.ts:37-57`
- **Type**: design
- **What**: the factory kicks off `readMemorySnapshotOnce` once and fires listeners exactly once,
  when it resolves. `subscribe()` therefore delivers at most one event for the entire session
  lifetime, but its presence in `SidecarMemoryDomain` (and the server's
  `this.memory.subscribe(() => this.broadcastMemorySnapshot())` at `sidecarServer.ts:493-497`) reads
  as a live seam. `diagnosticsDomain` has the same posture and documents it explicitly
  ("Read-only, spawn-time-frozen … the doctor/install checks run once at spawn, no live re-poll",
  `diagnosticsDomain.ts:16-18`) and correctly exposes **no** `subscribe`.
- **Trigger / why it matters**: unlike doctor checks, this data changes during a session. The
  agent writes auto-memory files and the user edits CLAUDE.md; neither reaches the Memory page until
  the window is closed and the session respawned. Worse, `getSnapshot()` returns `null` for both
  "still loading" and "the read failed" (its own doc comment at `:22` concedes the conflation), and
  `sendMemorySnapshot` bails on `!raw` (`sidecarServer.ts:2778-2781`), so after a failed read the
  page waits on its loading state permanently with no error and no retry. Only the stderr line at
  `memoryDomain.ts:117-121` records that anything went wrong.
- **Fix**: either drop `subscribe` and document the freeze like `diagnosticsDomain` does, or make it
  real — re-read on demand behind a freshness floor (the `contextBreakdown` pattern at
  `sidecarServer.ts:3003-3007` is already in the codebase). Separately, distinguish loading from
  failed so the page can say so.

### [MED] `agentModeDomain` swallows every persisted-state error with a bare `catch {}` and no log
- **Where**: `app/sidecar/agentModeDomain.ts:153-163`
- **Type**: quality (error handling)
- **What**: `readPersistedAgentModeState` catches everything and returns null with no output at all.
  `agentModeSnapshot` then emits `objective: ''`, `phase: 'planning'`, live workers only.
- **Trigger / why it matters**: a truncated or corrupt `.agent-mode-state.json` (a killed process
  mid-write) makes the Orchestrator page render a real agent-mode run as an empty planning session
  — byte-identical to the legitimate "this is not an agent-mode session" case the comment says it is
  degrading to. There is no way to tell them apart from inside or outside the process. The two peer
  domains that degrade the same way both write to stderr first (`memoryDomain.ts:117-121`,
  `diagnosticsDomain.ts:128-133`); this one does not.
- **Fix**: keep the degrade, add the stderr line those two already write, and skip it for the
  expected `ENOENT` (the non-agent-mode case) the way `memoryDomain.isMissingDirectory` does.

### [MED] `runWrite` treats "the executor did not throw" as success, but `setEffort`'s executor reports failure by return value
- **Where**: `app/sidecar/runControlsDomain.ts:237-256` (`runWrite`) and `:292-319` (`setEffort`),
  executor at `:145-156`, engine at `src/commands/effort/effort.tsx:114-139`
- **Type**: design
- **What**: `runWrite` returns `ok:true` unless `run()` throws. `executeEffort` never throws on a
  rejection — all three rejection paths (`Invalid argument`, `Effort controls are not supported by
  <model>`, `Effort <level> is not supported by <model>`) return a message with **no**
  `effortUpdate`, so `createRealRunControlExecutor.setEffort` skips the `store.setState` and returns
  the rejection text. The domain then reports `ok:true, changed:false` carrying the engine's
  rejection as if it were a confirmation. The renderer only toasts on `ok:false`
  (`app/renderer/src/verbAckResultState.ts:5-14`), so an engine-rejected effort is completely silent
  to the user.
  The control flow is also hard to follow: the `okMessage` argument handed to `runWrite` at `:311`
  is captured before `run()` reassigns the closure variable, so that argument is dead on the success
  path and `:318` re-applies the real value.
- **Trigger / why it matters**: the domain's own pre-validation (`:294-298`) currently masks this by
  duplicating `executeEffort`'s membership check against the same `getSupportedEffortLevels(current)`
  — which is itself the §10 duplication. Any divergence between the two (the
  `effort === currentSnapshot.effort.current` bypass at `:297` already skips the options list)
  becomes a silent no-op the user cannot see. The shape is wrong regardless of today's reachability.
- **Fix**: have the executor return `{ applied: boolean; message: string }` from
  `result.effortUpdate !== undefined` and let the domain map `applied:false` to `ok:false`. That also
  lets the duplicated membership check be deleted, since the engine's verdict becomes readable.

### [MED] Raw engine exception text is toasted to users
- **Where**: `app/sidecar/taskControlDomain.ts:96-102`, `app/sidecar/agentModeDomain.ts:134-142`,
  `app/sidecar/runControlsDomain.ts:245-256`, `:279-285`; rendered via
  `app/renderer/src/verbAckResultState.ts` → `App.tsx:1669`
- **Type**: convention (CLAUDE.md §7 "never render engineering notes")
- **What**: each non-`StopTaskError` / non-domain failure interpolates
  `error instanceof Error ? error.message : String(error)` into the `message` field that the
  renderer toasts verbatim. `runControlsDomain` additionally echoes renderer input:
  `Unsupported model: ${model}.` renders as `Unsupported model: null.` when the value is null.
- **Trigger / why it matters**: engine exception text is not written for end users — it carries
  paths, internal identifiers, and provider vocabulary. `taskControlDomain` gets this exactly right
  for the errors it anticipates (`stopTaskErrorMessage`, `:107-118`, maps codes to plain sentences
  and its comment says "never echo the raw error") and then defeats itself two lines earlier with
  the generic branch.
- **Fix**: apply `taskControlDomain`'s own rule to its fallback and to the other three: a fixed
  user sentence in `message`, and the raw error to `process.stderr` where the other domains already
  send theirs.

### [MED] The goal wire snapshot carries the terminal's `/goal` help text, which the desktop renders verbatim
- **Where**: `app/sidecar/goalDomain.ts:39` (`summary: formatThreadGoalSummary(goal)`), source
  `src/utils/threadGoal.ts:458-481`, rendered at `app/renderer/src/GoalsPage.tsx:80-82`
- **Type**: convention
- **What**: for an `active` goal, `formatThreadGoalSummary` appends
  `Use /goal pause, /goal resume, /goal clear, or /goal replace <objective>.` and
  `The agent will mark it complete with update_goal when finished.` The page prints the whole blob
  in a `<pre>` — directly under its own structured rendering of the same four facts
  (`GoalsPage.tsx:67-78` already shows objective, tokens used, token budget, time used).
- **Trigger / why it matters**: the user sees every number twice, the second time in terminal
  formatting, followed by instructions naming an internal tool (`update_goal`). This is the domain's
  choice, not the renderer's: `threadGoalSnapshot` puts a terminal-formatted string on a wire
  contract whose other fields are already structured.
- **Fix**: drop `summary` from the projection (every field it contains is already its own wire
  field) and let the page render what it needs. If a prose line is wanted, author it renderer-side
  from the structured fields.

### [LOW] `readPermissionDisplayFacts` guards one of its two engine reads, contradicting its own doc comment
- **Where**: `app/sidecar/permissionDomain.ts:46-59`
- **Type**: quality (error handling)
- **What**: the comment at `:40-44` says the function is not throw-free and must "degrade to
  'unavailable' instead" because "this runs on every app-state notification … so a raise here would
  take the session down over a display flag." The `try` covers only `isAutoModeGateEnabled()`;
  `shouldAllowManagedPermissionRulesOnly()` at `:56` sits outside it and reaches
  `getSettingsForSource('policySettings')` (`src/utils/settings/settings.ts:311-336`) — a cached
  read that misses after any settings write and then re-enters `getMdmSettings()` /
  `loadManagedFileSettings()`.
- **Trigger / why it matters**: this runs at `:130` and `:133`, i.e. inside the store's notify loop,
  which has no isolation: `src/state/store.ts:26` is `for (const listener of listeners) listener()`
  with no try. A throw there aborts the loop, so every listener registered after the permission one
  (goals, memory, tasks, agent-mode, leases, run-controls — all registered later at
  `sidecarServer.ts:488-523`) silently misses that state change, and the exception escapes
  `setState` into whatever engine code called it. I could not establish that `getSettingsForSource`
  actually throws (see Not reviewed), so this is graded on the mismatch between the stated contract
  and the code, not on a proven crash.
- **Fix**: move the closing brace — wrap both reads, defaulting `managedRulesOnly` to `true` (the
  restrictive value) on failure.

### [LOW] `as` casts on values that already have the right type, suppressing the drift tripwire
- **Where**: `app/sidecar/agentConfigDomain.ts:57`, `:87`; `app/sidecar/agentModeDomain.ts:204`
- **Type**: types
- **What**: `agent.source as AgentConfigSourceId` — but `AgentDefinition['source']` is
  `'built-in' | SettingSource | 'plugin'` (`loadAgentsDir.ts:137,148,156`) and `AgentConfigSourceId`
  is `'built-in' | 'plugin' | SettingSourceId` (`protocol.ts:832-835`), where `SettingSourceId`
  (`protocol.ts:682-687`) is the exact five members of `SETTING_SOURCES`
  (`src/utils/settings/constants.ts:7-24`). Identical. Same for
  `(persisted?.currentPhase ?? 'planning') as AgentModeRunPhase`: `currentPhase` is already typed
  `AgentModeRunPhase` at `src/agent-mode/sessionState.ts:48`.
- **Trigger / why it matters**: the casts are what would hide a real divergence. Add a sixth
  `SettingSource` engine-side and the wire type silently accepts it, while `sourceDisplayRank`
  (`agentConfigDomain.ts:155-172`) — an exhaustive switch with no `default` — returns `undefined`
  for it. `undefined - number` is `NaN`, and a comparator returning `NaN` gives
  implementation-defined ordering for the whole agent list. Without the cast, tsc catches the
  divergence at the snapshot boundary instead.
- **Fix**: delete all three casts. If tsc then complains, that is the finding.

### [LOW] Three near-identical write-result types and 52 copies of the same error-normalization expression
- **Where**: `RunControlSetResult` (`runControlsDomain.ts:80-85`), `AgentModeSetResult`
  (`agentModeDomain.ts:42-47`), `TaskStopResult` (`taskControlDomain.ts:29-32`); plus
  `error instanceof Error ? error.message : String(error)` × 52 across `app/sidecar/*.ts`
- **Type**: quality (duplication)
- **What**: `{ok, message, changed}` and `{ok, message}` are declared three times with three names
  and three doc comments all saying "the redacted outcome of a … write (no transport, no secret)".
  Every catch block re-derives the same error-to-string expression.
- **Trigger / why it matters**: no failure, but it is why the previous finding (raw engine text in
  toasts) is in four places instead of one — there is no single funnel where a redaction rule could
  be applied and enforced.
- **Fix**: one `SidecarWriteResult` type plus one `describeError(error)` helper in a shared
  `app/sidecar/` module; the redaction rule then has a home.

### [LOW] `taskControlDomain.stop` has no in-flight guard, so a double stop reports two successes
- **Where**: `app/sidecar/taskControlDomain.ts:78-103`; boundary at
  `app/sidecar/sidecarServer.ts:1894-1937` (`void this.handleTaskControlVerb(...)`, unserialized)
- **Type**: correctness
- **What**: `stopTask` (`src/tasks/stopTask.ts:63-81`) reads state, checks `status === 'running'`
  synchronously, then `await taskImpl.kill(...)`. Two overlapping calls both pass the check before
  either kill lands.
- **Trigger / why it matters**: a double-click on the worker Stop button sends two
  `task-control.stop` frames. Both resolve `ok:true` and the renderer toasts "Stopped worker …"
  twice. `killAsyncAgent` aborts an `AbortController`, so nothing corrupts — this is a UX and
  reasoning-about-the-seam defect, not data loss.
- **Fix**: a `Map<taskId, Promise>` of in-flight stops in the domain; a second call for the same id
  returns the first one's result.

### [LOW] `RunControlExecutor.activateProvider` is optional on an interface whose domain method is required
- **Where**: `app/sidecar/runControlsDomain.ts:101-102` (`activateProvider?`) vs `:199` (required)
  and `:357-366`
- **Type**: types
- **What**: because the executor field is optional, the domain has to `throw new Error('Provider
  activation is unavailable.')` inside `runWrite` purely so the catch can turn it into an
  `ok:false`. `createRealRunControlExecutor` always provides it; only a test fake might not.
- **Fix**: make it required and give the test fakes a no-op, or return the `ok:false` directly
  instead of routing it through a throw.

### [LOW] `permissionDomain.test.ts` has no test that a bypass request can be refused
- **Where**: `app/sidecar/permissionDomain.test.ts:1-133`
- **Type**: quality (test gap, named branch)
- **What**: the file tests `acceptEdits`, the plan-exit stash clear, the classifier gate (both
  directions, including a real subprocess probe), the no-op reference preservation, and the
  subscription filter. There is no case for `setMode('bypassPermissions')` against a context where
  bypass is unavailable — because no such branch exists any more.
- **Trigger / why it matters**: this is the coverage that would have failed when the two HIGH
  findings above were introduced. `sidecarServer.test.ts:3883` ("C2 — bypassPermissions is available
  without a launch flag") now asserts the permissive behaviour, so the suite actively blesses it.
- **Fix**: when the bypass guard is restored, add the negative case here and flip
  `sidecarServer.test.ts:3883` back to a rejection assertion.

## What is good here

- `runControlsDomain`'s change-detected subscription (`:398-410`) and its `safe()` wrapper
  (`:412-418`) around every engine read in `buildRunControlsSnapshot` are the right pattern for a
  display snapshot built from twelve independent engine calls: one failing resolver costs one field,
  never the frame. The other four store-subscribing domains should copy the first half.
- `tasksDomain.hasLiveWork` (`:20-28,41-50`) deliberately reads the RAW `AppState.tasks` rather
  than `getSnapshot()`, with a comment explaining that the display filter would hide a foregrounded
  worker and parking over it would kill a live turn. That is the correct instinct — a safety gate
  must not share a code path with a display filter — and it is documented at the point of decision.
- `contextBreakdownDomain`'s header comment on why it does **not** call `loadConversationForResume`
  (`:80-90`) is the best comment in the set: it names the three side effects (SessionStart hooks,
  the skill-listing latch, plan/file-history copies), cites the engine lines, and explains why the
  backfill worker's `CLAUDE_CODE_SIMPLE=1` mitigation is unavailable in a live process.
- `memoryDomain.countFiles` (`:158-186`) distinguishing 0 (directory absent, a real state) from
  null (unreadable) and explaining why the error must not escape to the snapshot level is the
  display-degrades-gracefully rule applied at exactly the right granularity.
- `agentConfigDomain` answers the "does it reimplement the loader" question correctly: it consumes
  `AgentDefinitionsResult` from the engine's real `getAgentDefinitionsWithOverrides(cwd)`
  (`sessionController.ts:196`, memoized at `src/tools/AgentTool/loadAgentsDir.ts:296`) and uses the
  engine's `resolveAgentOverrides` (`src/tools/AgentTool/agentDisplay.ts:46`) and
  `hasRequiredMcpServers`. Only the one matching helper (MED above) is re-derived.
- T4 is satisfied, though not in `goalDomain.ts` — that file is a pure read seam with no inbound
  surface. The validation lives at `sidecarServer.ts:1433-1457`, which `safeParse`s
  `options.goalSnapshot` through the engine's own `parseThreadGoal`
  (`src/utils/threadGoal.ts:770-806`), rejects a present-but-invalid snapshot, and additionally
  fails closed when one rides a mid-turn submit (`:1490-1509`) rather than dropping it silently.

## Not reviewed / uncertain

- **Whether `getSettingsForSource('policySettings')` can actually throw.** The LOW finding on
  `readPermissionDisplayFacts` is graded on the code-vs-comment mismatch, not a proven crash. I
  traced to `loadManagedFileSettings` (`src/utils/settings/settings.ts:76-110`) where
  `parseSettingsFile` at `:84` is outside the `try` that guards the drop-in directory read, but did
  not verify whether `parseSettingsFile` itself is total. Reading that function would settle it.
- **Whether the observed `contextBreakdown` throw reproduces outside the test harness.** The error
  quoted in my brief ("ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required") comes from
  `src/utils/auth.ts:300`, which is inside a branch gated on
  `isEnvTruthy(process.env.CI) || process.env.NODE_ENV === 'test'` (`:284`). So `bun test app/`
  reaches it and a real app run does not take that path. For a genuinely Codex-only user
  `getDefaultMainLoopModelSetting` returns `gpt56terra` at its first branch
  (`src/utils/model/model.ts:310-312`) via `isCodexSubscriber()`, which needs no Anthropic auth. I
  could **not** confirm "fails every time for a Codex-only user"; the MED finding above stands on
  the floor-disarm mechanism, which is true for any throw. Reproducing with a real Codex-only
  profile and `NODE_ENV` unset would settle the live-user half.
- **`permissionDomain` owns no rule storage or persistence**, so the documented
  `persistPermissionUpdates` lost-update race is not reachable from this module. Always-allow is
  persisted engine-side (`src/utils/permissions/PermissionUpdate.ts:367-371`, a plain loop with no
  read-merge and no lock) after the sidecar re-attaches the engine's own suggestion objects. Two
  desktop sessions in the same cwd granting always-allow concurrently is therefore still a real
  lost-update, but the fix belongs in the engine function, not in this domain. This matches the
  P3-5a finding already flagged as a P3-8 rider (commit `9483a00`), so I have not re-derived it.
- **`sessionController.ts:600-603`** turns an `ok:false` from `runControls.activateProvider` into a
  `throw`, which `accountsDomain`'s login flow catches at `:689-700` and reports to the user as a
  sign-in error even though `login.persist()` already succeeded at `:677`. Reachability depends on
  `isSidecarFirstRunEligible()` (`accountsDomain.ts:585-586`), which I did not open — if it is false
  once a turn has been taken, `pendingProviderActivation` is null and the branch is unreachable.
  Both files are outside my scope and `sessionController.ts` is dirty; flagging for whoever owns the
  accounts lane.
- `leaseDomain.ts` shares the pass-through `subscribe` shape and is named in the MED finding above,
  but I did not otherwise review it (not in scope).
