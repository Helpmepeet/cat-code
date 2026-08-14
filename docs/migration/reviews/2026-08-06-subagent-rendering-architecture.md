# Desktop subagent rendering architecture

**Source snapshot: 2026-08-06.** This note describes the implementation currently in `app/`, verified against source. It is an anchor for redesign work, not a product proposal. Where it conflicts with source, source is authoritative.

## Scope and vocabulary

The desktop app has three different subagent presentations. They consume two different data planes and should not be conflated:

1. **Transcript plane:** an `Agent` or legacy `Task` tool invocation is rendered inline in the conversation as an agent tool card. Nested frames emitted by that delegated worker appear inside that card.
2. **Session plane:** an `agent-mode.snapshot` is a session-scoped roster of local-agent workers. It drives the compact roster above the composer, the background-task strip, and the Workers tab in the Tasks dialog.
3. **Task inspection:** the same session-plane worker snapshot is shown in a read-only detail view inside the Tasks dialog. The detail can stop an eligible live worker.

The inline card does **not** read the session-plane roster, and the roster does **not** derive its entries from transcript tool cards. The separation is deliberate in `app/renderer/src/TranscriptView.tsx:1526-1533` and `app/renderer/src/transcriptProjector.ts:750-764`.

`AgentModeSnapshot.active` means that the sidecar process currently runs in Agent Mode. It is not a test for whether the session has delegated local agents. The snapshot can contain local-agent workers while `active` is false (`app/shared/protocol.ts:1238-1246`; `app/sidecar/agentModeDomain.ts:177-206`).

## Data contracts

### Transcript data

The transcript projector preserves `parentToolUseId` from engine frames. A non-null value identifies a subagent/skill frame associated with the parent Agent tool use (`app/renderer/src/transcriptProjector.ts:63-76`). Tool-use status and results are correlated at read time rather than stored on the row (`app/renderer/src/transcriptProjector.ts:22-31`, `:95-111`).

The displayed Agent card derives its identity only from the parent tool input:

- `subagent_type` supplies the type.
- `description` and `prompt` supply the delegated-task text.
- `run_in_background` identifies a background launch.
- a correlated tool result supplies the ordinary tool-card result.
- a later task-notification turn supplies a background worker's completion, including its summary, result text, and optional usage fields.

This conversion is implemented in `agentToolSourceOf()` at `app/renderer/src/TranscriptView.tsx:1526-1553`. It preserves `Task` as the source tool name and labels every other agent-family invocation as `Agent` in the display source (`:1543-1544`).

### Session roster data

The sidecar constructs `AgentModeSnapshot` from two engine-owned feeds:

1. **Live plane:** every `local_agent` entry in the current sidecar process's `AppState.tasks` store. These rows supply the current task identity, handle, role, status, description, background state, handoff state/reason, and verifier verdict.
2. **Persisted plane:** the current engine session's agent-mode state read through the engine's `readSessionState()` API. This adds persisted workers not already represented by a live worker with the same normalized handle. It also supplies objective, phase, synthesis status, resumability, origin, and output summary.

The sidecar does a union, not a field-level merge. Live workers take precedence; persisted workers are added only when their handle is not already live (`app/sidecar/agentModeDomain.ts:165-206`). A pending live task is normalized to the display status `running` (`:244-249`).

The wire contract is `AgentModeSnapshot` and `AgentModeWorkerItem` in `app/shared/protocol.ts:1196-1254`. The worker fields are:

| Field | Source/use |
| --- | --- |
| `agentId` | Stable worker identity. For a live task it is `task.agentId` or the task ID. |
| `handle`, `role`, `description` | Optional display identity and delegated-task text. |
| `status` | `running`, `completed`, `failed`, or `killed`. |
| `synthesisStatus` | Persisted `pending` or `synthesized`, used for result-ready/reviewed state. |
| `origin`, `resumable` | Persisted continuity metadata. |
| `handoffStatus`, `blockReason` | Live local-agent blocked-handoff state. |
| `verdict` | Live verifier verdict: `PASS`, `FAIL`, or `PARTIAL`. |
| `isBackgrounded` | Live task background state. |
| `outputSummary` | Persisted worker outcome summary. |

The snapshot deliberately exposes only display-safe worker state. It is outbound/read-only and does not contain credentials (`app/shared/protocol.ts:1178-1193`).

## Transport, refresh, and renderer state

