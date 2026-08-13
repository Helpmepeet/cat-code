# Subagent surface review: completion record and live worker

**Date:** 2026-08-13
**Scope:** How a local subagent (`local_agent`) is represented and controlled in the Electron
desktop app, plus the engine paths those surfaces depend on
**Status:** review complete, nothing implemented, no source changed
**Source basis:** working-tree source on 2026-08-13. Source wins over this file; it is a dated
record, not current truth. Re-verify before acting on any citation.

## 1. Executive summary

Two independent reviews ran against this surface. The first audited how a subagent's **finished
result** reaches the desktop; the second audited the **live worker** surface, what the operator
can see, trust, and do while a subagent is still running.

Both converge on one architectural gap:

> There is no durable join from `agentId` to worker identity to the spawning `tool_use` id
> anywhere in the renderer. The desktop's only channel for "a subagent finished" is a
> task-notification frame keyed to the `tool_use` id of the spawning `Agent` call. Anything that
> breaks that key loses the result, and anything that only knows the `agentId` cannot name the
> worker it is talking about.

Seventeen findings follow, in two families. Nine of them are downstream of that one gap.

Separately, and unrelated to the desktop, the review found the only defect here that can
**destroy uncommitted work**: the stale-worktree sweep (L4). That is ranked first.

## 2. Evidence base

- Live transcript: `~/.cat-code/projects/-Users-pt-cat-code/36e61c86-3d40-4548-b678-d0ef1aa49c90.jsonl`
  (desktop app session `ab94901c-8b33-4a3e-90d1-e923da3ea82a`). A normal-mode session that spawned
  six background subagents. Tool histogram: 6 `Agent`, 4 `TaskOutput`, and **only 2 completion
  notifications** in the entire file.
- Source reading across `src/tools/AgentTool/`, `src/tasks/`, `src/utils/task/`, `app/sidecar/`,
  `app/renderer/src/`, `app/host/`, `app/supervisor/`.
- Headless test suites (Part B only, counts per command group, not an aggregate).

**Caveat that applies to every citation below.** `app/sidecar/sidecarServer.ts` and
`docs/migration/decisions/SESSION-LIFETIME.md` were modified in the shared working tree by another
session while this review ran. Line numbers into those files describe a working tree, not HEAD,
and the Part B test counts were taken against that same tree. Re-check before editing.

## 3. Part A: the completion and record surface

### C1 (High) — `TaskOutput` races the completion notification and wins

`TaskOutput` marks a task `notified: true` as a side effect of reading it
(`src/tools/TaskOutputTool/TaskOutputTool.tsx:284`, and the non-blocking path at `:235`), and
`notifyTaskCompletion` early-returns when the flag is already set
(`src/tasks/LocalAgentTask/LocalAgentTask.tsx:306-318`).

`completeAgentTask` flips status to `completed` and deliberately does not notify
(`src/tasks/LocalAgentTask/LocalAgentTask.tsx:538-561`). AgentTool then awaits
`recordWorkerSessionTerminal`, `classifyHandoffIfNeeded` (an API call) and `getWorktreeResult`
(a git exec) before notifying (`src/tools/AgentTool/agentToolUtils.ts:1075-1107`). The status-first
ordering is deliberate, so `TaskOutput(block=true)` unblocks promptly
(`src/tools/AgentTool/agentToolUtils.ts:1007-1010`, gh-20236). But `waitForTaskCompletion` polls
status every 100ms (`src/tools/TaskOutputTool/TaskOutputTool.tsx:128-153`), so a waiting
`TaskOutput` reliably lands inside that window and suppresses the notification permanently.

**Consequence is worse than a missing result.** `deriveAgentToolState` returns `'background'`,
i.e. still running, for any backgrounded agent without a folded completion
(`app/renderer/src/agentIdentity.ts:396-398`; `hasCompletion` is set at
`app/renderer/src/TranscriptView.tsx:1846`). The card actively misreports a finished agent as
running, while its answer sits in an unrelated generic tool row.

