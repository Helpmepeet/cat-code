# A13 adversarial validation: sidecar permission, run control, tasks, agent, memory domains

> **Verification provenance:** Claude Opus 5, high effort. Source review plus five
> standalone scratch scripts that import the real engine and sidecar modules under
> `bun --feature=TRANSCRIPT_CLASSIFIER` (the same flag `app/package.json:10` and
> `app/main/mainDecisions.ts:42` launch the sidecar with). No GUI, no desktop app
> launch, no test suite run, no repo file edited. Scratch scripts live in
> `/private/tmp/claude-501/-Users-pt-cat-code/cdbe5dee-58e0-41f0-8421-b6cd23d30457/scratchpad/v13/`.
> Branch `migration` at `a17e5e9`.

## Overall verdict

The original report is substantially right on the thing that matters and loose on
several supporting details. Of 16 findings, 9 are confirmed, 4 have a valid core
that is narrower or mis-located than claimed, 2 are overstated to the point of
having no reachable production consequence, and 1 is invalid. **F1 is the finding
that deserves action, and it is worse than the report argued**: I reproduced it end
to end with the engine's real `BashTool` and `FileWriteTool` through the exact
`createAppRuntimeCanUseTool` the sidecar wires, with a managed
`disableBypassPermissionsMode: "disable"` policy in force. Plan mode returns
`allow` for `curl … | sh` and for a file write, and the renderer permission handler
is never invoked. Against that, several of the MED/LOW findings rest on claims I
could refute outright: the double-stop race does not exist (proved), the
contextBreakdown throw site cannot throw in production (proved), `AppState.tasks`
*is* pruned, and `getSettingsForSource('policySettings')` cannot throw.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Hardcoded bypass availability makes plan mode a full bypass | **CONFIRMED** | Reproduced with real `BashTool`/`FileWriteTool`: `allow`, no prompt, managed policy discarded |
| F2 | HIGH | "engine's own bypass killswitch remains authoritative" is false | **PARTIALLY CONFIRMED** | Core proved, but a killswitch DOES exist as a plain importable function; "React-only" is wrong |
| F3 | MED | Four domains pass the raw store subscription through | **PARTIALLY CONFIRMED** | Fan-out real; the stated trigger is REPL-only and `AppState.tasks` IS pruned |
| F4 | MED | `contextBreakdown` null disarms the 15 s floor | **OVERSTATED** | `getMainLoopModel()` proved not to throw in production; reachable null costs 0.1 ms |
| F5 | MED | `agentConfigDomain` re-implements the MCP matcher | **CONFIRMED** | Verbatim duplicate 34 lines from the engine call; latent because `availableMcpServers` is `[]` |
| F6 | MED | Memory snapshot is a one-shot behind a `subscribe` | **CONFIRMED** | Listeners fire exactly once, ever; null conflates loading and failed |
| F7 | MED | `agentModeDomain` bare `catch {}` with no log | **PARTIALLY CONFIRMED** | Outcome real but produced engine-side; the domain's catch never sees its own trigger |
| F8 | MED | `runWrite` reads no-throw as success; `setEffort` returns by value | **CONFIRMED** | Engine rejection text ships as `ok:true`, renderer only toasts on `ok:false` |
| F9 | MED | Raw engine exception text is toasted | **PARTIALLY CONFIRMED** | Primary claim holds; the `Unsupported model: null.` example is unreachable |
| F10 | MED | Goal snapshot carries the terminal `/goal` help text | **CONFIRMED** | `GoalsPage.tsx:80-82` prints it verbatim under the same four facts |
| F11 | LOW | `readPermissionDisplayFacts` guards one of two reads | **OVERSTATED** | The unguarded call cannot throw; settles the report's own open question |
| F12 | LOW | Redundant `as` casts suppress the drift tripwire | **CONFIRMED** | All three source unions verified identical |
| F13 | LOW | Three write-result types, 52 error-normalization copies | **CONFIRMED** | Count is exactly 52 |
| F14 | LOW | Double stop reports two successes | **INVALID** | Proved: second call returns `ok:false`, "That task has already finished." |
| F15 | LOW | `activateProvider?` optional on a required domain method | **CONFIRMED** | Throw exists purely to be re-caught |
| F16 | LOW | No test that a bypass request can be refused | **CONFIRMED** | 6 tests, none negative; `sidecarServer.test.ts:3883` blesses the permissive path |

Tally: **CONFIRMED 9 · PARTIALLY CONFIRMED 4 · OVERSTATED 2 · INVALID 1 · DUPLICATE 0 · UNPROVEN 0**

## Working-tree state

Every file in scope is branch-new, so `git blame` against `main` proves nothing.
What matters is which are dirty right now (another session is mid-edit):

| File | Dirty | Note |
|---|---|---|
| `app/sidecar/sessionController.ts` | **yes** | Carries the F1 change |
| `app/sidecar/permissionDomain.ts` | **yes** | Carries the F2 comment change |
| `app/sidecar/sessionController.test.ts` | **yes** | Carries the F1 test flip |
| `app/renderer/src/PermissionModeChip.tsx` | **yes** | Same change set: bypass gating removed from the picker |
| `app/renderer/src/PermissionRulesEditor.tsx`, `ComposerActionsBar.tsx` | yes | Same wave, not load-bearing here |
| `app/shared/protocol.ts` | no | The two killswitch comments are **committed** (`24dcf3e`, 2026-08-07) |
| `app/sidecar/sidecarServer.test.ts` | no | The permissive C2 test is committed |
| `src/utils/effort.ts` (+35), `src/utils/model/modelOptions.ts` (+7/-9) | **yes** | Engine files another session owns; touched by F8/F9 reasoning, not by me |

