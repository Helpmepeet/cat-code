# Live TUI Session Status Upstream-Parity Implementation Plan

**Status:** implementation-ready plan, 2026-08-20

**Evidence:**

- `docs/research/2026-08-20-current-upstream-session-activity-comparison.md`
- `docs/plans/2026-08-20-unified-session-operational-state-design.md`

## Objective

Port the worthwhile live TUI status behavior from current upstream Claude Code
2.1.237 while preserving Cat Code-specific task and dialog truth:

1. keep the session busy while lifecycle-qualified delegated work remains active;
2. report waiting when the visible or typing-suppressed blocking dialog requires
   user action;
3. report waiting when a delegated local agent, teammate, or remote ultraplan
   task needs user action;
4. preserve independent work truth when waiting and active work coexist;
5. route primitive status facts through title, sleep prevention, goal
   continuation, OSC, and the existing feature-gated PID activity effect.

Preserve QueryGuard, query execution, cancellation, spinner presentation, and
all Desktop/Web/protocol behavior.

## Scope and compatibility

### In scope

- one dependency-free TUI status module;
- one canonical `FocusedInputDialog` type;
- one pure focused-dialog priority selector used by REPL;
- delegated task classification into working and waiting facts;
- `waiting > busy > idle` status derivation;
- an independent primitive for actual work used by sleep prevention;
- REPL integration below the focused-dialog selector;
- focused tests, adjacent goal/task tests, maps, and the engine build gate.

### Out of scope

- `src/utils/sessionActivity.ts`, which already owns remote keep-alive heartbeats;
- PID schema changes, `shell`, `statusUpdatedAt`, or process-start identity;
- `src/utils/concurrentSessions.ts` changes;
- upstream turn-controller extraction;
- QueryGuard changes;
- spinner behavior changes;
- post-turn OSC summary text;
- Desktop, Web, app-runtime, protocols, feature sets, or new dependencies.

### `BG_SESSIONS` compatibility

`BG_SESSIONS` is absent from the supported default and dev-full feature sets in
`scripts/build.ts:13-53,85-89`. Its process-list reader, `src/cli/bg.ts`, is also
absent. PID status therefore has no reader in supported builds.

However, `scripts/build.ts:90-115` accepts arbitrary `--feature=BG_SESSIONS`.
The existing REPL `updateSessionActivity()` effect must remain wired to the new
primitive status and waiting detail so custom builds do not silently lose an
existing behavior. Such custom builds remain outside supported compatibility
guarantees, and this plan does not extend or test their missing process-list
surface.

## Explicit deviation from the cross-frontend design

The broader design proposes one cross-frontend operational-state module with
lifecycle and capability facets. This TUI-only slice intentionally does not
implement that stage because the user narrowed scope to the TUI and no Desktop
file may change.

```text
🔁 adapted: introduce a TUI-specific leaf for live TUI facts. A later
cross-frontend implementation must absorb or delegate to it, then remove any
parallel precedence function rather than retain two authorities.
```

This module owns only TUI dialog/task classification and three-state TUI status.
It does not claim to model disconnected/dead lifecycle or Desktop capabilities.

## Target files

### New files

- `src/utils/tuiSessionStatus.ts`
  - canonical dialog type and priority selector;
  - blocking-dialog mapping;
  - delegated task working/waiting classification;
  - session status and sleep-work derivation.
- `src/utils/tuiSessionStatus.test.ts`
  - exhaustive dialog, task, mixed-state, exit, and precedence coverage.

### Existing files to change

- `src/screens/REPL.tsx`
  - import the canonical type and pure helpers;
  - replace the nested dialog priority implementation with the pure selector;
  - move status/effect/OSC derivation below `focusedInputDialog`;
  - preserve the feature-gated PID effect with primitive dependencies.
- `docs/maps/terminal-ui-state.md`
  - route focused-dialog priority and TUI status to the new owner.
- `docs/maps/tasks-workers.md`
  - route operational delegated-task classification separately from
    `isBackgroundTask()`.

Do not create or modify:

- `src/utils/sessionActivity.ts`;
- `src/utils/concurrentSessions.test.ts`;
- `src/utils/genericProcessUtils.test.ts`.

## Canonical dialog contract

### Resolve the dead union member first