Side effect: the early `notified` also satisfies the eviction predicate
(`src/utils/task/framework.ts:128`), making the task collectable sooner than the completion path
intended.

**Observed:** 6 spawns, 4 `TaskOutput` calls, 2 notifications in the evidence session.

### C2 (High) — a resumed agent can never fold into its card

Resume passes the **`ResumeAgent` tool's own** `toolUseId` into the re-registered task
(`src/tools/AgentTool/resumeAgent.ts:330-334`). `ResumeAgent` maps to family `agent-control`
(`app/renderer/src/transcriptProjector.ts:1729-1731`), and the fold set is filtered to
`toolFamily === 'agent'` (`app/renderer/src/transcriptProjector.ts:570-574`) — deliberately, since
`AgentToolCard` reads spawn-shaped input the control tools do not carry.

So the resumed run's completion renders as a bare notification one-liner, never in an agent card.
And because `agentCompletionsByToolUseId` is written per key and never cleared
(`app/renderer/src/transcriptProjector.ts:1234`), the **original** card keeps showing the first
run's completion, reading `completed` while the agent is running again.

**Inferred from source.** No resume occurred in the evidence session.

### C3 (Medium) — every interaction with a live worker renders as a generic tool row

`SendMessage` and `ResumeAgent` both land in `agent-control` and fall through to the generic card,
rendering as `TOOL SendMessage` with a raw payload, visually unrelated to the worker's own card.
The queued follow-ups themselves (`pendingMessages` on the task state) have **zero references** in
`app/renderer` — a message queued to a running worker is invisible until the worker acts on it.

### C4 (Medium) — `TasksDialog` double-counts subagents

The Tasks tab groups the snapshot unfiltered (`app/renderer/src/TasksDialog.tsx:148-151`) while the
Workers tab lists the same agents from `agentMode.workers` (`:153`). The docked strip does exclude
them (`app/renderer/src/App.tsx:3786-3788`, with a comment explaining why). One worker therefore
counts once in the strip and twice in the dialog.

This is item 3 of `docs/reports/2026-08-07-subagents-are-not-tasks-principle-and-blast-radius.md`,
verified still open against current source.

### C5 (Informational) — in normal mode, finished workers vanish after 30 seconds

`buildAgentSessionStateTracking` returns `undefined` unless the session mode is `agent` or
`coordinator` (`src/tools/AgentTool/AgentTool.tsx:103-106`). Normal-mode sessions therefore persist
no worker state, so the live-union in `agentModeSnapshot`
(`app/sidecar/agentModeDomain.ts:209-233`) has only the live plane — and the live task is evicted at
`completion + PANEL_GRACE_MS` (30s, `src/utils/task/framework.ts:23`, set at
`src/tasks/LocalAgentTask/LocalAgentTask.tsx:552`). Retained and blocked-handoff agents are exempt.

Judged designed rather than broken: the transcript card is the durable record. Recorded because it
explains why the Workers roster looks empty, and because it **narrows L10** (see §5).

### What holds up in Part A

- The kill path is correct: `stopTask` deliberately does not suppress an agent's notification,
  because the abort catch carries the partial result (`src/tasks/stopTask.ts:88-90`), unlike bash.
- Live progress is real: nested frames drive the running badge
  (`app/renderer/src/TranscriptView.tsx:1896`).
- The projector's fold already handles notification-before-card, and deliberately refuses to
  swallow background **shell** task notifications (`app/renderer/src/transcriptProjector.ts:566-574`).
- The worker-roster union and its dismissal logic are carefully reasoned
  (`app/sidecar/agentModeDomain.ts:184-233`).

## 4. Part B: the live worker surface

Verdict from that review: **RED for live-worker trustworthiness.** The permission boundary is
secure; the operator-facing lifecycle is not. IDs L1–L12 correspond 1:1 to F1–F12 in the original
report.