The report tagged the sidecar changes UNCOMMITTED and left `protocol.ts` untagged.
That is accurate. The renderer half of the same change set (`PermissionModeChip.tsx`)
is dirty too and the report did not mention it (see "Findings the original report
missed").

## Per finding

### F1 — [HIGH] Hardcoded bypass-availability turns plan mode into a full permission bypass

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `app/sidecar/sessionController.ts:159-164` returns
  `{...toolPermissionContext, isBypassPermissionsModeAvailable: true}`. The consumer is
  `src/utils/permissions/permissions.ts:1286-1289`, exactly as quoted. (The
  `initializeToolPermissionContext` computation the report cites as
  `permissionSetup.ts:962-964` is really `:956-965`; trivial drift.)
- **Reachable in production?**: Yes, and I established each leg rather than reading it.
  - The store is the one the engine reads: `sessionController.ts:279-283` seeds
    `createStore({...getDefaultAppState(), toolPermissionContext})` with the loader's
    return value, and `getAppState: appStateStore.getState` is handed to
    `createQueryEngineAppSessionConfigFromSetup` (`:373`), which passes it through
    unchanged (`src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts:90-102`).
    `permissions.ts:1282` calls that same `context.getAppState()`.
  - **The sidecar does not intercept first.** `createQueryEngineAppSession.ts:30-34`
    wires `canUseTool: createAppRuntimeCanUseTool({...})`, whose
    `baseCanUseTool` defaults to the engine's `hasPermissionsToUseTool`
    (`src/app-runtime/appRuntimeCanUseTool.ts:28`). The renderer permission handler is
    consulted **only after** that returns, and **only** when the behavior is `ask`
    (`:49-59`). An `allow` short-circuits before any frame is minted. The sidecar
    supplies no `config.canUseTool` override (`rg 'canUseTool' app/` returns only doc
    comments).
  - No env, `NODE_ENV`, `CI`, or feature gate stands between the flag and the branch;
    `feature('TRANSCRIPT_CLASSIFIER')` is not involved at `permissions.ts:1286`.
  - `transitionPermissionMode` (`permissionSetup.ts:597-646`) and
    `prepareContextForPlanMode` (`:1501-1532`) both spread the context, so the `true`
    survives the plan transition.
- **Trigger**: Proven twice, with scripts.
  1. `bypass-probe.ts` through `createAppRuntimeCanUseTool` with a `passthrough` tool:
     ```
     mode=plan avail=true  -> behavior=allow reason={"type":"mode","mode":"plan"} promptHandlerCalled=false
     mode=plan avail=false -> behavior=deny  ... promptHandlerCalled=true
     ```
  2. `real-bash-probe.ts` with the engine's real tools:
     ```
     Bash(curl|sh)      mode=plan avail=true  -> allow prompted=false
     Bash(curl|sh)      mode=plan avail=false -> deny  prompted=true
     Write(/tmp/v13.txt) mode=plan avail=true  -> allow prompted=false
     Write(/tmp/v13.txt) mode=plan avail=false -> deny  prompted=true
     ```
  3. `e2e-probe.ts`, the whole real chain with a managed policy in force:
     ```
     engine initializeToolPermissionContext.isBypassPermissionsModeAvailable = false
     sidecar loadSidecarToolPermissionContext.isBypassPermissionsModeAvailable = true | mode = auto
     after setMode(plan): mode = plan | avail = true
     PLAN MODE result: allow {"type":"mode","mode":"plan"} | renderer prompt handler called = false
     after setMode(bypassPermissions): mode = bypassPermissions
     ```
- **Counter-arguments considered**:
  - *Does plan mode have a hard tool gate elsewhere?* No. The only plan-mode branches
    in `src/` that could gate a tool are `filesystem.ts:1466-1468` (a **suggestion**
    builder, not a gate), `attachments.ts:1269` (the plan-**exit** attachment, not a
    reminder as the report implies), and `agentToolUtils.ts:127-133` (which *widens*
    the tool list in plan mode). Plan mode is prompt-enforced plus permission-prompt
    enforced; remove the prompt and nothing else stops the call.
  - *Does the sidecar re-check at the boundary?* No. `handleSetMode`
    (`sidecarServer.ts:1639-1691`) special-cases `auto` only; `plan` and
    `bypassPermissions` pass straight through to the domain.
  - *Do deny/ask rules still hold?* Yes, and this is the one real narrowing: steps
    1a (tool deny rule), 1b (tool ask rule), 1e (`requiresUserInteraction`), 1f
    (`rule`-typed content ask), and 1g (`safetyCheck`) all return before 2a. The
    report already states this correctly. So "every tool call" means every tool call
    that would otherwise have produced a plain prompt, which is the ordinary case for
    `Bash` and file writes.
- **True consequence**: In every desktop session, selecting the Plan chip silently
  converts the session into `--dangerously-skip-permissions`. Arbitrary shell and
  arbitrary file writes execute with no permission frame reaching the renderer, and
  no prompt for the user to refuse. Managed org policy
  (`permissions.disableBypassPermissionsMode: "disable"`) is computed correctly by the
  engine and then discarded one line later.
- **Evidence**: `sessionController.ts:159-164`, `permissions.ts:1286-1299`,
  `appRuntimeCanUseTool.ts:26-59`, plus the three scratch runs above.
- **Disposition**: Apply the report's fix, `return toolPermissionContext` unchanged.
  It is correct and minimal. Two additions the report did not make:
  (a) also revert `app/sidecar/sessionController.test.ts:448` to
  `expect(...).toBe(false)` and restore the §3-pin comment, otherwise the suite
  re-blesses the defect (this is F16's other half);
  (b) if `bypassPermissions` is genuinely meant to be selectable from the picker,
  that is a `handleSetMode` guard (F2's fix), not a lie in the launch context. The two
  are independent: making bypass selectable does not require claiming the session was
  launched with the bypass flag, and claiming it is what breaks plan mode.

### F2 — [HIGH] The "engine's own bypass killswitch remains authoritative" claim is false in the sidecar

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes for all four. `permissionDomain.ts:99-101`,
  `sessionController.ts:161-162`, `protocol.ts:91-92` and `:2796-2797` all carry the
  claim. `rg 'isBypassPermissionsModeDisabled|disableBypassPermissionsMode' app/`
  returns zero hits, and `handleSetMode` guards `auto` only.
- **Reachable in production?**: Yes, and I proved the consequence rather than inferring
  it. With `permissions.disableBypassPermissionsMode: "disable"` in settings,
  `initializeToolPermissionContext` returns `false` and
  `loadSidecarToolPermissionContext` returns `true` (`e2e-probe.ts` output above), and
  `setMode('bypassPermissions')` applies with no rejection.
- **Trigger**: Managed settings set the policy; a desktop user picks Bypass (or Plan)
  from the mode picker; the policy has no effect.
- **Counter-arguments considered** — this is where the report is wrong:
  - **A killswitch does exist, and it is not React-only.** I searched broadly
    (`rg 'killswitch|Killswitch|KILLSWITCH' src/ app/`).
    `src/utils/permissions/bypassPermissionsKillswitch.ts:19` exports
    `checkAndDisableBypassPermissionsIfNeeded(toolPermissionContext, setAppState)` as a
    **plain async function** with no React dependency in its body, and
    `permissionSetup.ts:1410` exports `isBypassPermissionsModeDisabled()` as a plain
    sync predicate. The two hooks the report names are thin wrappers; a third caller,
    `src/commands/login/login.tsx:56-58`, calls the plain function directly. So the
    report's framing ("the two real killswitch paths are React-only", implying the
    sidecar would need a React port) is refuted, and the true statement is narrower and
    more actionable: **the killswitch is a two-line import away and is simply never
    called in `app/`.**
  - **"The desktop honours it zero ways" is slightly overstated.** The sidecar calls
    `initialPermissionModeFromCLI` (`sessionController.ts:132`), which does consult
    `disableBypassPermissionsMode` at `permissionSetup.ts:802-816`. That leg is nearly
    inert (with `dangerouslySkipPermissions: undefined`, `bypassPermissions` only enters
    `orderedModes` via a settings `defaultMode`), but it is not zero.
  - *Could the flag be re-disabled later by something else?* No. Nothing in the
    sidecar mounts `AppState.tsx` or `applySettingsChange`, and
    `transitionPermissionMode` has no bypass branch. Once `true`, it stays `true` for
    the process lifetime.
- **True consequence**: Managed bypass policy is inert on the desktop surface, and
  three comments assert the opposite, so a future reader is actively misdirected. The
  discard in F1 is what makes it inert; the missing killswitch call is what leaves it
  unrecoverable mid-session.
- **Evidence**: `bypassPermissionsKillswitch.ts:19-70`, `permissionSetup.ts:802-816`,
  `:956-965`, `:1410`, `sidecarServer.ts:1639-1691`, `e2e-probe.ts` output.
- **Disposition**: The report's fix (add the `bypassPermissions` guard next to the
  existing `auto` guard in `handleSetMode`, mirroring
  `src/hooks/useReplBridge.tsx:427-440` and the contract stated at
  `src/bridge/replBridge.ts:181-191`) is correct. Add one thing it missed: call
  `checkAndDisableBypassPermissionsIfNeeded(store.getState().toolPermissionContext,
  store.setState)` once during sidecar session construction. It is a plain function,
  it is idempotent by its own `bypassPermissionsCheckRan` latch, and it is the only way
  the Statsig leg of the killswitch ever fires in this process. Then fix or drop the
  three comments. Do **not** treat this as blocked on a React port.

### F3 — [MED] Four domains pass the raw store subscription through, so every app-state mutation re-broadcasts four snapshots and reads a file

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `tasksDomain.ts:51-53`, `goalDomain.ts:21-23`,
  `agentModeDomain.ts:146-149`, and `leaseDomain.ts:135-137` are all
  `subscribe(listener) { return appStateStore.subscribe(listener) }`. The server wires
  each to a full broadcast with no change detection at `sidecarServer.ts:488-514`, and
  `broadcastAgentModeSnapshot` (`:2880-2886`) has no in-flight guard and awaits
  `sendAgentModeSnapshot` **per connection**, each of which calls
  `agentMode.getSnapshot()` → `readPersistedAgentModeState()` →
  `readSessionState(sessionId)` → a fresh `readFile` + `JSON.parse`
  (`src/agent-mode/sessionState.ts:206-220, 661`).
- **Reachable in production?**: The amplification is real. Two of the report's
  supporting claims are not:
  - **The stated trigger is wrong.** `appendMessageToLocalAgent`
    (`LocalAgentTask.tsx:242-247`) has exactly one non-test caller in the repo:
    `src/screens/REPL.tsx:4122` (plus `appendLocalAgentSystemMessage` at `:4133`,
    `:4141`). `REPL.tsx` is the Ink TUI and never runs in the sidecar. So "run one
    subagent → `setAppState` for every message the worker emits" does not describe the
    desktop at all. The real high-frequency mutators on the sidecar path are the task
    framework's own `updateTaskState` calls (e.g. `LocalShellTask.tsx:335` on shell
    result, `LocalAgentTask.tsx:305,370,535,563`), which fire on task lifecycle
    transitions, not per token.
  - **"`AppState.tasks` is never pruned" is false.** `src/utils/task/framework.ts:120-140`
    (`evictTerminalTask`) and `:232-245` (the batch path in
    `applyTaskOffsetsAndEvictions`) both `delete` task entries once the task is
    terminal, `notified`, and past the 30 s `PANEL_GRACE_MS`. That batch path is driven
    engine-side from `src/utils/attachments.ts:3456-3462`, which runs on every turn in
    the sidecar, and `enqueueAgentNotification` (`LocalAgentTask.tsx:273-315`) sets
    `notified: true` on every subagent completion. So the `subagents` payload does not
    grow monotonically; it drains ~30 s after each worker finishes.