On sidecar attachment, the server sends a worker snapshot alongside the background-task snapshot. The worker send is asynchronous because reading persisted session state is file-backed (`app/sidecar/sidecarServer.ts:606-635`). The sidecar also subscribes to the app-state store and broadcasts a fresh worker snapshot whenever the store changes (`app/sidecar/sidecarServer.ts:498-506`). `sendAgentModeSnapshot()` applies the normal outbound validation, secret guard, and size checks before writing the frame (`app/sidecar/sidecarServer.ts:2849-2887`).

The renderer receives server-frame batches through the preload bridge and routes each batch into its domain reducers, including `dispatchOrchestrator` (`app/renderer/src/App.tsx:840-898`). `reduceOrchestratorState()` stores `agent-mode.snapshot` by app session ID and removes that snapshot on a lifecycle frame (`app/renderer/src/orchestratorState.ts:27-64`). Every visible session pane selects its own snapshot; a background session cannot supply workers to the active session's UI (`app/renderer/src/App.tsx:2497-2501`).

The sidecar also has a narrow `agent-mode.set` write verb. The renderer can author only the requested boolean; the sidecar validates it locally, calls the engine's `matchSessionMode()` in that sidecar process, returns an acknowledgement, and then sends an updated snapshot when the mode changed (`app/shared/protocol.ts:1359-1405`; `app/sidecar/sidecarServer.ts:1827-1877`). This does not create, mutate, or control a worker directly.

## Rendered surfaces

### 1. Inline Agent card in the transcript

`ToolCard()` sends only the `agent` tool family to `AgentToolCard`; agent-control tools do not use this specialized card (`app/renderer/src/TranscriptView.tsx:1043-1065`).

An inline card renders:

- a normalized agent type label and role dot;
- a lifecycle label derived from the tool invocation and its completion correlation;
- a `nested` count when the delegated worker emitted child rows;
- nested child rows inside its collapsible body;
- a background worker's real completion body when the task-notification correlation exists.

The child rows are nested, not interleaved into the main transcript. `selectNestedTranscriptRows()` makes a tree from `parentToolUseId`; an orphaned child remains top-level rather than being discarded (`app/renderer/src/transcriptProjector.ts:580-650`). The agent card starts collapsed unless it has a background completion, in which case it starts expanded (`app/renderer/src/TranscriptView.tsx:1568-1643`).

The inline Agent card does not render an attention owner/baton because handoff ownership is session-plane task state and is absent from transcript frames. It explicitly passes `owner="none"` (`app/renderer/src/TranscriptView.tsx:1626-1638`).

When two or more top-level Agent tool uses share the same assistant message ID and tool name, `groupAgentDelegates()` renders one `DelegateGroup` containing their cards. This is a read-time layout transform, not a protocol frame or a persisted transcript item (`app/renderer/src/transcriptProjector.ts:656-748`; `app/renderer/src/TranscriptView.tsx:1647-1699`). Nested child rows are never grouped as co-spawned siblings.

### 2. Docked roster above the composer

`SessionPane` renders `OrchestratorRoster` in the central 740px composer column, above question and permission cards (`app/renderer/src/App.tsx:4341-4380`). It receives the session's `orchestratorWorkers`, the snapshot's `active` flag, and an open-tasks callback.

The roster behavior is:

- no workers: renders nothing;
- one worker: renders one full worker row;
- multiple workers: renders a compact summary row, with a hover-or-keyboard-focus popover containing every worker row;
- a single most-important worker can be promoted into the compact row; remaining workers become honest counts such as working, needs input, or done;
- clicking a row or summary opens the Tasks dialog.

Source: `app/renderer/src/OrchestratorRoster.tsx:60-150`, `:183-237`.

A full roster row may show a genuine handle, the worker description, a role dot/type label, lifecycle pip, and attention baton. It deliberately does not invent elapsed time, model, tools, account, cost, or traffic values (`app/renderer/src/OrchestratorRoster.tsx:9-30`, `:183-187`).

The roster callback passes a worker ID, but the current `App` callback ignores it and only opens the Tasks dialog (`app/renderer/src/App.tsx:2668-2671`). Therefore, clicking a particular docked roster row does **not** currently open that worker's detail view. This is documented directly in the roster source as a deferred behavior (`app/renderer/src/OrchestratorRoster.tsx:109-116`, `:200-207`).

### 3. Background-task strip

`TasksStrip` is a fixed bottom-right button on the chat view. It is not another worker roster. It combines:

- an orchestrator-derived subagent pill; and
- non-local-agent background task counts from `tasks.snapshot`.

It excludes `local_agent` rows from the task half because they already appear in the worker snapshot, preventing double counting (`app/renderer/src/App.tsx:3541-3562`, `:3564-3613`). It opens the same Tasks dialog as the docked roster.

### 4. Workers tab and worker detail in Tasks