Current `getFocusedInputDialog()` names `init-onboarding`, but REPL has no return
branch or render branch for it. Only `ide-onboarding` is live.

Remove `init-onboarding` from the canonical type. Do not add invented UI to make
the old union member reachable.

### Canonical type

Add to `src/utils/tuiSessionStatus.ts`:

```ts
export type FocusedInputDialog =
  | 'message-selector'
  | 'sandbox-permission'
  | 'tool-permission'
  | 'prompt'
  | 'worker-sandbox-permission'
  | 'elicitation'
  | 'cost'
  | 'idle-return'
  | 'resume-paused-goal'
  | 'ide-onboarding'
  | 'model-switch'
  | 'undercover-callout'
  | 'effort-callout'
  | 'remote-callout'
  | 'lsp-recommendation'
  | 'plugin-hint'
  | 'desktop-upsell'
  | 'ultraplan-choice'
  | 'ultraplan-launch'
```

Annotate the REPL producer with this imported type:

```ts
function getFocusedInputDialog(): FocusedInputDialog | undefined
```

No inline copy of the union remains in `REPL.tsx`.

## One focused-dialog priority owner

### Pure selector

Extract the full current priority algorithm into:

```ts
export type FocusedInputDialogFacts = {
  isExiting: boolean
  hasExitFlow: boolean
  isMessageSelectorVisible: boolean
  suppressInterruptDialogs: boolean
  allowDialogsWithAnimation: boolean
  hasSandboxPermission: boolean
  hasToolPermission: boolean
  hasPrompt: boolean
  hasWorkerSandboxPermission: boolean
  hasElicitation: boolean
  hasCostDialog: boolean
  hasIdleReturn: boolean
  hasResumePausedGoal: boolean
  hasUltraplanChoice: boolean
  hasUltraplanLaunch: boolean
  hasIdeOnboarding: boolean
  hasModelSwitchCallout: boolean
  hasUndercoverCallout: boolean
  hasEffortCallout: boolean
  hasRemoteCallout: boolean
  hasLspRecommendation: boolean
  hasPluginHint: boolean
  hasDesktopUpsell: boolean
}

export function deriveFocusedInputDialog(
  facts: FocusedInputDialogFacts,
): FocusedInputDialog | undefined
```

The function must preserve current REPL order exactly:

```text
exit
> message selector
> typing suppression
> local sandbox
> tool permission
> prompt
> worker sandbox
> elicitation
> cost
> idle return
> resume paused goal
> ultraplan choice
> ultraplan launch
> IDE onboarding
> callouts
> recommendations
> upsell
```

REPL calls this function for the visible focused dialog. The facts passed must
preserve existing gates:

- `hasExitFlow: exitFlow != null`;
- `hasCostDialog: showingCostDialog`, not raw `showCostDialog`;
- ultraplan booleans include the existing feature and `!isLoading` gates;
- ant-only callout booleans include the existing build-user gate;
- `allowDialogsWithAnimation` retains its current `toolJSX` condition.

### Typing-suppressed observation without a second priority list

When prompt typing suppresses interrupt dialogs, derive the prospective dialog
by calling the same selector with only:

```ts
suppressInterruptDialogs: false
```

Do not copy queue priority into a waiting helper.

Use:

```ts
const focusedInputDialog = deriveFocusedInputDialog(facts)
const prospectiveInputDialog =
  focusedInputDialog === undefined && isPromptInputActive
    ? deriveFocusedInputDialog({
        ...facts,
        suppressInterruptDialogs: false,
      })
    : focusedInputDialog
```

Exit remains authoritative in both calls because the exit facts are unchanged.
A voluntary visible dialog, such as message selection, remains the observation;
hidden lower-priority queues do not contradict the surface the user sees.

## Blocking-dialog mapping

Add:

```ts
export type TuiWaitingReason =
  | 'tool-approval'
  | 'input-needed'
  | 'worker-request'
  | 'sandbox-request'
  | 'dialog-open'

const WAITING_REASON_BY_DIALOG: Record<
  FocusedInputDialog,
  TuiWaitingReason | undefined
>
```

Map:

| Dialog | Waiting reason |
|---|---|
| `sandbox-permission`, `worker-sandbox-permission` | `sandbox-request` |
| `tool-permission` | `tool-approval` |
| `prompt`, `elicitation` | `input-needed` |
| `cost`, `idle-return`, `ide-onboarding` | `dialog-open` |
| `resume-paused-goal`, `ultraplan-choice`, `ultraplan-launch` | `input-needed` |
| `message-selector` | non-waiting |
| `model-switch`, `undercover-callout`, `effort-callout`, `remote-callout` | non-waiting |
| `lsp-recommendation`, `plugin-hint`, `desktop-upsell` | non-waiting |

Every canonical dialog member must choose waiting or non-waiting at compile time.

`pendingWorkerRequest` and `pendingSandboxRequest` render independently of the
focused-dialog switch. Apply them only when the observed focused/prospective
dialog is absent. Preserve visible local-JSX waiting as the final fallback.

Return a primitive waiting detail for the existing custom-build PID effect:

- tool approval: `approve <tool name>` when the current request exists;
- worker request: `worker request`;
- sandbox request: `sandbox request`;
- input needed: `input needed`;
- dialog open: `dialog open`.

## Delegated task operational facts

### Output

Add:

```ts
export type DelegatedTaskStatus = {
  hasWorkingDelegatedTask: boolean
  waitingReason?: 'input-needed'
}

export function deriveDelegatedTaskStatus(
  tasks: Readonly<Record<string, TaskState>>,
): DelegatedTaskStatus
```

The helper may allocate an object because REPL immediately destructures it into
primitive booleans/strings. Effects must never depend on the object identity.

Reuse `TaskType` and `isTerminalTaskStatus()` from `src/Task.ts`. Use an
exhaustive type switch with a `never` tripwire.

### Delegated waiting states

A nonterminal task contributes `waitingReason: 'input-needed'` when:

- `local_agent.handoffStatus === 'blocked'`;
- `in_process_teammate.awaitingPlanApproval === true`;
- `remote_agent.ultraplanPhase === 'needs_input'`;
- `remote_agent.ultraplanPhase === 'plan_ready'`.

These states already drive task attention UI. They must not be misreported as
busy merely because the underlying task remains `running`.

### Delegated working states

A nonterminal task contributes working when:

- `local_agent` is not blocked;
- `in_process_teammate` is not awaiting plan approval and `isIdle !== true`;
- `remote_agent` is not in an ultraplan attention phase and
  `isLongRunning !== true`;
- `local_workflow` is nonterminal.

Do not count:

- `local_bash`;
- `monitor_mcp`;
- `dream`;
- terminal tasks;
- idle teammates;
- blocked local agents;
- teammates awaiting plan approval;
- remote ultraplan attention phases;
- deliberately long-running remote agents.

A backgrounded main session uses `local_agent` and counts as working while
nonterminal and unblocked.

### Mixed task sets

Working and waiting are independent aggregate facts. Examples:

```text
one blocked local agent only
  -> waiting=true, working=false

one ultraplan needs_input + one running local agent
  -> waiting=true, working=true

one long-running remote + one idle teammate
  -> waiting=false, working=false
```

## Session status and sleep policy

### Session status

Add:

```ts
export function deriveTuiSessionStatus(args: {
  isLoading: boolean
  hasWorkingDelegatedTask: boolean
  localWaitingReason: TuiWaitingReason | undefined
  delegatedWaitingReason: 'input-needed' | undefined
}): TabStatusKind {
  if (
    args.localWaitingReason !== undefined ||
    args.delegatedWaitingReason !== undefined
  ) {
    return 'waiting'
  }
  if (args.isLoading || args.hasWorkingDelegatedTask) return 'busy'
  return 'idle'
}
```

This is the only `waiting > busy > idle` implementation.

### Actual work for sleep prevention

Keep a second primitive:

```ts
export function deriveHasOperationalWork(args: {
  isLoading: boolean
  hasWorkingDelegatedTask: boolean
  localWaitingReason: TuiWaitingReason | undefined
}): boolean {
  return (
    (args.isLoading && args.localWaitingReason === undefined) ||
    args.hasWorkingDelegatedTask
  )
}
```

Policy:

- preserve current behavior: a foreground query blocked on a local user prompt
  does not keep `caffeinate` active merely because `isLoading` remains true;