- **Trigger**: Any store mutation during a session with background tasks. Each one
  costs four `prepareOutboundPayload` passes (structuredClone + JSON-safety walk +
  `secretGuard`) plus one `.agent-mode-state.json` read and parse per attached
  connection. Three of the four payloads are typically byte-identical to the previous
  send.
- **Counter-arguments considered**:
  - `src/state/store.ts:23` short-circuits on `Object.is(next, prev)`, so genuinely
    no-op updaters do not notify. That removes a class of spurious wakeups the report
    implicitly counted.
  - `runControlsDomain.ts:398-410` and `permissionDomain.ts:122-146` really do solve
    this, so the pattern to copy exists in-tree. That part of the report is right.
  - I did **not** measure the actual store-mutation rate during a live turn. The
    `runControlsDomain` comment asserts "the flood of per-token store mutations", but
    the only `setAppState` calls I found in `src/QueryEngine.ts` are at `:408`, `:417`,
    `:556`, `:764`, none obviously per-token. Severity below MED is plausible for a
    session with no background tasks.
- **True consequence**: Redundant fan-out plus a per-notification, per-connection disk
  read and parse. Real waste, bounded by task lifecycle events rather than by token
  streaming, and not unbounded in payload size.
- **Evidence**: file:line above; `rg 'appendMessageToLocalAgent' src/` (3 call sites,
  all `REPL.tsx`); `framework.ts:137` `const { [taskId]: _, ...remainingTasks }` and
  `:243` `delete newTasks[id]`.
- **Disposition**: Apply the report's fix, but reorder it. The **in-flight guard on
  `broadcastAgentModeSnapshot`** is the part worth doing first and on its own: it is the
  only async broadcast, the only one doing I/O, and `contextBreakdownInFlight`
  (`sidecarServer.ts:3037-3064`) is a copy-paste template. The four signature filters
  are a cheaper win than the report implies now that monotonic growth is off the table;
  do them, but as tidy-up, not as a resource fix.

### F4 — [MED] `contextBreakdown.snapshot()` returning null on every error disarms the caller's 15-second cost floor

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Yes. `contextBreakdownDomain.ts:186-195` catches
  everything and returns null. `sidecarServer.ts:3003-3006` is the floor check;
  `:3047-3048` assigns `contextBreakdownLast` / `contextBreakdownComputedAt` only after
  the `if (!raw) return` at `:3045-3046`. The mechanism is exactly as described: **the
  floor is armed by success and never arms while the analyzer returns null.**