`TasksDialog` has Tasks, Workers, and Leases tabs. The Workers tab is driven by `agentMode.workers`, not the generic task snapshot (`app/renderer/src/TasksDialog.tsx:90-137`, `:230-275`).

The Workers tab:

- groups workers by role, placing known orchestrator roles first and unknown roles in first-seen order;
- summarizes working, orchestrator-owned, user-owned, and settled workers;
- shows a lifecycle pip, genuine handle when present, description, and type;
- selects a worker by stable `agentId` for its detail view.

Source: `app/renderer/src/workerInspection.ts:15-75`; `app/renderer/src/TasksDialog.tsx:375-482`.

The detail view is read-only except for Stop. It can show:

- handle, role chip, lifecycle label, and attention owner;
- lease-derived account/failover data, background/origin/resumability metadata;
- delegated prompt/description;
- blocked-handoff reason;
- persisted output summary or verifier verdict;
- Stop only when the worker is a current, running worker with a live task ID.

The control selector excludes prior-origin and terminal workers (`app/renderer/src/workerInspection.ts:77-123`). Stop sends the existing `task.stop` route; the sidecar re-resolves the task in the current session's live task store and rejects unknown or terminal targets (`app/renderer/src/TasksDialog.tsx:484-580`; `app/sidecar/sidecarServer.ts:1880-1938`). There is no desktop worker transcript-focus view in this route.

## Display derivation rules

`agentIdentity.ts` owns the shared labels, tones, pips, and type normalization used by transcript cards, rosters, and detail panels. Known types have named labels; unknown non-empty roles are rendered neutrally with their literal role string rather than dropped (`app/renderer/src/agentIdentity.ts:70-120`, `:237-256`).

The session-plane lifecycle derivation is:

- prior + resumable: `resumable`;
- prior + non-resumable: `stale`;
- synthesis pending: `result-ready`;
- synthesis complete: `reviewed`;
- failed or killed: `attention`;
- completed: `completed`;
- otherwise: `running`.

Source: `app/renderer/src/agentIdentity.ts:336-346`.

The roster adds an independent ownership axis. A blocked handoff is `waiting` and owned by the orchestrator while Agent Mode is active; otherwise it becomes `needs-you` and is user-owned. Result-ready and failure/kill attention are orchestrator-owned. The derivation is implemented in `app/renderer/src/orchestratorState.ts:66-143`.

There is a documented semantic limitation: the actual blocked handoff goes to the parent loop regardless of whether Agent Mode is active, while this UI derives ownership solely from `AgentModeSnapshot.active`. Consequently, a normal delegating session can render a blocked worker as user-owned even though the assistant on the parent thread owns the next action (`app/renderer/src/OrchestratorRoster.tsx:23-30`). Preserve or consciously redesign this distinction; it is existing behavior, not an assumption.

## Data that is intentionally not rendered

Do not infer or mock the following for a worker. They are not on the worker snapshot:

- elapsed time;
- current model;
- tool count or tool traffic;
- cost/token accounting;
- progress timelines, files, upload/download counters, or fixture activity arrays;
- an account rotation/failover event history.

The shared identity source explicitly rejects several prototype-only fixture fields (`app/renderer/src/agentIdentity.ts:237-242`). The detail view can show the real current lease/account and aggregate failover count, but not an event history (`app/renderer/src/TasksDialog.tsx:583-636`).

Also, the current session roster is specifically a union of persisted workers and **local-agent tasks**. It is not a complete cross-kind task roster for remote agents or in-process teammates (`app/sidecar/agentModeDomain.ts:177-206`). The generic Tasks tab is the separate surface for task-snapshot task types.

## Redesign constraints grounded in the current implementation

A redesign can choose a different presentation, but these existing constraints are real:

1. Keep transcript-derived facts and session-derived facts distinct unless a new, explicit data seam is added. The current inline card has no roster handoff state, and the roster has no nested transcript timeline.
2. Treat the session worker snapshot as per-session and sidecar-owned. It is populated at attach and on app-state-store changes, then keyed by desktop app session ID in the renderer.
3. Worker state is derived at read time. Status correlation, nesting, parallel-delegate grouping, lifecycle labels, and ownership are selectors/transforms rather than separate stored UI records.
4. Preserve the sidecar boundary for worker control. The renderer can request Agent Mode on/off and name a task to stop; it does not create task state, choose a lease, or author a worker result.
5. Nested delegated frames currently arrive as full frames only. The projector records that subagent stream deltas are dropped engine-side (`app/renderer/src/transcriptProjector.ts:69-76`), so a redesign must not promise token-by-token child streaming without changing the engine data path.
