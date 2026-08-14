# Desktop foreground-task backgrounding implementation plan

**Date:** 2026-08-13
**Status:** proposed implementation plan; blocked on TBG-0 engine continuation correctness
**Scope:** desktop application (`app/`) support for moving one selected running foreground local-agent task into the background
**Design:** deferred to a later interaction-design session; this plan does not choose button placement, labels, or keyboard shortcuts

## Problem

The terminal can move running foreground work into the background. Its task hint binds `task:background` to `Ctrl+B` and calls `backgroundAll()` (`src/tools/BashTool/UI.tsx:29-30`, `:48-50`, `:69-77`). That engine path backgrounds foreground shell tasks and local-agent tasks (`src/tasks/LocalShellTask/LocalShellTask.tsx:389-408`). For a local agent, `backgroundAgentTask()` marks the task backgrounded and resolves the signal intended to let the foreground Agent tool call return while its work continues (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:760-790`); the prerequisite defect in that continuation is detailed below.

The desktop can render agents launched with `run_in_background: true` and can stop or dismiss tasks, but it cannot perform that foreground-to-background transition. Its task-control vocabulary contains only `task.stop` and `task.dismiss` (`app/shared/protocol.ts:1508-1532`), and the sidecar task-control domain exposes only `stop()` and `dismiss()` (`app/sidecar/taskControlDomain.ts:113-125`).

This is a capability gap, not merely a missing shortcut.

Source review found a prerequisite defect in the existing engine transition.
After the background signal resolves, the foreground Agent path closes its
iterator and starts another `runAgent()` call
(`src/tools/AgentTool/AgentTool.tsx:1474-1504`). That new call rebuilds its
initial messages from the original fork context and prompt
(`src/tools/AgentTool/runAgent.ts:445-450`) rather than continuing from the
messages already produced by the foreground run. It can therefore repeat work,
lose intermediate conversational context, and overlap the old iterator when
cleanup exceeds the one-second timeout. Desktop exposure must not ship until
TBG-0 proves a continuation with no duplicate side effects or overlap.

## Scope decision

The first implementation supports the concrete reported case: **move one
selected running foreground local-agent task into the background without
stopping it**.

There is no singular engine “current foreground Agent” pointer. Agent is
concurrency-safe (`src/tools/AgentTool/AgentTool.tsx:2070-2072`), so several
`local_agent` tasks may be running with `isBackgrounded:false` at once. The
desktop verb is therefore targeted: a session-plane surface selects one
engine-minted task id, and the sidecar re-resolves that task against current
state. Background-all may be designed later as a separate aggregate action.

`AppState.foregroundedTaskId` is not this identity. It denotes a task whose
transcript is being viewed in the main pane
(`src/state/AppStateStore.ts:168-171`) and is set by
`foregroundMainSessionTask()` (`src/tasks/LocalMainSessionTask.ts:264-295`).
`registerAgentForeground()` does not set it
(`src/tasks/LocalAgentTask/LocalAgentTask.tsx:663-718`). No eligibility,
selector, test, or protocol field in this plan may use `foregroundedTaskId` as
proof that an Agent tool call is running in the foreground.

The first slice does not include:

- backgrounding the entire main conversation/query, which is a separate terminal path owned by `handleBackgroundQuery()` (`src/screens/REPL.tsx:2801-2869`);
- foreground shell-task conversion, because the desktop currently has no equivalent foreground-shell identity/read seam and the engine's targeted shell helper is private (`src/tasks/LocalShellTask/LocalShellTask.tsx:292-367`);
- a background-all aggregate action across multiple foreground Agents;
- changing how the model chooses `run_in_background` at spawn time;
- messaging, foregrounding, resuming, or otherwise expanding worker control;
- choosing a visual affordance or keyboard binding in this plan.

These exclusions must be stated in the shipped STATUS note. They are follow-up parity work, not behavior that this slice should pretend to cover.

## Decisions carried in

- Reuse the engine's existing `backgroundAgentTask()` state/signal transition only after TBG-0 has made the surrounding Agent execution a true continuation. Do not duplicate its state mutation, signal resolver, lease behavior, or completion lifecycle in `app/`.
- Keep the renderer untrusted. It may name only an engine-minted task id plus a correlation request id. The sidecar re-resolves current state immediately before mutation.
- Reuse the existing fixed `taskControlVerb` preload/main channel. Add no generic IPC method and no new preload bridge method.
- Add one app-local task-control verb, `task.background`. This is an additive desktop protocol change and does not require a protocol-version bump.
- Let the existing app-state subscriptions emit fresh `tasks.snapshot` and `agent-mode.snapshot` frames after the transition. Do not synthesize task state in the action handler.
- Treat foreground Agents as a set, not a singular pointer. The v1 verb mutates exactly the selected eligible task.
- Derive renderer eligibility from the existing session-plane `agent-mode.snapshot`: a live worker has an engine-minted `agentId`, status, and `isBackgrounded` (`app/sidecar/agentModeDomain.ts:264-282`). Require `isBackgrounded === false`, a running status, and a non-main-session role. Do not widen `TasksSnapshot` unless implementation proves that this existing feed is insufficient.
- Keep the locked transcript/session-plane split in `docs/migration/decisions/AGENT-CHROME.md` §4. A live task control belongs on a session-plane surface such as worker detail, the Tasks dialog, roster, or session footer. Do not join task snapshots into `AgentToolCard` without an explicit decision amendment.
- Preserve the existing completion-placement policy: a converted Agent card becomes a neutral background launch record, while eventual completion remains the existing correlated task-notification row. Do not claim completion attaches to the card unless a separately approved renderer-policy change implements and tests that behavior for every background-launch path.
- Keep locked migration decisions unchanged: Unix-domain socket transport, N-process topology, raw `AppSessionEvent` fidelity, die-with-window v1, and the two-id model.
- Interaction design is deliberately later. Backend work may land first, but the feature is not user-complete until the designed renderer affordance lands and is verified.

## Security and lifecycle invariants

A `task.background` request succeeds only when all of the following are true in the addressed sidecar's current app-state store:

1. `taskId` exists.
2. The task satisfies the engine's `isPanelAgentTask()` guard: it is a `local_agent` and not a synthetic `main-session` task.
3. The task is running or pending.
4. `isBackgrounded` is exactly false.

An unknown, stale, terminal, already-backgrounded, non-agent, or main-session id fails closed with `ok:false` and no store mutation. Another eligible foreground Agent in the same session is a valid but distinct target; backgrounding one must not mutate its siblings.

The sidecar must perform the eligibility check and call `backgroundAgentTask()` synchronously without an intervening `await`, so a task cannot change state between validation and transition inside the process. The engine helper remains authoritative for the actual mutation and background signal.

Successful backgrounding must preserve these lifecycle outcomes:

- the running worker is not aborted or recreated;
- its existing task id, agent id, transcript, progress, and Codex lease remain intact;
- the waiting foreground Agent tool call receives the existing background signal and returns its normal launch acknowledgement;
- the worker continues from all pre-background messages and side effects through a TBG-0-verified completion path;
- its eventual result arrives through the existing task-notification/correlation flow;
- the task becomes visible in the existing background-task and Agent Mode snapshots;
- idle parking continues to treat it as live work.

## Session split

| ID | Work | Model · Difficulty | Depends on |
|---|---|---|---|
| TBG-0 | Repair and prove the engine's foreground-to-background continuation | CLAUDE (system-architecture) · 8/10 | none |
| TBG-A | Engine-backed sidecar verb and boundary tests | ANY · 6/10 | TBG-0 |
| TBG-B | Renderer capability and truthful converted-launch state | ANY · 5/10 | TBG-A |
| TBG-C | Interaction design and user-facing affordance | CLAUDE (visual-design) · 4/10 · 🖐 GUI | TBG-A, preferably TBG-B |
| TBG-D | Integration, parity verification, and bookkeeping | ANY · 6/10 · 🖐 GUI | TBG-C |

The migration orchestrator assigns the real backlog/session identifiers. This plan does not add an invented STATUS row.

---

## TBG-0: Engine continuation prerequisite

### Goal

Make the existing foreground-Agent background transition a true continuation
before exposing it through another client. The transition must not restart from
the original prompt, duplicate already-performed side effects, lose intermediate
messages, or run the old and new loops concurrently.

### Source problem

The current path races `agentIterator.next()` with the background signal. When
the signal wins, it calls `agentIterator.return()`, waits at most one second, and
then calls `runAgent()` again with the original `runAgentParams`
(`src/tools/AgentTool/AgentTool.tsx:1441-1504`). The second `runAgent()` builds
`initialMessages` from the original context and prompt
(`src/tools/AgentTool/runAgent.ts:445-450`) and starts a new query over them
(`:859-868`). Reusing `agentId`, `abortController`, task state, and transcript
path preserves identity but does not preserve the in-memory execution.

### Required design

- Reuse the engine's real continuation/resume machinery where possible; do not hand-build a partial message replay.
- The old execution must be fully quiescent before any continuation starts. A timeout may report or refuse the transition, but it must not permit overlapping execution.
- The continuation input must include every committed pre-background message and tool result exactly once.
- Preserve the same task id, agent id, transcript chain, progress counters, abort-controller semantics, worktree, active-subagent registration, and Codex lease.
- Preserve async tool restrictions and permission behavior without restarting from the original prompt.
- Keep `backgroundAgentTask()` as the single state/signal transition unless source-backed investigation proves its API must change.

### Regression proof

Add an engine live-path test that:

1. starts a foreground Agent;
2. makes it learn a unique fact and complete one observable side effect;
3. backgrounds it while still running;
4. proves the continuation's final answer depends on the learned fact;
5. proves the pre-background side effect occurred exactly once;
6. proves the old loop ended before the continuation began;
7. proves the sidechain transcript contains one coherent parent chain with no duplicated initial prompt;
8. proves task identity, progress, worktree, and `getCodexLeaseForOwner(agentId)` remain unchanged.

Add an adversarial slow-close test in which the old iterator cannot settle
within the former one-second window. The implementation must wait safely or fail
without launching a second loop.

### Acceptance

- Existing terminal `Ctrl+B` backgrounding passes the continuation proof.
- No duplicate side effect or overlapping Agent query can be produced.
- The engine helper still resolves the foreground background signal.
- Focused Agent/LocalAgentTask suites and `bun run build:dev:full` pass.

---

## TBG-A: Engine-backed sidecar verb

### Goal

Add a closed, fail-closed desktop control that moves exactly one selected eligible foreground local-agent task into the background through the TBG-0-corrected engine transition.

### Files

#### `app/shared/protocol.ts`

- Extend `TASK_CONTROL_VERB_TYPES` with `task.background`.
- Add `TaskBackgroundMessage` with exactly:
  - `type: 'task.background'`;
  - bounded `requestId`;
  - engine-minted `taskId`.
- Add it to `TaskControlVerbMessage`.
- Keep `TaskControlResultFrame` unchanged except that its existing `verb` union now includes `task.background`.
- Document that this verb is panel-local-agent-only in v1 and that the sidecar must re-resolve type, status, and `isBackgrounded` before calling the engine transition.
- Do not add a frame kind or bump `PROTOCOL_VERSION`.

#### `app/sidecar/taskControlDomain.ts`

- Import `backgroundAgentTask` and `isPanelAgentTask` from their real owner.
- Extend `TaskControlExecutor` with a synchronous narrow `background(taskId)` operation, or add a similarly narrow injected seam that keeps boundary tests independent from a real agent loop. The real operation must not return a promise that encourages an `await` between its live-state check and transition.
- In the real executor:
  - read the live app-state store;
  - enforce all four eligibility rules above;
  - call `backgroundAgentTask(taskId, appStateStore.getState, appStateStore.setState)`;
  - return a typed refusal instead of matching prose;
  - treat a false helper result as a failed transition with no success claim.
- Extend `SidecarTaskControlDomain` with `background(taskId)`.
- Return redacted user-facing outcomes. Do not echo raw ids or engine objects.
- Keep the existing Stop and Dismiss behavior unchanged.

Suggested refusal vocabulary:

- `not_found`;
- `not_running`;
- `already_backgrounded`;
- `unsupported_type`.

Do not overfit the public result schema to these codes unless the renderer needs them. The sidecar domain and tests may use typed refusals internally while the existing outbound result remains `{ok, message}`.

#### `app/sidecar/sidecarServer.ts`

- Add `task.background` to the sidecar-local Zod discriminated union with only `type`, `requestId`, and `taskId` accepted.
- Add its exact key allowlist entry in `checkStrictKeys()`. Forged fields such as `isBackgrounded`, `agentId`, `foregroundedTaskId`, or task state must be rejected.
- Dispatch explicitly by closed switch rather than turning the existing two-arm conditional into a default that could route future verbs to Stop.
- Send the existing `task-control.result` correlation frame.
- Do not explicitly broadcast snapshots. The store subscription remains the single live-state path.

#### `app/main/main.ts`

- No new IPC handler. The existing `TASK_CONTROL_VERB_TYPES.includes(...)` check should admit the additive verb automatically.
- Update comments and source-guard assertions that incorrectly describe the channel as Stop/Dismiss-only.

#### `app/preload/preload.ts`

- No runtime behavior change should be needed. The existing typed `taskControlVerb()` sender carries the expanded union.
- Update comments only where they claim the channel is exclusively Stop/kill.

### Tests

Use the `writing-cat-code-tests` skill before editing tests.

#### `app/sidecar/taskControlDomain.test.ts`

Add a real-store live-path test that:

1. registers two real foreground local-agent tasks using `registerAgentForeground()`;
2. confirms neither registration writes `foregroundedTaskId`;
3. registers and captures the target's real Codex lease;
4. invokes the sidecar domain's `background()` for one target;
5. proves only the target's `isBackgrounded` becomes true in the same app-state store;
6. proves only the target's registered background signal resolves;
7. proves the sibling remains foreground and running;
8. proves the store subscription fires, which is the existing snapshot re-broadcast trigger;
9. proves identity/progress fields and `getCodexLeaseForOwner(targetId)` are preserved.

Add fail-closed tests for:

- unknown id;
- terminal agent;
- already-backgrounded agent;
- non-agent task;
- synthetic main-session task;
- executor refusal or unexpected failure remaining throw-free at the domain boundary.

#### `app/sidecar/sidecarServer.test.ts`

Add boundary tests proving:

- a valid `task.background` frame dispatches the background operation and returns a correlated `task-control.result`;
- extra renderer-authored state fields are rejected before the domain runs;
- malformed or oversized ids/request ids are rejected;
- an absent task-control domain fails closed;
- successful mutation reaches clients through the normal store-driven snapshot route, not an action-synthetic snapshot.

#### Source and hardening guards

Update existing exact-vocabulary expectations in:

- `app/main/mainSourceGuards.test.ts` or the current main source-guard owner;
- `app/preload/preloadSource.test.ts` if comments/type text are asserted;
- `app/scripts/hardening-smoke.ts` only if its closed verb or bridge expectations require it.

There is no new preload method, so the bridge-key count must not increase.

### Acceptance

- A valid foreground local agent transitions to background through the real engine helper.
- The original worker continues; it is not killed, respawned, or assigned a new identity.
- The Agent tool's existing background signal resolves.
- With multiple foreground Agents, only the selected target transitions.
- Every invalid/stale target fails closed without mutation.
- No new IPC channel, preload method, frame kind, or protocol-version bump is introduced.
- Existing Stop and Dismiss behavior remains green.

---

## TBG-B: Renderer capability and converted-launch truth

### Goal

Make the engine-backed capability available to session-plane renderer
components without deciding the final visual treatment, and make a foreground
Agent converted mid-run render truthfully as a background launch rather than a
completed Agent.

### Files

#### `app/renderer/src/orchestratorState.ts`

Add a pure selector over the existing `AgentModeSnapshot`:

- `selectBackgroundableForegroundAgents(snapshot)` returns every eligible live worker, preserving its engine-minted `agentId`.
- Require `status === 'running'`, `isBackgrounded === false`, and `role !== 'main-session'`.
- Do not infer a target from whichever Agent card happens to be visually pending.
- Do not expose background controls for already-backgrounded, persisted-only, main-session, or terminal rows.

If source-backed implementation proves `agent-mode.snapshot` insufficient, stop
and revise this plan before changing protocol. Do not add a singular
`foregroundedTaskId` substitute or broaden `TasksSnapshot.items` merely to
obtain a button target.

#### `app/renderer/src/App.tsx`

- Add `sendBackgroundTask(taskId)` beside `sendStopTask()` and `sendDismissTask()`.
- Send `task.background` through the existing `getBridge().taskControlVerb(...)` method with a fresh request id.
- Keep result handling on the existing `task-control.result` path.
- Pass the callback only to the eventual designed surface. TBG-B may leave it wired to an internal prop boundary with no visible control if TBG-C has not landed.

#### `app/renderer/src/transcriptProjector.ts`, `agentIdentity.ts`, and `TranscriptView.tsx`

- Narrow and preserve the Agent tool's structured result status when it is `async_launched`; do not parse model-facing prose.
- Treat that structured status as a background-launch fact even when the original tool input had `run_in_background:false`.
- Render the converted card as the existing neutral `backgrounded` launch record, never `Completed` while its task still runs.
- Keep its eventual task-notification as the existing standalone correlated completion row. Do not merge it into the card in this slice.
- Preserve the structured status through replay/restore.

#### Candidate component boundary

The final control may live in worker detail, the Tasks dialog, the roster, or
another existing session-plane control surface. TBG-B should establish only the
narrow callback/selector boundary needed by those candidates. It must not choose
placement, add provisional user-visible text, or pass task snapshots into
`AgentToolCard`.

### Tests

- `app/renderer/src/orchestratorState.test.ts`:
  - selects every engine-minted eligible foreground agent id;
  - returns an empty set with no foreground task;
  - excludes backgrounded, terminal, persisted-only, and main-session rows;
  - preserves two concurrent foreground targets without arbitrarily choosing one.
- `app/renderer/src/App.test.tsx` or the current bridge-wiring test:
  - the callback sends exactly `{type:'task.background', requestId, taskId}` to the addressed active session;
  - no active session means no send;
  - another session's eligible id is never used.
- `app/renderer/src/transcriptProjector.test.ts` and `TranscriptView.test.tsx`:
  - a foreground invocation whose structured result becomes `async_launched` renders `backgrounded`, not `Completed`;
  - replay produces the same result;
  - eventual completion remains one standalone task-notification row;
  - no duplicate card or completion row appears.

### Acceptance

- The renderer can request the transition only for an eligible engine-minted foreground task in the active session.
- Multiple eligible foreground Agents remain independently targetable.
- A converted Agent card truthfully renders as a background launch.
- No user-visible affordance is invented before design.
- Session isolation is covered by tests.

---

## TBG-C: Interaction design and user-facing affordance

### Goal

Choose and implement how a desktop user discovers and triggers the capability. This is intentionally later and must not be pre-decided by the backend plan.

### Design questions

The design session must decide:

1. **Primary placement:** worker detail, Tasks dialog, roster, streaming/turn footer, composer-adjacent session control, or a combination. Inline Agent-card placement is excluded unless `AGENT-CHROME.md`'s transcript/session-plane ruling is explicitly amended first.
2. **Keyboard behavior:** whether desktop should use `Ctrl+B`, another app-safe shortcut, or no global shortcut. Check macOS conventions and conflicts with text editing, terminal/tmux expectations, browser/Electron behavior, and existing app commands.
3. **Multiplicity:** whether the surface lists each eligible Agent, exposes a picker, or appears only in selected worker detail. It must never silently choose one of several foreground Agents.
4. **Visibility timing:** foreground registration is immediate; only the terminal hint waits for the progress threshold (`src/tools/AgentTool/AgentTool.tsx:1360-1439`). V1 should expose the action as soon as the engine snapshot proves eligibility and remove it immediately after transition. A delayed desktop affordance would require a new engine-minted readiness fact, not a renderer timer.
5. **Copy:** use user language such as “Run in background”; do not expose `isBackgrounded`, task ids, sidecar terminology, or migration references.
6. **Feedback:** decide whether the converted launch record and background-task strip are sufficient confirmation or whether a brief toast is needed.
7. **Accessibility:** focus order, button name, disabled/absent behavior, and keyboard discoverability.
8. **Whole-query distinction:** avoid implying that this backgrounds the entire conversation when v1 backgrounds only the selected local agent.

### Design constraints

- Follow the prototype only where it has a grounded equivalent; do not port prototype code.
- No inline `style={{}}`.
- No em dash in user-visible text.
- Say what the user can do, not how the sidecar works.
- The control must be absent, not disabled without explanation, when no eligible foreground task exists.
- When several Agents are eligible, the selected target must be explicit.
- A successful action must visibly transition the same worker to the existing background state rather than creating a duplicate card or task row.
- Do not add renderer-authored state to optimistically claim success. Render the transition from the fresh engine snapshot/result.

### Implementation files

The design determines the exact file list. Likely owners are:

- `app/renderer/src/TasksDialog.tsx` and its colocated tests if the control belongs in worker detail;
- the existing roster/detail surface if design selects the worker list;
- `app/renderer/src/App.tsx` if the control belongs in active-turn/session chrome;
- existing shared button/tooltip primitives rather than a new one-off abstraction.

### GUI acceptance

This session is GUI-dependent. Follow `docs/migration/process/GUI-VERIFICATION.md` and stop after headless verification to provide operator steps. Required observations:

1. Start a foreground agent that runs long enough to register as foreground work.
2. Confirm the designed control appears only for that live foreground agent.
3. Trigger it once.
4. Confirm the main conversation becomes usable again while the same agent continues.
5. Confirm the same agent appears as running in the background with no duplicate identity/card.
6. Confirm the original Agent card becomes a neutral background launch record and does not claim completion while the worker runs.
7. Confirm completion arrives once through the existing correlated task-notification row.
8. Confirm the control disappears after transition and cannot be triggered twice.
9. Start two eligible foreground Agents, select one, and confirm the sibling remains foreground and unchanged.
10. Confirm another session/tab is unaffected.

Hover-only acceptance remains operator-driven.

---

## TBG-D: Integration, parity, and bookkeeping

### Focused end-to-end test

Add or extend a sidecar/runtime integration test that runs the real foreground Agent registration and background signal path far enough to prove:

- two foreground Agent tasks can be registered without `foregroundedTaskId`;
- desktop verb accepted;
- only the selected engine signal resolved;
- foreground tool path released;
- selected worker remained running under the same id and the sibling was unchanged;
- a fact learned and a side effect completed before backgrounding were preserved exactly once;
- no old/new Agent execution overlap occurred;
- fresh task/Agent Mode snapshot reported it as backgrounded;
- eventual completion used the existing notification/correlation path.

A shape-only fake executor test is insufficient for this acceptance criterion.

### Stale-reference sweep

Before completion, search all source, tests, docs, configs, and maps for:

- `TASK_CONTROL_VERB_TYPES`;
- `TaskControlVerbMessage` and `TaskControlVerbType`;
- `task.stop` / `task.dismiss` comments that now incorrectly describe the full family;
- `foregroundedTaskId` references that incorrectly treat it as a running foreground Agent identity;
- Agent-card logic that treats only input `run_in_background:true` as a background launch;
- structured `async_launched` result projection and replay;
- task-control Zod schemas and exact-key allowlists;
- task-control result switches;
- preload/main source guards;
- hardening verb counts or closed allowlists;
- task dialog/help text claiming Stop is the only task action;
- docs/maps entries that describe desktop worker control as Stop-only.

Update only references made stale by this feature.

### Migration bookkeeping

As the last implementation step:

- update the assigned row in `docs/migration/STATUS.md` with implementation evidence and date;
- update the relevant parity-ledger row or add an explicit parity flag if no row owns terminal `Ctrl+B` parity;
- record these scoped deviations:
  - `🔁 adapted`: desktop action targets one explicitly selected foreground Agent rather than blindly copying terminal background-all input handling;
  - `⬜ deferred`: whole-main-query backgrounding;
  - `⬜ deferred`: foreground shell-task backgrounding;
  - `⬜ deferred`: background-all across multiple foreground Agents;
- do not write `DONE.md` without operator approval.

## Verification battery

Because TBG-0 changes the engine transition and later sessions touch `app/`, run
both the desktop battery and the focused engine task suites. The root build gate
is mandatory, not conditional.

```bash
bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts src/tools/AgentTool/AgentTool.test.ts
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
bun run --cwd app renderer:build
bun run build:dev:full
```

The root `bun run typecheck` is known-red and is not a gate.

Run docs checks for this plan and any map/status updates:

```bash
git diff --check
bun run maps:lint
```

Invoke `verifying-cat-code-changes` before reporting completion. Report actual command outcomes and distinguish failures in concurrently modified files from regressions owned by this work.

## Final acceptance checklist

- [ ] TBG-0 proves the engine continuation does not restart, overlap, or duplicate pre-background work.
- [ ] A user can move one explicitly selected foreground local-agent task into the background from the desktop application.
- [ ] Multiple foreground Agents remain independently targetable; no singular `foregroundedTaskId` assumption exists.
- [ ] The same worker continues under the same identity, transcript, progress state, and lease.
- [ ] The foreground Agent tool call releases through the engine's existing background signal.
- [ ] Invalid, stale, terminal, unrelated-session, and forged targets fail closed.
- [ ] No duplicate worker or completion row is created.
- [ ] The converted Agent card renders as a background launch, never as completed while running.
- [ ] Completion arrives once through the existing correlated task-notification path.
- [ ] Stop and Dismiss remain unchanged.
- [ ] No generic IPC, renderer-authored task state, new frame kind, or protocol-version bump is introduced.
- [ ] Desktop full battery and focused engine task tests pass.
- [ ] Hardening remains all-pass.
- [ ] The final interaction design is separately decided and GUI-verified.
- [ ] Whole-query, shell-task, and background-all deferrals are explicitly recorded rather than silently treated as complete.
