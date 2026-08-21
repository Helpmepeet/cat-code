# Tasks And Workers Routing Map

Last refreshed: 2026-08-21.

Purpose: route local agents, shell tasks, teammate tasks, remote agent tasks, task panel UI, lifecycle, kill/stop behavior, and tests. This is a navigation map, not a replacement for source inspection. Start here, then verify behavior in the owner files below.

## First Files To Inspect

- `src/tasks.ts` and `src/Task.ts` for task exposure and base types.
- `src/tasks/` for concrete lifecycle and stop behavior.
- `src/tools/AgentTool/AgentTool.tsx`, `agentToolUtils.ts`, `runAgent.ts`, and `resumeAgent.ts` for local-agent work.
- `src/utils/swarm/teamHelpers.ts`, `src/utils/teammateMailbox.ts`, and `src/utils/swarm/inProcessRunner.ts` for teammate routing.
- `src/components/tasks/`, `src/screens/REPL.tsx`, `src/hooks/useBackgroundTaskNavigation.ts`, and `src/state/selectors.ts` for terminal task UI.
- `src/agent-mode/sessionState.ts` and the worker-control tool directories for durable Agent Mode worker state.

## Entry Points

| Concern | Start here | Then inspect | Notes |
|---|---|---|---|
| Registered task types | `src/tasks.ts` | `src/Task.ts`, `src/tasks/types.ts` | `getAllTasks()` exposes `local_bash`, `local_agent`, `remote_agent`, `dream`, plus feature-gated workflow and monitor tasks. `in_process_teammate` is a task type but is not currently registered through `src/tasks.ts`; teammate kill/navigation imports it directly. |
| Base task contract | `src/Task.ts` | `src/utils/task/framework.ts`, `src/utils/task/diskOutput.ts` | The polymorphic task interface is now just `kill(taskId, setAppState)`. Spawn/render are owned by concrete task modules and tools. |
| Background-task filtering | `src/tasks/types.ts` | `src/components/tasks/BackgroundTaskStatus.tsx`, `src/components/tasks/BackgroundTasksDialog.tsx` | `isBackgroundTask()` requires `running` or `pending`, and excludes foreground tasks with `isBackgrounded === false`. This is a UI-visibility predicate, not an activity predicate. |
| Operational task activity (session busy/waiting) | `src/utils/tuiSessionStatus.ts` | `src/screens/REPL.tsx`, `docs/maps/terminal-ui-state.md` | `deriveDelegatedTaskStatus()` answers a different question from `isBackgroundTask()`: does this session own active delegated work, and is any delegated task stalled on the user. Working and waiting are independent aggregate facts. Excluded from work: terminal tasks, idle teammates, blocked local agents, teammates awaiting plan approval, remote ultraplan attention phases, deliberately long-running remote agents, and `local_bash` / `monitor_mcp` / `dream`. A backgrounded main session counts as work, because it runs as `local_agent`. |
| AppState updates and eviction | `src/utils/task/framework.ts` | `src/state/teammateViewHelpers.ts`, concrete task files | `registerTask()`, `updateTaskState()`, `pollTasks()`, and `evictTerminalTask()` are the shared state helpers. Local-agent panel retention uses `PANEL_GRACE_MS`. |
| Task output files | `src/utils/task/diskOutput.ts` | task detail dialogs, notification code | Bash and remote tasks write output files directly; local agents symlink task output to sidechain transcripts. Reads should use deltas/tails, not full unbounded reads. |

## Task Types