| ID | Severity | Defect | Status |
|---|---|---|---|
| **L1** | High | **Stop aborts the wrong controller for a foreground local worker.** `registerAgentForeground` mints a standalone controller (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:663-710`), but the sync path passes `override: { agentId }` only (`src/tools/AgentTool/AgentTool.tsx:1403-1416`) and `runAgent` falls to the parent turn's controller for non-async agents (`src/tools/AgentTool/runAgent.ts:605-613`). `killAsyncAgent` aborts the unused controller and writes `status: 'killed'` (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:374-395`). | Controller mismatch and false killed state **independently re-verified**. Continued execution inferred. |
| **L2** | High | **Stopping a worker does not resolve that worker's pending permission request.** Permission waits are promises keyed by request id (`src/app-runtime/AppSessionController.ts:224-240`); only session-level `abort()` mass-denies them (`:110-133`). `killAsyncAgent` only aborts the worker controller. The worker snapshot has no permission-wait field (`app/shared/protocol.ts:1214-1244`), so Workers keeps saying Running or In background. | Absence of a worker-abort listener proven by the reviewing session; blocked-until-answered inferred. Not re-verified here. |
| **L3** | High | **Clean tab/window shutdown exits the sidecar without gracefully aborting workers.** `SidecarServer.close()` removes subscriptions, timers and sockets and never calls `AppSessionController.abort()` (`app/sidecar/sidecarServer.ts:942-970`); signal handlers `process.exit(0)` immediately after (`app/sidecar/index.ts:529-545`). Reached via tab close (`app/host/host.ts:506-544`) and window shutdown (`:659-675`). | **Independently re-verified** in the current working tree. |
| **L4** | **High — can destroy work** | **Interrupted isolated workers leak worktrees, and the stale sweep can later delete untracked work.** Worktree cleanup is an async lifecycle step (`src/tools/AgentTool/AgentTool.tsx:1152-1195`), not registered for sidecar exit. The 30-day sweep (`src/utils/cleanup.ts:23-32`) checks `git status --porcelain -uno`, which **suppresses untracked files**, plus unpushed *commits* only (`src/utils/worktree.ts:1099-1119`), then runs `git worktree remove --force` and `git branch -D` (`src/utils/worktree.ts:988-1011`). | **Independently re-verified.** A worktree whose only content is new untracked files reads clean and is force-deleted. |
| **L5** | High | **The supervisor neither waits for sidecar death nor escalates.** `killSession()` sends one `SIGTERM`, removes the socket and drops the record without waiting (`app/supervisor/supervisor.ts:472-480`); `shutdown()` repeats it (`:495-508`). Rows are marked clean without exit confirmation (`app/host/host.ts:506-524`, `:669-675`). | Absence of acknowledgement proven by the reviewing session; surviving-sidecar scenario inferred. |
| **L6** | Medium | **A permission card cannot identify the requesting worker.** The engine preserves `ToolUseContext.agentId` as `agent_id` (`src/app-runtime/appRuntimeCanUseTool.ts:61-73`); the renderer prints that opaque id verbatim (`app/renderer/src/PermissionPrompt.tsx:368-373`) without joining it to the handle and role already in the worker snapshot. | Source-proven by the reviewing session. |
| **L7** | Medium | **Nested workers are flattened and their intermediate activity is dropped.** `AgentModeWorkerItem` has no parent or nesting field (`app/shared/protocol.ts:1214-1244`); the sidecar emits a flat union (`app/sidecar/agentModeDomain.ts:230-282`). When worker A receives worker B's progress, AgentTool forwards only Bash/PowerShell progress and discards the rest (`src/tools/AgentTool/AgentTool.tsx:1775-1784`). | Source-proven by the reviewing session; no depth-two live run exists. |
| **L8** | Medium | **The docked roster's inspect shortcut discards the clicked worker.** The roster supplies a worker id but `App` passes `onOpenTasks={() => setTasksOpen(true)}` (`app/renderer/src/App.tsx:2830-2832`), and opening the dialog resets to the Tasks tab and clears worker selection (`app/renderer/src/TasksDialog.tsx:158-163`). | Source-proven by the reviewing session. |
| **L9** | Medium | **Tasks advertises Stop for backend-rejected targets.** The renderer treats any non-terminal row as stoppable (`app/renderer/src/tasksState.ts:75-82`) while `stopTask` accepts only `status === 'running'` (`src/tasks/stopTask.ts:63-75`); running `in_process_teammate` rows are displayed but that type is not registered in `getTaskByType()` (`src/tasks.ts:22-38`). | **Independently re-verified.** |
| **L10** | Medium | **Abrupt shutdown can leave durable Agent Mode state claiming a dead worker is running.** Spawn adds the worker as `running` (`src/agent-mode/sessionState.ts:435-503`); only the terminal path removes it (`:564-624`), and abrupt sidecar exit skips that. | Persistence mismatch proven; **scope narrowed by C5** (see §5). |
| **L11** | Medium | **Host-crash behavior disagrees with the lifetime decision.** `docs/migration/decisions/SESSION-LIFETIME.md` says an orphaned turn runs to completion; `armIdleTimer` starts the countdown purely from zero connections, with no check of active turns, permissions or workers (`app/sidecar/sidecarServer.ts:683-695`, `:899-908`). An active orphaned worker is killed after the 15-minute TTL. | Mechanism **independently re-verified**; see the ownership note in §5. |
| **L12** | Low | **Stopped-worker labels conflict across surfaces.** A killed task reads Stopped in Tasks but Attention, "on the assistant", in Workers (`app/renderer/src/agentIdentity.ts:339-348`, `:426-442`; `app/renderer/src/orchestratorState.ts:123-179`), making an operator-initiated stop look like an unresolved obligation. | Source-proven by the reviewing session. |