- **Reachable in production?**: The mechanism yes, the claimed trigger no.
  - **The named throw site cannot throw in production.** The report says the throw is
    at `contextBreakdownDomain.ts:107`, `deps.getMainLoopModel()`. I ran
    `model-throw-probe.ts` in production shape (`NODE_ENV` deleted, `CI` deleted,
    `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` deleted, `CLAUDE_CONFIG_DIR`
    pointed at an empty temp dir so there are no credentials at all):
    ```
    NODE_ENV= undefined CI= undefined
    getMainLoopModel() = claude-sonnet-5
    ```
    It does not throw, for a Codex-only user or for anyone else. The report's own
    "Not reviewed" note had this half-right (`auth.ts:284` gates the throw behind
    `CI || NODE_ENV === 'test'`); the probe settles it for the whole resolver, not just
    that one branch. **This resolves the disagreement in the brief: the earlier claim
    that it fails for every Codex-only user is refuted, and so is the weaker
    "whatever makes `analyze()` throw, throws here".**
  - **The token-counting path cannot throw either.**
    `analyzeContext.ts:83-115` (`countTokensWithFallback`) wraps both the API call and
    the haiku fallback in `try/catch` and returns `null`, and `countTokensForDisplay`
    (`:136-145`) then falls back to a pure local estimator. The obvious network-failure
    candidate is already handled.
  - **The reachable production null is `if (!log) return null`** at
    `contextBreakdownDomain.ts:92`, which fires for every desktop session before its
    first completed turn. I measured its cost (`null-path-cost.ts`):
    ```
    fresh id -> log=null in 2.6ms
    fresh id -> log=null in 0.1ms
    fresh id -> log=null in 0.1ms
    ```
    That is not "a full transcript load"; `loadSessionFile` on a session with no
    transcript is a missing-file read.
- **Trigger**: A pre-first-turn session where every attach (`sidecarServer.ts:644`) and
  every popover open re-runs a sub-millisecond null. To get the expensive version you
  need a session that *has* a transcript and whose `analyzeContextUsage` throws, and I
  could not construct one.
- **Counter-arguments considered**:
  - **`broadcastContextBreakdown` already coalesces.** `sidecarServer.ts:3037-3044`
    sets `contextBreakdownPending` instead of starting a second analysis. So "ten opens
    in a minute pays ten full transcript loads" is only true if the opens are strictly
    sequential (each after the previous completed); overlapping opens collapse to at
    most two. The report itself cites this guard in F3 and still made the claim in F4.
  - There *are* unguarded `await`s that could in principle reject:
    `analyzeContext.ts:1081-1101` is a seven-way `Promise.all` (`countSystemTokens`,
    `countMemoryFileTokens`, `countBuiltInToolTokens`, …) and any rejection propagates.
    I did not find a concrete production rejection in them, and I did not run the real
    executor against a live transcript because that would exercise real credentials.
- **True consequence**: A genuine latent robustness gap (a failing analyzer is not rate
  limited), with no demonstrated production trigger and a measured cost of ~0.1 ms for
  the trigger that *is* reachable. It is a hardening item, not a cost defect.
- **Evidence**: probes above; `analyzeContext.ts:83-115,136-145,1081-1101`;
  `sidecarServer.ts:3003-3006,3030-3064`; `sessionStorage.ts:4669-4688`.
- **Disposition**: Do the report's fix (a), stamping a `lastAttemptAt` on the failure
  path, as one-line defensive hardening. **Skip fix (b)** as written: the model ladder
  it proposes solves a throw I proved does not happen, and it would change *which*
  model the denominator is computed from (`state.mainLoopModel` is the raw setting;
  `getMainLoopModel()` is the resolved one that `/context` uses), so it risks the exact
  `/context`-vs-popover divergence the domain's header comment exists to prevent.
  Downgrade the finding to LOW.

### F5 — [MED] `agentConfigDomain` re-implements the engine's MCP-requirement matching one line away from calling the engine's own copy

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `agentConfigDomain.ts:143-153` is
  `(agent.requiredMcpServers ?? []).filter(pattern => !availableMcpServers.some(server
  => server.toLowerCase().includes(pattern.toLowerCase())))`, which is
  `hasRequiredMcpServers` (`loadAgentsDir.ts:229-242`) inverted, verbatim, including
  the case-folding and the `includes` substring semantics. `missingMcpServers` uses the
  copy at `:55`; `available` uses the engine original at `:89`.
- **Reachable in production?**: The duplication is present in shipped code. The
  divergence it enables is not yet observable, for a reason the report did not state:
  `sessionController.ts` hardcodes `const availableMcpServers: string[] = []`, so both
  the copy and the engine call see an empty list and agree by construction today.
- **Trigger**: Someone changes the engine matcher (substring to exact, or glob) after
  MCP is wired into the sidecar. `available` follows, `missingMcpServers` does not.
- **Counter-arguments considered**: Whether the copy differs in a way that already
  diverges (it does not, character for character); whether `available` could be
  computed from the copy instead (it is not). No guard prevents the future divergence.
- **True consequence**: Latent display inconsistency on the Agents page. Nothing fails
  today. This is a §10 design finding, correctly typed as such by the report.
- **Evidence**: `agentConfigDomain.ts:55,89,143-153`; `loadAgentsDir.ts:229-242`;
  `sessionController.ts` `availableMcpServers` initializer.
- **Disposition**: The report's fix is right and I would take the second half of it
  (export a `missingRequiredMcpServers` from `loadAgentsDir.ts` and delete the copy)
  rather than the first (calling `hasRequiredMcpServers` once per pattern with a
  synthesized agent object is O(n) allocations and obscures intent). Severity LOW while
  `availableMcpServers` is `[]`.

### F6 — [MED] The memory snapshot is a one-shot read that never refreshes, behind a `subscribe` that promises otherwise

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `memoryDomain.ts:36-56`: the factory kicks off
  `readMemorySnapshotOnce(agents)` once and fires every registered listener exactly once
  when it resolves. There is no re-read path.
- **Reachable in production?**: Yes. `sidecarServer.ts:493-497` wires
  `this.memory.subscribe(() => this.broadcastMemorySnapshot())`, which reads as a live
  seam and is not one.
- **Trigger**: Auto-memory files written by the agent, or a user edit to CLAUDE.md,
  during a session. Neither reaches the Memory page until the session is respawned.
- **Counter-arguments considered**:
  - Is the data actually volatile? Yes, unlike `diagnosticsDomain`'s doctor checks.
    `diagnosticsDomain.ts:16-18` documents its own freeze and correctly exposes **no**
    `subscribe` (verified: `grep -n subscribe app/sidecar/diagnosticsDomain.ts` returns
    nothing), which makes the contrast the report draws exact.
  - Does the attach path compensate? Partly. `sidecarServer.ts:622` sends the snapshot
    per connection, so a new window gets whatever the one-shot produced, not a fresh
    read.
  - The permanent-loading claim holds: `getSnapshot()` returns null for both loading and
    failed (its own doc comment at `:22` says so), and `sendMemorySnapshot`
    (`sidecarServer.ts:2778-2781`) returns early on `!raw`, so a failed read leaves the
    page on its loading state with no error and no retry. The only trace is the stderr
    line at `memoryDomain.ts:118-125`.
- **True consequence**: A stale Memory page for the session lifetime, and a permanent
  spinner after a failed read.
- **Evidence**: `memoryDomain.ts:22,36-56,108-125`; `sidecarServer.ts:493-497,2773-2781`;
  `diagnosticsDomain.ts:16-18`.