| Task kind | Owner | Spawn/register path | Completion path | Kill/stop path |
|---|---|---|---|---|
| Shell task (`local_bash`) | `src/tasks/LocalShellTask/LocalShellTask.tsx` | `spawnShellTask()`, `registerForeground()`, `backgroundExistingForegroundTask()` | Shell result updates status, flushes/cleans command output, enqueues shell notification, evicts task output | `LocalShellTask.kill()` delegates to `src/tasks/LocalShellTask/killShellTasks.ts`; `stopTask()` suppresses noisy shell XML notification and emits SDK termination directly |
| Local async agent (`local_agent`) | `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | `registerAsyncAgent()` for async-from-start/resume; `registerAgentForeground()` for sync agents that may later background | `completeAgentTask()` / `failAgentTask()` update terminal state; `runAsyncAgentLifecycle()` enqueues model-facing notification | `killAsyncAgent()` aborts controller, releases Codex lease, evicts output; bulk kill uses `killAllRunningAgentTasks()` plus `markAgentsNotified()` |
| Backgrounded main session (`local_agent`, `agentType=main-session`) | `src/tasks/LocalMainSessionTask.ts` | `registerMainSessionTask()` and `startBackgroundSession()` from REPL/session backgrounding | `completeMainSessionTask()` updates status and notifies only if still backgrounded | Uses local-agent task shape and abort controller; foregrounding goes through `foregroundMainSessionTask()` |
| In-process teammate (`in_process_teammate`) | `src/tasks/InProcessTeammateTask/` | Runtime spawn is in swarm utilities; task module owns state helpers and direct kill bridge | Teammate runner updates task state; UI state can stay in viewing mode until auto-exit or user action | `InProcessTeammateTask.kill()` calls `killInProcessTeammate()`. Escape while viewing a running teammate aborts only current work via `currentWorkAbortController`; `k`/`x` kill the teammate task |
| Remote agent (`remote_agent`) | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` | `registerRemoteAgentTask()` creates local task, output file, sidecar metadata, and poller; `restoreRemoteAgentTasks()` rehydrates on resume | Poller watches CCR events, projected todo/task logs, remote review tags, ultraplan phases, completion checkers, and archived sessions | `RemoteAgentTask.kill()` marks killed/notified, emits SDK termination, archives remote session, evicts output, removes sidecar metadata |
| Dream task (`dream`) | `src/tasks/DreamTask/DreamTask.ts` | `registerDreamTask()` surfaces auto-dream memory consolidation in task UI | `completeDreamTask()` / `failDreamTask()` are UI-only and mark notified immediately | `DreamTask.kill()` aborts and rolls back consolidation lock mtime |

Feature-gated adjacent task kinds live behind `WORKFLOW_SCRIPTS` and `MONITOR_TOOL`. Keep their routing in `src/tasks.ts` and `src/components/tasks/BackgroundTasksDialog.tsx` aligned, but do not treat them as always-live external behavior.

## Local Agent Routing

Start with `src/tools/AgentTool/AgentTool.tsx` for launch decisions:

- `run_in_background=true` creates an async local-agent task immediately.
- Synchronous subagents can register a foreground local-agent task, show a background hint after `PROGRESS_THRESHOLD_MS`, and then background via `backgroundAgentTask()` or `backgroundAll()`.
- `name` plus team context routes to teammate spawn instead of a local async agent.
- In-process teammates are blocked from spawning background agents.
- Agent Mode/coordinator worker state is recorded through session-state tracking helpers in `src/agent-mode/sessionState.ts`.

Then inspect:

- `src/tools/AgentTool/agentToolUtils.ts` for `runAsyncAgentLifecycle()`, final notification formatting, progress tracking, partial-result extraction, and terminal Agent Mode worker records.
- `src/tools/AgentTool/runAgent.ts` for sidechain transcript writes, agent-specific MCP/hook/skill setup, subagent context isolation, and cleanup of agent-scoped shell/monitor tasks when an agent exits.
- `src/tools/AgentTool/resumeAgent.ts` for resuming a retained/completed local agent in the background from its transcript and metadata.
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx` for task state fields: progress, `pendingMessages`, `retain`, `diskLoaded`, `evictAfter`, blocked handoff metadata, and verification verdict extraction.
- `src/tasks/pillLabel.ts` for the canonical compact label/icon rules that blocked handoffs and verification agents share with the footer pill and transcript status lines.

## Shell Task Routing

Start with `src/tasks/LocalShellTask/LocalShellTask.tsx`.

- `spawnShellTask()` is already backgrounded and registers cleanup.
- `registerForeground()` creates a task that is not yet a background task; `backgroundExistingForegroundTask()` flips it in place.
- `backgroundAll()` backgrounds foreground shell and foreground agent tasks together.
- `startStallWatchdog()` watches output growth and emits a one-shot notification only when the tail looks like an interactive prompt.
- Agent-spawned shell tasks carry `agentId`; `killShellTasksForAgent()` in `killShellTasks.ts` prevents shell tasks from outliving their agent.

Use `src/tasks/LocalShellTask/guards.ts` for pure type checks from non-React modules.

## Teammate Routing

Start with `src/tasks/InProcessTeammateTask/types.ts` and `src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx`.

- `InProcessTeammateTaskState.identity` stores `agentId`, `agentName`, `teamName`, color, plan-mode requirement, and parent session ID.
- `currentWorkAbortController` stops the current turn without killing the whole teammate; `abortController` kills the teammate.
- `pendingUserMessages` is where input typed while viewing a teammate is queued.
- `messages` is a capped UI mirror for zoomed transcript display; full conversation history lives elsewhere and on disk.
- `getRunningTeammatesSorted()` is the canonical ordering for spinner tree, footer selection, and Shift+Up/Down navigation.

View transitions are in `src/state/teammateViewHelpers.ts`. Despite the name, `enterTeammateView()` also retains local-agent transcripts by setting `retain=true`, clearing `evictAfter`, and triggering REPL disk bootstrap.

## Roster And Mailbox Protocol (2026-07-12 hardening)

Start with `src/utils/swarm/teamHelpers.ts` (roster/allocation authority) and `src/utils/teammateMailbox.ts` (per-recipient mailbox files and envelopes). Both are consumed by `src/utils/swarm/inProcessRunner.ts`, `src/tools/SendMessageTool/SendMessageTool.ts`, `src/hooks/useInboxPoller.ts`, and `src/utils/attachments.ts`.

**Team file and recipient records.** `TeamFile.teamProtocolVersion: 2` plus `recipientRecords: TeamRecipientRecord[]` is the one identity authority shared by local aliases and teammate names inside a team (case-insensitive key via `recipientNameKey()`). Every mutation goes through the single async `transactTeamFile()` primitive (`teamHelpers.ts`): lock, fresh-read, validate version 2, apply one transaction, write once, unlock. No caller performs mailbox I/O while holding this lock. `readTeamSnapshot()` is the read-only, detached-immutable-snapshot counterpart used by routing/authority checks.

Recipient lifecycle: `reserved -> starting -> active -> stopped | terminated`, driven by `allocateTeamRecipient()`, `transitionTeamRecipient()` (compares both `allocationId` and expected `from` state; fails closed), and `recoverStartingRecipient()` (a dead launcher's `starting` record is `'active' | 'terminated' | 'manual_cleanup_required'`, never silently reclaimed from PID death alone). Keys are never reused within a team — a `terminated` record is a tombstone kept until explicit team cleanup, so a replacement teammate needs a fresh `Agent` call and gets a new `allocationId`, never the old identity back.

**Mailbox envelopes.** Every version-2 message (`src/utils/teammateMailbox.ts`) carries `protocolVersion`, an immutable `messageId`, sender/recipient agent IDs, sender/recipient allocation IDs, and exactly one payload class: `chat`, `notification` (`idle_notification`, `task_assignment` — unchanged model-visible behavior), or `control` (closed Zod union `MailboxControlPayloadSchema`, see `docs/maps/tools-permissions.md`). `writeToMailbox()` resolves the sender from runtime identity and returns `{written: true, messageId}` only after the JSON rewrite actually succeeds — a caught-and-swallowed write is a defect, not a documented behavior. `acknowledgeMailboxMessages()` marks only the exact IDs supplied as read; broad `markMessagesAsRead()`/`markMessagesAsReadByPredicate()`-style acknowledgement in the poller/attachment hot paths is the thing to search for and remove if you find it reintroduced. A concurrent mailbox append during acknowledgement remains unread. Unmarked legacy control-shaped JSON is rejected with an explicit protocol-version error (`protocol_mismatch`), not silently delivered or downgraded to chat.

**Broadcast truthfulness.** `SendMessageTool.ts` resolves a versioned recipient snapshot, releases the team lock, then writes with `Promise.allSettled`. `recipients` contains only successful writes; `failed_recipients` reports the rest; `success` is false if any intended recipient failed.

**Shutdown acknowledgement.** A teammate approving shutdown stays alive unless its acknowledgement write to the leader mailbox actually succeeds (`writeControlToMailbox` returning `written: true`) — see `docs/maps/tools-permissions.md` for the request-correlation and authority rules that gate this.

## Remote Agent Routing

Start with `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`.

- `checkRemoteAgentEligibility()` routes preconditions through `src/utils/background/remote/remoteSession.ts`.
- `registerRemoteAgentTask()` creates local task state, initializes an output file, persists session sidecar metadata, and starts polling.
- `restoreRemoteAgentTasks()` reads sidecar metadata after resume, fetches live remote status, drops archived/404 sessions, and restarts polling for live sessions.
- `startRemoteSessionPolling()` owns CCR event polling, output append, projected todo extraction, stable-idle handling, remote-review tag/progress scanning, timeout handling, completion checker hooks, and cleanup.
- `getRemoteTaskSessionUrl()` is the UI URL helper.

Remote reviews and ultraplan are specialized `remote_agent` states, not separate task types. The generic poller keeps logs/progress populated, while ultraplan completion may be owned by detached scanner code outside this file.

## Task Panel UI

| UI concern | Owner | Notes |
|---|---|---|
| Footer/status pill | `src/components/tasks/BackgroundTaskStatus.tsx` | Filters with `isBackgroundTask()`, excludes panel-managed local agents in ant builds, special-cases teammate spinner tree and viewed-agent mode. |
| One-line task rendering | `src/components/tasks/BackgroundTask.tsx` | Switches by task type; delegates shell/remote progress to `ShellProgress` and `RemoteSessionProgress`, and colors local-agent rows from blocked-handoff / verification verdict state. |
| Task dialog/list | `src/components/tasks/BackgroundTasksDialog.tsx` | Sorts running first, newest first; groups teammate/leader, shell, monitor, remote, local agent, workflow, dream. `x` stops, `f` foregrounds teammates/leader, Enter opens detail. |
| Shell details | `src/components/tasks/ShellDetailDialog.tsx` | Reads output tail from `getTaskOutputPath()` and refreshes while running. |
| Local agent details | `src/components/tasks/AsyncAgentDetailDialog.tsx` | Shows prompt/plan, progress activity, blocked-handoff reason or verification verdict, status, and `x` stop. |
| Teammate details | `src/components/tasks/InProcessTeammateDetailDialog.tsx` | Shows teammate identity/activity, prompt, progress, `x` stop, and `f` foreground. |
| Remote details | `src/components/tasks/RemoteSessionDetailDialog.tsx` | Normal remote, remote-review, and ultraplan detail variants; supports browser open and confirmed stop for web sessions. |
| Dream details | `src/components/tasks/DreamDetailDialog.tsx` | UI-only memory consolidation status and recent turns. |
| Shared status helpers | `src/components/tasks/taskStatusUtils.tsx` | Icons/colors/activity descriptions and footer hide predicate; shared by notifications and task rows when local agents need input or report verification verdicts. |

REPL wiring lives in `src/screens/REPL.tsx`:

- `showBashesDialog` opens `BackgroundTasksDialog`, including initial detail task IDs.
- `useBackgroundTaskNavigation()` handles Shift+Up/Down, Enter, `f`, `k`, and Escape around teammates and background tasks.
- Viewed-agent mode swaps `displayedMessages` to the selected teammate/local-agent transcript and hides the normal footer/sticky UI.
- Local-agent retained transcript bootstrap reads sidechain JSONL and UUID-merges with live streamed messages.
- `onAgentSubmit()` routes typed input to a viewed local agent or teammate.

## Input Routing

Start with `src/state/selectors.ts`.

- `getViewedTeammateTask()` narrows `viewingAgentTaskId` to an in-process teammate.
- `getActiveAgentForInput()` returns `leader`, `viewed` teammate, or `named_agent` local agent.
- REPL currently inlines some viewed-agent checks near message display, so verify both selector and REPL code before changing input behavior.
- Viewed local-agent input appends a user message immediately, then re-reads fresh AppState and calls `queuePendingMessageIfRunning()` (`src/tasks/LocalAgentTask/LocalAgentTask.tsx`) — an atomic, synchronous-updater-based queue-if-currently-running check that returns a boolean. (2026-07-12 hardening: replaced the older `queuePendingMessage()`, which queued unconditionally against a possibly-stale captured `task.status` and could silently queue into a task that had already stopped or race a concurrent resume. `queuePendingMessage()` still exists for internal callers that intentionally don't require a running check — do not use it for ordinary steering.) If queueing returns false, it resumes through `resumeAgentBackground()`.
- Viewed teammate input queues through `injectUserMessageToTeammate()`.
- `src/tools/SendMessageTool/SendMessageTool.ts` `routeToLocalWorker()` follows the same fresh-read-then-`queuePendingMessageIfRunning()` pattern rather than trusting the state captured when `resolveAgentTarget()` ran, closing a delayed-resolution race where the target could finish or get resumed by someone else between resolution and routing.

## Lifecycle And Notifications

- New task state should be built from `createTaskStateBase()` and registered with `registerTask()` so SDK `task_started` events emit once.
- Running task output should flow through `DiskTaskOutput`, task output symlinks, or `appendTaskOutput()` depending on task type.
- Task completion notifications are task-specific. `generateTaskAttachments()` intentionally does not notify completed tasks because that races per-task notifications.
- Terminal tasks are evictable only after `notified=true`; retained local agents and panel grace periods delay eviction.
- Queue model-facing task notifications through `enqueuePendingNotification()` with `formatTaskNotificationText()` and `toTaskNotificationOrigin()`.
- For SDK consumers, check direct `emitTaskTerminatedSdk()` / `enqueueSdkEvent()` paths; not every UI/model notification creates an SDK event automatically.

## Kill And Stop Behavior

| Trigger | Route | Important distinction |
|---|---|---|
| LLM or SDK stop task by ID | `src/tasks/stopTask.ts` | Looks up `getTaskByType()`, validates running, calls task `kill()`. Shell notifications are suppressed and SDK termination is emitted directly; agent tasks keep lifecycle notifications so partial results can be delivered. |
| Background task dialog `x` | `src/components/tasks/BackgroundTasksDialog.tsx` | Dispatches to each concrete task kill; ultraplan uses `stopUltraplan()` instead of generic remote kill. |
| Detail dialog `x` | Specific detail component | Same concrete kill path as list, with task-type-specific confirmation where needed. |
| Teammate selection `k` | `src/hooks/useBackgroundTaskNavigation.ts` | Kills selected running teammate only. |
| Escape while viewing teammate | `src/hooks/useBackgroundTaskNavigation.ts` | Running teammate: aborts current work only. Terminal/nonexistent teammate: exits view. |
| Ctrl+C while viewing teammate | `src/hooks/useCancelRequest.ts` | Kills running local-agent tasks through the aggregate agent kill path, then exits teammate view. |
| `chat:killAgents` | `src/hooks/useCancelRequest.ts` | Two-press confirmation, kills all running `local_agent` tasks, marks them notified, emits SDK terminations, and enqueues one aggregate notification. |
| Agent process cleanup | `src/tools/AgentTool/runAgent.ts`, `src/utils/forkedAgent.ts` | Kills shell and monitor tasks spawned by the agent so children do not outlive the agent. Synchronous and forked agents also release their Codex lease and scoped WebSocket session on exit. |
| Remote kill | `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` | Marks local task killed/notified and archives the remote session to stop cloud resource use. |

## Tests And Validation

Focused existing tests:

- `bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts`
- `bun test src/tasks/RemoteAgentTask/RemoteAgentTask.test.ts`
- `bun test src/utils/tuiSessionStatus.test.ts` (delegated working/waiting classification)
- `bun test src/tools/AgentTool/AgentTool.test.ts`
- `bun test src/tools/AgentTool/agentToolUtils.test.ts`
- `bun test src/tools/AgentTool/resumeAgent.test.ts`
- `bun test src/tools/AgentTool/prompt.test.ts`
- `bun test src/tools/ResumeAgentTool/ResumeAgentTool.test.ts`
- `bun test src/tools/SendMessageTool/SendMessageTool.test.ts src/tools/SendMessageTool/UI.test.tsx`
- `bun test src/utils/swarm/teamHelpers.test.ts src/utils/teammateMailbox.test.ts src/utils/attachments.test.ts src/hooks/useInboxPoller.test.ts src/utils/swarm/inProcessRunner.test.ts`
- `bun test src/tools/shared/spawnMultiAgent.test.ts src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.test.ts` (the plan's two-process `spawnMultiAgent.probe.test.ts` is not yet built — known gap, see plan Task 1 Step 9)

When changing shell task behavior, also search for task output and background shell tests outside `src/tasks/` because shell execution tests are not all colocated here.

When changing task UI, search for component tests first; this snapshot does not show a focused `src/components/tasks/*test*` suite, so pair source review with the relevant task lifecycle tests and manual TUI verification if the change is visual.

## Traps And Stale Assumptions

- Do not update `src/tasks.ts` alone. UI grouping, stop dispatch, task state union, and tests may also need updates.
- Do not use `isBackgroundTask()` as "all tasks"; it intentionally hides completed tasks and foreground tasks.
- Do not reuse `isBackgroundTask()` to decide whether the session is busy. It answers "should this row show in the task pill", so it counts a blocked agent and a long-running remote as active. Session status uses `deriveDelegatedTaskStatus()` in `src/utils/tuiSessionStatus.ts`.
- Do not report a task that is stalled on the user as working. A blocked local-agent handoff, a teammate awaiting plan approval, and remote ultraplan `needs_input` / `plan_ready` all stay `running`, but the session is waiting, not busy.
- Do not kill a teammate's whole task when the intended action is "stop current work"; use `currentWorkAbortController` where the UI already does.
- Do not emit duplicate task notifications. Many task types set `notified` atomically before enqueueing.
- Do not let terminal local-agent tasks disappear while retained in a viewed transcript; `retain`, `diskLoaded`, and `evictAfter` are coupled.
- Do not drop a local agent's `agentName` when serializing a task result or a
  nested transcript frame; it remains the friendly routing and display handle
  after the live task has stopped.
- Do not let agent-scoped shell/monitor tasks survive agent exit; keep `runAgent.ts` cleanup aligned with task types.
- Do not assume remote sessions are local-only tasks. Killing a remote task should archive the remote session and remove sidecar metadata.
- Do not route a steering message off a captured `task.status` read before an earlier `await` (target resolution, mailbox I/O). Re-read AppState and use `queuePendingMessageIfRunning()` immediately before deciding to queue vs. resume/fail — the target can transition mid-call.
- Do not reuse a team's recipient key/allocation after `terminated`. It is a tombstone; a replacement needs a fresh `Agent` call through `allocateTeamRecipient()`, not a rewrite of the old record.
- Do not acknowledge mailbox messages broadly (by predicate or "all unread"). Acknowledge only the exact `messageId`s a handler actually finished processing, or a concurrent append can be silently marked read.