### What the operator currently sees

| Engine state | Workers | Tasks | Actual control behavior |
|---|---|---|---|
| Foreground local worker running | Running, Stop | usually absent | Stop marks killed but aborts the wrong controller (L1) |
| Background local worker running | In background, Stop | active Agent row, `K stop` | Stop reaches the real controller |
| Worker waiting on permission | still Running / In background | ordinary running, or absent if foreground | permission card prints a raw id (L6); Stop does not resolve the wait (L2) |
| Completed blocked handoff | Waiting on the assistant, Dismiss | completed group, same meaning | accurate |
| Killed worker | Attention, counted "on the assistant" | Stopped | Dismiss available once terminal (L12) |

### What holds up in Part B

1. **T5a passes for subagent requests.** The sidecar requires a currently pending engine-minted
   `requestId` (`app/sidecar/sidecarServer.ts:2578-2600`) and the controller independently rejects
   a miss (`src/app-runtime/AppSessionController.ts:95-107`).
2. **T6 passes.** Renderer input is accepted only as empty confirmation or a deep-equal echo; the
   sidecar forwards its own stored gated input (`app/sidecar/sidecarServer.ts:2642-2720`).
3. **T6b passes.** Always-allow selects engine-authored suggestions by index and the sidecar
   reattaches cloned engine objects (`app/sidecar/sidecarServer.ts:2602-2639`).
4. Inspect is read-only once reached; Dismiss is terminal-only and does not claim to stop live
   execution; ordinary async-worker Stop is real.
5. **No durable Codex lease leak on clean sidecar death.** Explicit release is bypassed, but leases
   and WebSocket sessions are process-local, so process exit clears them. After a host crash they
   stay held until completion, reap, or the 15-minute TTL.

## 5. Corrections applied to Part B

- **The evidence base is a dirty shared tree.** See the caveat in §2. Substance of L3 holds as the
  tree stands; the test counts are not a HEAD baseline.
- **L11 rests on a document another session is rewriting.** The in-flight diff to
  `docs/migration/decisions/SESSION-LIFETIME.md` updates line numbers and the macOS relaunch
  behavior; it does **not** touch the "Host (Electron) crash … runs to completion, unobserved" row
  the finding depends on, so the contradiction survives the edit. That file belongs to the session
  editing it: report the drift, do not correct it here.