- **Disposition**: Take the report's first option (drop `subscribe`, document the freeze
  the way `diagnosticsDomain` does) rather than the second. A freshness-floored re-read
  is more machinery than the page needs, and F4 shows that pattern has its own sharp
  edge. Separately, split the null into `loading` and `failed` on the wire so the page
  can say which.

### F7 — [MED] `agentModeDomain` swallows every persisted-state error with a bare `catch {}` and no log

- **Verdict**: **PARTIALLY CONFIRMED** (mis-located)
- **Cited location holds?**: Yes. `agentModeDomain.ts:152-162` is a bare `catch { return
  null }` with no output.
- **Reachable in production?**: The **outcome** is reachable; the **mechanism the report
  blames is not the one that produces it**. `readPersistedSessionState`
  (`src/agent-mode/sessionState.ts:206-220`) already returns `null` for
  `isFsInaccessible(error)` (ENOENT/EACCES/EPERM/ENOTDIR/ELOOP,
  `src/utils/errors.ts:186-195`) **and** for `error instanceof SyntaxError`. A truncated
  or corrupt `.agent-mode-state.json` is a `SyntaxError`, so it is swallowed
  engine-side and never reaches the domain's catch at all. The domain's `catch {}`
  only sees residual cases (a `getSessionId()` throw, an exotic fs error code).
- **Trigger**: A killed process mid-write leaves invalid JSON. `readSessionState`
  returns null, `agentModeSnapshot` emits `objective: ''`, `phase: 'planning'`, live
  workers only, and the Orchestrator page shows a real agent-mode run as an empty
  planning session, byte-identical to a non-agent-mode session. That part of the report
  is correct and confirmed.
- **Counter-arguments considered**: Whether any log exists anywhere on this path
  (`sessionState.ts:216-218` returns null with no log either, so the report's "no way to
  tell them apart from inside or outside the process" holds end to end); whether the
  peer domains really do log first (`memoryDomain.ts:118-125` and
  `diagnosticsDomain.ts:128-133` both write to stderr, so the inconsistency argument
  stands).
- **True consequence**: A corrupt agent-mode state file renders as "not an agent-mode
  session", silently. Real, but the silence is engine-side.
- **Evidence**: `agentModeDomain.ts:152-162`; `sessionState.ts:206-220`;
  `errors.ts:186-195`.
- **Disposition**: **The report's fix does not fix its own trigger.** Adding a stderr
  line and an ENOENT skip inside `readPersistedAgentModeState` would log nothing for the
  corrupt-JSON case, because no error propagates there. Either (a) have
  `readPersistedSessionState` return a discriminated result
  (`{ok:false, reason:'corrupt'}`) so callers can distinguish absent from unparseable, or
  (b) leave the engine alone and, in the domain, stat the file before the read so an
  existing-but-unreadable state file can be reported as such. Keep the stderr line the
  report wants regardless, for the residual cases.

### F8 — [MED] `runWrite` treats "the executor did not throw" as success, but `setEffort`'s executor reports failure by return value

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes on every leg. `runControlsDomain.ts:237-256`
  (`runWrite` returns `{ok:true, ...}` unless `run()` throws), `:292-319` (`setEffort`),
  `:145-156` (the executor: `const result = executeEffort(effort); if
  (result.effortUpdate) {...}; return result.message`), and
  `src/commands/effort/effort.tsx:114-139`, where all three rejection paths return
  `{message}` with **no** `effortUpdate` and never throw.
- **Reachable in production?**: The shape is live. The observable failure is currently
  masked by the domain's own pre-validation at `:294-298`, which checks membership in
  `currentSnapshot.effort.options`, itself built from
  `getSupportedEffortLevels(getMainLoopModel())` (`runControlsDomain.ts:466-468`), the
  same list `executeEffort` uses (`effort.tsx:132`, default arg `getMainLoopModel()`).
  The one hole is the `effort === currentSnapshot.effort.current` bypass at `:297`:
  `effort.current` is `appliedEffort` (`:508`), a resolved level that is not itself
  re-checked against `getSupportedEffortLevels`.
- **Trigger**: Any divergence between the domain's list and `executeEffort`'s. Today
  that requires `appliedEffort` to fall outside `getSupportedEffortLevels(current)`.
  When it happens, the user gets no feedback at all: `verbAckErrorToast`
  (`app/renderer/src/verbAckResultState.ts:98-103`) returns `null` for `ok:true`, so
  `App.tsx:1669-1677` toasts nothing, and no snapshot re-broadcast fires because
  nothing changed.
- **Counter-arguments considered**: Whether `changed:false` alone lets the renderer
  detect it (it is not on the wire result the renderer consumes); whether the duplicate
  membership check is load-bearing (it is, today, which is exactly why the report calls
  it a §10 duplication that also hides the bug); whether `okMessage` is really dead
  (yes: `runWrite(..., message, ...)` captures `message` by value at `:311` before
  `run()` reassigns the closure variable, and `:318` re-applies the real one).
- **True consequence**: An engine-rejected effort change is reported as success and is
  completely silent to the user. Latent today, structural regardless.
- **Evidence**: file:line above; `effort.tsx:114-139`; `effort.ts:103-118`;
  `verbAckResultState.ts:98-103`.
- **Disposition**: Apply the report's fix. `{ applied: boolean; message: string }`
  derived from `result.effortUpdate !== undefined` is right, and deleting the duplicated
  membership check afterwards is the part that actually retires the §10 debt. Note that
  `src/utils/effort.ts` is dirty in the working tree (another session, +35 lines), so
  coordinate before touching `getSupportedEffortLevels`.

### F9 — [MED] Raw engine exception text is toasted to users

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes for the primary claim.
  `taskControlDomain.ts:96-102`, `agentModeDomain.ts:133-141`,
  `runControlsDomain.ts:244-252` and `:279-285` each interpolate `error instanceof Error
  ? error.message : String(error)` into `message`, and the renderer path is verbatim:
  `verbAckErrorToast` returns `{message: frame.message, tone:'danger'}` with no
  transformation (`verbAckResultState.ts:98-103`), toasted at `App.tsx:1676`.
- **Reachable in production?**: Yes for the primary claim. The secondary example is not.
- **Trigger**: Any unanticipated engine throw inside a write verb.
- **Counter-arguments considered** — the secondary example fails:
  - The report says `Unsupported model: ${model}.` renders as `Unsupported model:
    null.`. `getModelOptions` emits `value: null` "Default" options
    (`src/utils/model/modelOptions.ts:62,72,81`), and `RunControlModelOption.value` is
    typed `string | null` with the doc "null is provider-local Default"
    (`protocol.ts:1566-1573`). So `options.some(o => o.value === model)` is **true** for
    `model === null`, the guard passes, and the intended `'Model set to provider
    default.'` branch runs. The only way to reach `Unsupported model: null.` is if
    `getModelOptions()` threw and `safe()` returned `[]` (`runControlsDomain.ts:432-435`).
    (`modelOptions.ts` is dirty in the working tree; I read the current on-disk state.)
  - `taskControlDomain` really does get this right for anticipated errors
    (`stopTaskErrorMessage`, `:107-118`) and really does defeat itself in the generic
    branch two lines earlier. The report's rhetorical point stands.
- **True consequence**: An unanticipated engine exception message, which may carry paths
  and internal identifiers, is toasted verbatim. CLAUDE.md §7 violation, real but
  narrow.
- **Evidence**: file:line above; `modelOptions.ts:62,72,81`; `protocol.ts:1566-1573`.
- **Disposition**: Apply the report's fix (fixed user sentence in `message`, raw error to
  `process.stderr`) at all four sites, and land it together with F13's
  `describeError`/`SidecarWriteResult` consolidation so the redaction rule has one
  enforcement point. Drop the `Unsupported model: null.` example from the writeup.