- active delegated work keeps `caffeinate` active even while another local or
  delegated task is waiting;
- delegated waiting alone does not keep the machine awake;
- local shell and deliberately long-running remote tasks do not participate.

This resolves `waiting + work still running` without adding the unused upstream
`working` field.

## REPL integration

### Keep early title identity in place

Leave terminal title identity and `isShowingLocalJSXCommand` at their current
early location. Remove only the early status derivation and effects.

### Preserve teammate-specific behavior

Keep `hasRunningTeammates` for the swarm-duration effect. Add a separate memo:

```ts
const delegatedTaskStatus = useMemo(
  () => deriveDelegatedTaskStatus(tasks),
  [tasks],
)
const hasWorkingDelegatedTask =
  delegatedTaskStatus.hasWorkingDelegatedTask
const delegatedWaitingReason = delegatedTaskStatus.waitingReason
```

Do not broaden the swarm-duration message to other task types.

### Derive status below focused-dialog facts

After the canonical visible and prospective dialog derivations:

1. map the observed dialog to `localWaitingReason`;
2. if no observed dialog exists, apply pending worker, pending sandbox, and
   local-JSX fallbacks;
3. derive primitive `sessionStatus`;
4. derive primitive `hasOperationalWork`;
5. derive primitive `waitingFor` for the existing PID effect;
6. derive `titleIsAnimating = sessionStatus === 'busy'`;
7. run sleep prevention from `[hasOperationalWork]`;
8. keep the feature-gated PID effect with `[sessionStatus, waitingFor]`;
9. keep the existing OSC gates and call `useTabStatus()` with primitive status.

Moving the sleep, PID, and tab-status effects below `focusedInputDialog` changes
their order relative to intervening hooks but not hook count or conditionality.
This ordering shift is accepted and must remain unconditional on every render.

Never use a freshly allocated result object as an effect dependency.

### Goal continuation

Keep the existing `sessionStatus === 'idle'` check at `REPL.tsx:4611`.
It now refuses continuation while:

- delegated work is running;
- a local blocking dialog waits;
- a delegated task needs input.

Excluded idle/terminal/long-running task states do not block continuation.

### OSC

Keep `tengu_terminal_sidebar` and user configuration gates unchanged. Do not
claim manual OSC acceptance in supported external builds because the feature
gate defaults false and is documented as ant-only while stabilizing.

## Test plan

Before editing tests, invoke `writing-cat-code-tests`.

### Canonical dialog producer

- all 19 live `FocusedInputDialog` members have an explicit mapping;
- `init-onboarding` is absent;
- every priority pair needed to pin current order is covered;
- exit suppresses all dialogs;
- message selector beats typing suppression;
- typing suppression returns no visible dialog;
- a second selector call with suppression disabled returns the same prospective
  dialog the visible selector would choose after typing stops;
- `hasCostDialog` fixtures use the already-gated `showingCostDialog` fact.

### Delegated tasks

Test:

```text
local agent pending/running                    -> working
backgrounded main-session local agent          -> working
blocked local agent                            -> waiting, not working
remote agent running                           -> working
long-running remote agent                      -> neither
ultraplan needs_input                          -> waiting, not working
ultraplan plan_ready                           -> waiting, not working
teammate active                                -> working
teammate idle                                  -> neither
teammate awaiting plan approval                -> waiting, not working
local workflow running                         -> working
local bash / monitor / dream                    -> neither
all terminal states                            -> neither
mixed active + excluded                        -> working
mixed waiting + active                         -> waiting and working
```

### Session and sleep precedence

Test:

```text
loading only                                   -> busy
working delegated only                         -> busy
local waiting + loading                        -> waiting, no operational work
local waiting + working delegated              -> waiting, operational work
remote delegated waiting + loading             -> waiting, operational work
remote delegated waiting only                  -> waiting, no operational work
waiting delegated + working delegated          -> waiting, operational work
nothing active                                 -> idle, no operational work
```

### Integration argument fixtures

Pin:

- `hasExitFlow` uses `exitFlow != null` semantics;
- cost waiting receives `showingCostDialog`, not raw `showCostDialog`;
- visible local sandbox plus tool queue reports sandbox;
- typing-suppressed sandbox plus tool queue prospectively reports sandbox;
- visible voluntary message selector does not report hidden tool waiting;
- no dialog plus pending worker request reports worker request;
- no dialog plus pending sandbox request reports sandbox request;
- exit plus every pending queue reports no waiting.