- **L10 is narrower than stated.** Per C5, durable Agent Mode state only exists in `agent` or
  `coordinator` mode. L10 cannot fire in normal mode.
- **L4 outranks the rest.** Every other finding produces a wrong display or a leaked process. L4
  deletes source files never committed anywhere. It is also engine-only and independent of the
  desktop migration. The sweep already implements the human rule in `CLAUDE.md`'s safe-sweep table,
  minus its one guard: that `node_modules` is the *sole* untracked entry.

## 6. The convergence

L6, L7, L8 and C1, C2, C3 are the same missing artifact: a durable
`agentId` ↔ worker identity ↔ spawning `tool_use` id join in the renderer.

The pieces already exist. The `Agent` tool's structured result carries `agentId`
(`src/tools/AgentTool/agentToolUtils.ts:730`); `TaskOutput`, `ResumeAgent` and `SendMessage` all
name the agent by that same id; the worker snapshot already carries the handle and role. Nothing
in the wire protocol has to change. Six findings across two independent reviews resolve against one
renderer-side join.

## 7. Suggested order

1. **L4** — engine, small, stops a path that can destroy uncommitted work.
2. **The `agentId` join** — renderer-only; closes C1, C2, C3 and L6, L7, L8.
3. **L1** — engine; Stop should abort the controller execution actually uses.
4. **L3 + L5** — graceful sidecar shutdown. Needs a decision about what graceful costs on quit, so
   it is a design conversation, not a patch.
5. **L9, L12, C4** — small truthfulness fixes in the renderer.

L2 and L11 stay open pending a GUI run; both are labeled inferred and both have a cheap operator
check (§8).

## 8. GUI-dependent checks left unverified

Per `docs/migration/process/GUI-VERIFICATION.md`, these require explicit per-run operator
authorization. No app was launched for this review.

1. **Foreground Stop (L1).** Start an `Agent` call without `run_in_background`. In Tasks → Workers,
   select the worker and click Stop while it reads Running. Does Workers flip to Attention while
   the worker keeps producing output or returns normally, and does Tasks read Stopped?
2. **Permission wait (L2).** Have a foreground worker trigger a real permission request. Confirm
   the card reads "Worker request" with a raw id, confirm Workers still says Running, then click
   Stop before answering and see whether the permission card stays pending.
3. **Roster click-through (L8).** Click a named worker's docked roster row above the composer.
   Source predicts the generic Tasks tab opens with nothing selected.

## 9. Not reviewed

Neither review covered these; none should be assumed healthy.

- Replay after reload: whether folded completions survive a session restore, or a reopened session
  shows every finished agent as running.
- Foreground (non-background) agents end to end.
- `DelegateGroup` / co-spawned agent grouping (`groupAgentDelegates`).
- The terminal TUI's own subagent lifecycle rendering, beyond `TaskOutputTool`'s renderer.
- The `web/` browser frontend, entirely.
- `in_process_teammate`, `remote_agent`, and team lifecycles.
- SDK and print-mode task events (`emitTaskTerminatedSdk`) for non-desktop consumers.
- Worktree-isolated agents as a *displayed* concept.
- Existing test coverage for the fold, and whether the proposed join has test support.

## 10. Verification performed

Part A: source reading plus transcript analysis. No tests run, no code changed.

Part B (reviewing session, headless, no model account used; counts per command group, overlapping,
not an aggregate): permission/sidecar/snapshot/nesting/projection 384 passed 0 failed; roster, task
controls, PermissionPrompt, controller, LocalAgentTask 376/0; AgentTool and local-agent lifecycle
71/0; host and supervisor 73/0; registry 38/0; idle TTL probe 2/0; dev-launcher signal policy 15/0.
Renderer suites are SSR-only and prove no interaction.

Two live-sidecar restore probes failed before readiness with
`fatal: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required` (0 passed, 2 failed, one
subsequent timeout). Environment limitation, not a product regression. No credentials supplied, no
quota spent.

No files were changed and no GUI was driven by either review.