### F10 — [MED] The goal wire snapshot carries the terminal's `/goal` help text, which the desktop renders verbatim

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, precisely. `goalDomain.ts:39` sets `summary:
  formatThreadGoalSummary(goal)`. `src/utils/threadGoal.ts:458-481` appends, for
  `status === 'active'`, the lines `Use /goal pause, /goal resume, /goal clear, or
  /goal replace <objective>.` and `The agent will mark it complete with update_goal
  when finished.`. `app/renderer/src/GoalsPage.tsx:80-82` renders `{goal.summary}` inside
  a `<pre>`, immediately below `GoalsPage.tsx:67-78`, which already renders objective,
  tokens used, token budget and time used as structured elements.
- **Reachable in production?**: Yes, on every active goal. No gate.
- **Trigger**: Open the Goals page with an active goal.
- **Counter-arguments considered**: Whether the renderer could be blamed instead (it
  cannot: `threadGoalSnapshot` puts the terminal-formatted string on a wire contract
  whose other seven fields are structured, so the choice is the domain's); whether the
  duplication is only partial (it is total for all four metrics the page already
  renders).
- **True consequence**: The user sees every number twice, the second time in terminal
  formatting, followed by instructions naming slash commands the desktop does not have
  and an internal tool name (`update_goal`). Straight CLAUDE.md §7 "never render
  engineering notes".
- **Evidence**: `goalDomain.ts:39`; `threadGoal.ts:458-481`; `GoalsPage.tsx:60-84`.
- **Disposition**: Apply the report's fix exactly: drop `summary` from
  `threadGoalSnapshot` and delete the `<pre>`. Every field it carries is already its own
  wire field. This is the cheapest confirmed finding in the set.

### F11 — [LOW] `readPermissionDisplayFacts` guards one of its two engine reads, contradicting its own doc comment

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Yes. `permissionDomain.ts:46-59`: the `try` covers only
  `isAutoModeGateEnabled()`; `shouldAllowManagedPermissionRulesOnly()` at `:56` is
  outside it, while the doc comment at `:40-44` says the function must "degrade to
  'unavailable' instead" because "a raise here would take the session down".
- **Reachable in production?**: **No.** This settles the report's own "Not reviewed"
  item. `shouldAllowManagedPermissionRulesOnly` (`permissionsLoader.ts:27-32`) calls
  `getSettingsForSource('policySettings')` (`settings.ts:311-318`), whose
  `policySettings` branch (`:321-345`) is four calls:
  `getRemoteManagedSettingsSyncFromCache()` (cache read), `getMdmSettings()` (returns
  `mdmCache ?? EMPTY_RESULT`, `mdm/settings.ts:124-126`), `loadManagedFileSettings()`,
  and `getHkcuSettings()` (`mdm/settings.ts:132-134`, same shape). The only fallible one
  is `loadManagedFileSettings`, and both of its paths are total:
  `parseSettingsFileUncached` (`settings.ts:203-232`) wraps its whole body in
  `try/catch` ending in `handleFileSystemError(error, path); return {settings: null,
  errors: []}`, and `handleFileSystemError` (`:159-172`) only logs and never rethrows;
  the drop-in `readdirSync` is separately wrapped at `:94`. There is no throw to
  degrade from.
- **Trigger**: None constructible.
- **Counter-arguments considered**: Whether `getManagedSettingsFilePath()` /
  `getManagedSettingsDropInDir()` could throw before the guarded region (they are path
  builders over `process.platform`); whether cache invalidation could re-enter something
  fallible (it re-enters `parseSettingsFile`, already shown total). The report's
  premise about the notify loop is correct on its own terms:
  `src/state/store.ts:26` is `for (const listener of listeners) listener()` with no
  `try`, and the permission listener is registered first at `sidecarServer.ts:488-490`
  ahead of goals/memory/tasks/agent-mode/leases/run-controls. But nothing can throw
  into it from this call.
- **True consequence**: A code-vs-comment inconsistency with no runtime consequence. The
  brace placement is worth tidying as defense in depth against a future engine change,
  not as a defect.
- **Evidence**: `permissionDomain.ts:46-59`; `permissionsLoader.ts:27-32`;
  `settings.ts:159-172,203-232,311-345`; `mdm/settings.ts:124-134`; `store.ts:26`.
- **Disposition**: Take the report's one-line fix (move the closing brace, default
  `managedRulesOnly` to `true`) since it is free and matches the stated contract, but
  record it as a comment/robustness tidy, not a LOW defect. Note that the `true`
  default is the right choice precisely because it is the restrictive one.

### F12 — [LOW] `as` casts on values that already have the right type, suppressing the drift tripwire

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes for all three. `agentConfigDomain.ts:57`
  (`agent.source as AgentConfigSourceId`), `:87` (`agent.overriddenBy as
  AgentConfigSourceId`), `agentModeDomain.ts:204` (`(persisted?.currentPhase ??
  'planning') as AgentModeRunPhase`).
- **Reachable in production?**: Type-level, so "reachable" means the unions really are
  identical. I verified each:
  - `AgentDefinition['source']` is `'built-in' | SettingSource | 'plugin'`
    (`loadAgentsDir.ts:137,148,156`), `SettingSource` is the five members of
    `SETTING_SOURCES` (`src/utils/settings/constants.ts:7-24`), and
    `AgentConfigSourceId` is `'built-in' | 'plugin' | SettingSourceId` with
    `SettingSourceId` the same five (`protocol.ts:682-687, 832-835`). Identical.
    `protocol.ts:679-681` even documents the intent: "Structurally identical to the
    engine's `SettingSource`, **so the sidecar assigns across without a cast**". The
    casts contradict the protocol's own stated design.
  - `overriddenBy` is `AgentSource = SettingSource | 'built-in' | 'plugin'`
    (`agentDisplay.ts:13`, via `ResolvedAgent` at `:34-36`). Identical.
  - Engine `AgentModeRunPhase` (`sessionState.ts:7-14`) and wire `AgentModeRunPhase`
    (`protocol.ts:1197-1204`) are the same seven members, and `currentPhase` is already
    typed `AgentModeRunPhase` at `sessionState.ts:48`. Identical.