### Adjacent existing suites

Run:

```bash
bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts \
  src/tasks/RemoteAgentTask/RemoteAgentTask.test.ts \
  src/utils/swarm/inProcessRunner.test.ts

bun test src/commands/goal/goal.test.ts \
  src/utils/threadGoalController.test.ts
```

The goal suites are required because aggregate `sessionStatus === 'idle'` gates
goal continuation.

## Implementation order

### Step 0: Baseline

1. Record `git status --short` and preserve unrelated shared-tree work.
2. Invoke `writing-cat-code-tests`.
3. Run the adjacent task and goal suites.
4. Run `bun run build:dev:full` if the shared tree permits a meaningful baseline.

### Step 1: Canonical dialog selector

1. Add tests for the 19 live members, priority, exit, and typing suppression.
2. Add canonical `FocusedInputDialog` and `deriveFocusedInputDialog()`.
3. Remove dead `init-onboarding` from the contract.
4. Replace REPL's nested priority body with one call to the pure selector.

Gate: one type and one priority algorithm own dialog focus.

### Step 2: Delegated facts and status

1. Add failing task, mixed-state, status, and sleep-policy tests.
2. Implement delegated working/waiting classification.
3. Implement status and operational-work primitives.
4. Run `tuiSessionStatus.test.ts` until green.

Gate: attention states are waiting, active states are busy, and mixed waiting
plus work preserves work truth.

### Step 3: REPL adoption

1. Keep title identity and local-JSX declarations early.
2. Keep teammate-duration logic separate.
3. Derive visible/prospective dialogs through the canonical selector.
4. Move status/effects/OSC below dialog facts.
5. Preserve the custom-feature PID effect with primitive dependencies.
6. Use `hasOperationalWork` for sleep prevention.
7. Do not change spinner or query lifecycle code.

Gate: no duplicate status precedence or dialog priority remains.

### Step 4: Maps and verification

1. Update the two focused maps.
2. Run new, task, and goal suites.
3. Run `bun run build:dev:full`.
4. Search code, tests, docs, configuration, YAML, and Markdown for:
   - inline `FocusedInputDialog` copies;
   - `init-onboarding`;
   - old `isWaitingForApproval`;
   - duplicate dialog queue priority;
   - accidental import or edit of `src/utils/sessionActivity.ts`;
   - accidental PID schema/process-identity work.
5. Invoke `checking-cat-code-change-impact` and apply only required updates.

## Verification battery

From `/Users/pt/cat-code`:

```bash
bun test src/utils/tuiSessionStatus.test.ts

bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts \
  src/tasks/RemoteAgentTask/RemoteAgentTask.test.ts \
  src/utils/swarm/inProcessRunner.test.ts

bun test src/commands/goal/goal.test.ts \
  src/utils/threadGoalController.test.ts

bun run build:dev:full

git diff --check
bun run maps:lint
```

Do not run bare `bun test`, root `bun run typecheck`, Desktop tests, GUI
commands, or custom `BG_SESSIONS` builds.

## Acceptance criteria

The implementation is complete only when:

- existing `src/utils/sessionActivity.ts` is untouched;
- QueryGuard, query execution, cancellation, and spinner behavior are unchanged;
- one canonical type and selector own focused-dialog priority;
- dead `init-onboarding` is removed from that contract;
- active delegated work prevents false idle;
- blocked local agents, teammate plan approval, and ultraplan attention states
  report waiting rather than busy;
- terminal tasks, idle teammates, local shell, monitor, dream, and deliberately
  long-running remotes do not create false busy;
- mixed waiting plus active delegated work retains operational-work truth;
- visible dialog priority and waiting status agree;
- exit suppresses dialog and queue waiting;
- effects depend only on primitive values;
- goal continuation cannot begin during delegated work or waiting;
- supported OSC gates and protocol remain unchanged;
- the custom-feature PID effect remains wired, but no PID schema or reader work
  is added;
- no Desktop, Web, feature-set, protocol, or turn-controller file changes;
- focused tests, build gate, maps, and stale-reference sweeps pass.