- **Trigger**: Add a sixth `SettingSource` engine-side. The cast lets it through the
  snapshot boundary, and `sourceDisplayRank` (`agentConfigDomain.ts:155-172`) is an
  exhaustive `switch` with no `default`, so it returns `undefined`, `undefined - number`
  is `NaN`, and a comparator returning `NaN` gives implementation-defined ordering for
  the whole agent list. That chain is real and I verified each link.
- **Counter-arguments considered**: Whether `ResolvedAgent = AgentDefinition & {...}`
  widens `source` (it does not; intersecting a union with an object distributes and
  preserves the literal union); whether `resolveAgentOverrides` erases the discriminant
  (it spreads, `agentDisplay.ts:68`). I could not run `tsc` with the casts removed
  without editing the repo, so the "delete them and see" step remains for the fixer.
- **True consequence**: Three tripwires disarmed on the boundary they exist to protect.
- **Evidence**: file:line above.
- **Disposition**: Apply the report's fix verbatim, including its framing: delete the
  casts, and if `tsc` complains, that is the finding. Add a `default: return 7` (or a
  `never` assertion) to `sourceDisplayRank` while there, so the `NaN` sort is impossible
  even if a cast returns later.

### F13 — [LOW] Three near-identical write-result types and 52 copies of the same error-normalization expression

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `RunControlSetResult` (`runControlsDomain.ts:79-85`),
  `AgentModeSetResult` (`agentModeDomain.ts:42-47`), `TaskStopResult`
  (`taskControlDomain.ts:29-32`). The count is exact:
  `grep -c "error instanceof Error ? error.message : String(error)" app/sidecar/*.ts`
  sums to **52**, concentrated in `sidecarServer.ts` (22).
- **Reachable in production?**: N/A (quality finding, no runtime behavior).
- **Trigger**: None; this is duplication.
- **Counter-arguments considered**: Whether the three types are meaningfully different
  (they are not: `{ok, message, changed}` twice and `{ok, message}` once, with three doc
  comments all saying "the redacted outcome of a … write (no transport, no secret)").
  Whether consolidating would break the wire (it would not; these are sidecar-internal
  types, and the wire result frames are separate `protocol.ts` shapes).
- **True consequence**: No failure. It is the reason F9 is a four-site fix instead of a
  one-site fix.
- **Evidence**: the `grep -c` above; the three type declarations.
- **Disposition**: Apply the report's fix, and sequence it **before** F9 so the redaction
  rule lands in the funnel rather than being pasted four more times.

### F14 — [LOW] `taskControlDomain.stop` has no in-flight guard, so a double stop reports two successes

- **Verdict**: **INVALID**
- **Cited location holds?**: The locations exist (`taskControlDomain.ts:78-103`,
  `sidecarServer.ts:1894-1937` with `void this.handleTaskControlVerb(...)` unserialized
  at `:888`-adjacent dispatch). What does not hold is the claimed race.
- **Reachable in production?**: **No.** There is no `await` between the status check and
  the kill. `handleTaskControlVerb` (`sidecarServer.ts:1894-1925`) does a synchronous
  schema parse and domain-presence check, then `await this.taskControl.stop(...)`; the
  domain calls `executor.stop(taskId)` which calls `stopTask(...)`
  (`src/tasks/stopTask.ts:58-83`), which reads `getAppState()`, checks
  `status === 'running'`, resolves `getTaskByType`, and calls `await taskImpl.kill(...)`
  with no intervening suspension. `LocalAgentTask.tsx:360-362`'s `kill` body is
  `killAsyncAgent(taskId, setAppState)`, which is synchronous and sets
  `status: 'killed'` via `updateTaskState` (`:368-390`). The entire read-check-mutate
  sequence completes in one synchronous run, so a second frame cannot observe the
  pre-kill state.
- **Trigger**: None. I built one anyway and it failed to reproduce. `double-stop.ts`
  fires `Promise.all([domain.stop(id), domain.stop(id)])` against a real store with a
  running `local_agent` task and the real `createRealTaskControlExecutor`:
  ```
  stop#1 = {"ok":true,"message":"Stopped worker probe."}
  stop#2 = {"ok":false,"message":"That task has already finished."}
  final status = killed
  ```
- **Counter-arguments considered**: Whether two frames arriving in one TCP chunk could
  interleave (they cannot; the decoder dispatches sequentially and each dispatch runs
  synchronously through the kill); whether a different task type could introduce an
  await before its `kill` mutates status (`LocalShellTask`, `RemoteAgentTask` and
  `DreamTask` all use the same synchronous `updateTaskState` idiom, and the status check
  in `stopTask` precedes any of them); whether the renderer could double-toast for
  another reason (it would toast one success and one `danger` "already finished", which
  is arguably a worse UX than the report describes but is a different finding).
- **True consequence**: A double-click produces one success toast and one "That task has
  already finished." toast. Not two successes, no reasoning-about-the-seam defect.
- **Evidence**: `double-stop.ts` output; `stopTask.ts:58-83`;
  `LocalAgentTask.tsx:360-390`; `sidecarServer.ts:1894-1925`.
- **Disposition**: **Do not apply the report's fix.** A `Map<taskId, Promise>` of
  in-flight stops adds state and a lifetime question to solve a race that does not
  exist. If the second toast reads badly, the cheap fix is renderer-side: suppress the
  `not_running` toast when a stop for the same task succeeded within the last second.
  Even that is optional.

### F15 — [LOW] `RunControlExecutor.activateProvider` is optional on an interface whose domain method is required

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `runControlsDomain.ts:100` declares
  `activateProvider?(provider: 'anthropic' | 'openai'): void` on the executor;
  `:203` declares `activateProvider(provider): RunControlSetResult` as required on the
  domain; `:357-363` throws `new Error('Provider activation is unavailable.')` inside the
  `runWrite` callback purely so the `catch` at `:244-252` can convert it to `ok:false`.
- **Reachable in production?**: The throw is not (`createRealRunControlExecutor` always
  provides the method), which is exactly the point: it exists only for test fakes.
- **Trigger**: N/A (types/design).
- **Counter-arguments considered**: Whether the optionality is protecting a real
  capability gap (it is not; `createRealRunControlExecutor` unconditionally supplies it);
  whether the throw carries a distinguishable message to the user (it does, and that
  message is another instance of F9's category since it reaches
  `Could not activate provider: Provider activation is unavailable.`).
- **True consequence**: Control flow that uses `throw` as a return channel for a
  statically-known case.
- **Evidence**: `runControlsDomain.ts:100,203,357-363`.
- **Disposition**: Apply the report's fix. Prefer its first option (make the field
  required, give test fakes a no-op) over the second: returning `ok:false` directly from
  the domain leaves the optional type in place and the next reader has to re-derive why.

### F16 — [LOW] `permissionDomain.test.ts` has no test that a bypass request can be refused

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `app/sidecar/permissionDomain.test.ts` is 133 lines
  with six tests (`:18`, `:28`, `:42`, `:48`, `:105`, `:115`) covering `acceptEdits`, the
  real engine transition, the classifier gate in both directions, the no-op reference
  preservation, and the subscription filter. None covers a refused
  `setMode('bypassPermissions')`.
- **Reachable in production?**: N/A (test gap), but the second half of the claim is the
  sharp one and it holds: `app/sidecar/sidecarServer.test.ts:3883` is
  `test('C2 — bypassPermissions is available without a launch flag', ...)` and asserts
  `expect(received.some(frame => frame.kind === 'error')).toBe(false)` plus
  `expect(store.getState().toolPermissionContext.mode).toBe('bypassPermissions')`. The
  suite actively blesses the permissive behavior, and that file is **committed**, not
  dirty.
- **Trigger**: N/A.
- **Counter-arguments considered**: Whether coverage lives elsewhere
  (`sidecarServer.test.ts:3915` is the second, complementary permissive test; there is no
  negative case anywhere for bypass). Whether the missing test would actually have caught
  F1 (it would have caught the boundary half; the `sessionController.test.ts:448`
  assertion the same change set flipped is the one that guarded the loader half, so the
  real coverage loss is two tests, not one).
- **True consequence**: The two HIGH findings could be introduced with a green suite,
  because the assertions that guarded them were rewritten rather than deleted.
- **Evidence**: `permissionDomain.test.ts:1-133`; `sidecarServer.test.ts:3883-3909`;
  `sessionController.test.ts:445-449` (dirty, assertion flipped).
- **Disposition**: Apply the report's fix, sequenced with F1/F2: restore the guard first,
  then flip `sidecarServer.test.ts:3883` back to a rejection assertion, restore
  `sessionController.test.ts:448` to `false` with its §3-pin comment, and add the
  negative `setMode('bypassPermissions')` case to `permissionDomain.test.ts`.

## Spot-check of the "nine of ten domains call engine machinery" verdict

The brief asked for at least three. I checked all ten, and the claim holds.

| Domain | Engine machinery it actually calls | Verified |
|---|---|---|
| `permissionDomain` | `transitionPermissionMode`, `isAutoModeGateEnabled`, `shouldAllowManagedPermissionRulesOnly` | yes, and `setMode` really routes through `transitionPermissionMode` (`:105-109`), not a bare `applyPermissionUpdate` |
| `runControlsDomain` | `executeEffort`, `getSupportedEffortLevels`, `getModelOptions`, `getMarketingNameForModel`, `getContextWindowForModel`, `isAutoCompactEnabled`, `getMainLoopModel` | yes; every read is wrapped in `safe()` (`:412-418`) so one failing resolver costs one field |
| `contextBreakdownDomain` | `analyzeContextUsage`, `getMessagesAfterCompactBoundary`, `microcompactMessages`, `getLastSessionLog`/`loadFullLog`, `deserializeMessages` | yes; the header's reasoning for **not** calling `loadConversationForResume` (`:80-90`) checks out against `conversationRecovery.ts` |
| `taskControlDomain` | `stopTask` (`src/tasks/stopTask.ts`) against this session's store | yes, and I exercised it live in `double-stop.ts` |
| `agentConfigDomain` | `getAgentDefinitionsWithOverrides` (via `sessionController.ts:196`), `resolveAgentOverrides`, `hasRequiredMcpServers` | yes; one helper re-derived (F5) |
| `agentModeDomain` | `readSessionState`, `isAgentMode` via the executor | yes |
| `memoryDomain` | `scanMemoryFiles`, `getMemoryFiles`, `getAgentMemoryDir`, `isAutoMemoryEnabled` | yes |
| `diagnosticsDomain` | `buildInstallationDiagnostics`, `buildInstallationHealthDiagnostics`, `buildMemoryDiagnostics`, `getBranch`, `getMainLoopModel` | yes; correctly exposes no `subscribe` |
| `goalDomain` | `formatThreadGoalSummary`; T4 validation via `parseThreadGoal` at `sidecarServer.ts:1433-1457` | yes, including the fail-closed reject on a present-but-invalid snapshot |
| `tasksDomain` | raw `AppState.tasks` for `hasLiveWork` (`:41-50`), engine's `isVisibleBackgroundTask` for display | yes; the deliberate raw-vs-filtered split is real and documented at the decision point |

One correction to the verdict's arithmetic: the report says only one domain re-derives
engine logic, but by its own F8 it counts two (`agentConfigDomain`'s
`missingRequiredMcpServers` and `runControlsDomain`'s duplicated effort-membership
check). `isDesktopFastModeSupportedByModel` (`runControlsDomain.ts:110-116`) is a third
narrowing, but that one is a deliberate, documented desktop policy rather than a
duplicate.

## Findings the original report missed

### [HIGH, rider on F1] The Plan chip's own description is now false to the user, in a file F1 does not cite

`app/renderer/src/PermissionModeChip.tsx:64-68` labels plan mode
`desc: 'Research & plan only, no changes'`, and the same uncommitted change set that
introduced F1 removed the bypass gating from this exact file (diff verified: the
`unavailable` computation at `:185-190` lost its `mode === 'bypassPermissions' &&
!context.isBypassPermissionsModeAvailable` clause, and the disabled-row tooltip was
deleted). So the app now makes an explicit safety promise on the mode picker while, as
proved in F1, that mode auto-allows `curl … | sh`. This matters for the fix, not just
the writeup: a remediation scoped to `sessionController.ts:163` leaves the renderer half
of the change set unreviewed, and the two were authored together. Whoever fixes F1 must
diff `PermissionModeChip.tsx` in the same pass and decide deliberately whether the
Bypass row goes back behind `context.isBypassPermissionsModeAvailable`.

### [context, not a finding] The default desktop session resolves to `auto`, not `default`

In `e2e-probe.ts` on a machine with no `permissions.defaultMode`,
`loadSidecarToolPermissionContext()` returned `mode: 'auto'` (the classifier mode),
because `initialPermissionModeFromCLI` pushes `auto` at `permissionSetup.ts:789-797`
when no `defaultMode` is set and the model supports it. This bounds F1's exposure: a
user has to actively pick Plan to hit the bypass, they do not land in it. It also means
`handleSetMode`'s `auto` guard is the only mode guard on the surface and it protects the
mode users already start in, while the mode they switch to *for safety* has none.

## Residual uncertainty

- **Whether `analyzeContextUsage` can throw in production at all.** I refuted the throw
  site the report named and the token-count path, and measured the reachable null. I did
  not exhaustively prove the seven-way `Promise.all` at `analyzeContext.ts:1081-1101` is
  total, and I deliberately did not run the real executor against a live transcript
  because it would exercise real credentials. If someone wants F4 closed rather than
  downgraded, that run (with a throwaway `CLAUDE_CONFIG_DIR` and a copied transcript) is
  what settles it.
- **The actual store-mutation rate during a live desktop turn.** F3's severity depends
  on it and I measured only the per-notification cost, not the frequency. A
  counter incremented in `appStateStore.subscribe` during one real turn would settle it.
