# D2 — Which Agent-Mode chrome survives

**Status: DECIDED 2026-07-04 (Phase-4 pre-work, parallel to Phase 2 / Phase-3 backlog).** This
settles INVENTORY's D2 — which of the prototype's orchestrator/agent display chrome
(`OrchestratorMode.jsx`: `OrchestratorModeWorkerRoster` / `WorkerDetail` / `WorkerFocusView` /
`AgentToolCard` / `DelegateGroup` / `BackgroundTaskStatus` / `deriveWorker` / `summarizeWorkers`;
`Messages.jsx`: `GroupedToolGroup` / `AgentEventRow` / `AgentMsgCard` / `AttachmentCard`) maps to
a real source shape (keep/adapt) vs. is invention with no backing (cut/redesign). Same class of
call as D1: architecture, decidable from source — decided, not deferred. All anchors verified
against the working tree 2026-07-04; where this doc and source disagree, source wins.
Companions: STATUS P2-0 note (subagent-frame findings), `specs/2026-07-03-S1-streaming.md`
(subagent deltas never arrive), PROGRAM-PLAN §5 (projector derives, never expects cards).

| # | Question | Verdict |
|---|---|---|
| **C1** | Is the Agent-Mode substrate real? | **YES, and richer than the prototype assumes.** Worker session model `AgentModeWorkerSession` (`src/agent-mode/sessionState.ts:26-44`): `status` running/completed/failed/killed (`:18-23`), `synthesisStatus` pending/synthesized (`:24`), `resumable`, `origin` current/prior, persisted per-session as `<transcript>.agent-mode-state.json` (`:68-71`, atomic temp+rename writes `:241-243`). The "blocked" model is real: `handoffStatus: 'done'\|'blocked'` (`src/tasks/LocalAgentTask/LocalAgentTask.tsx:184`) extracted from the worker's result text (`:473-483`), blocked workers retained (`:505-530`); `AskOrchestratorTool` defers to the parent loop (`shouldDefer: true`, `src/tools/AskOrchestratorTool/AskOrchestratorTool.ts:83`) via `enqueueAgentNotification` (`LocalAgentTask.tsx:245`). |
| **C2** | Which chrome keeps a source shape? | Roster, tasks panel (incl. Leases tab), worker detail, focus view, footer pill, inline agent card, delegate group, and the derivation helpers — **keep/adapt**, each anchored in §2. |
| **C3** | Which chrome is invention? | `AgentEventRow` (invented `agent-event` message type), `AttachmentCard` (engine-internal `AttachmentMessage` never reaches the seam), `GroupedToolGroup`/`MultiDiffCard` **as message types** (grouping is a projector derivation, not a frame) — **cut the invented message types**; redesign paths in §3. |
| **C4** | Nest or interleave subagent frames? | **NEST.** Frames with non-null `parentToolUseId` (P2-0: they DO reach the seam — agent/skill progress re-emit, `src/utils/queryHelpers.ts:135,145,194`) never interleave at transcript top level; they render inside the owning Agent tool card, collapsed by default. Binding on P2-2. |
| **C5** | Where does the chrome's data come from? | **Transcript-visible chrome derives from seam frames** (tool_use/tool_result correlation + nested subagent frames — P2-2 machinery). **Session-level chrome (roster/panel) reads the engine's persisted agent-mode state**, host-side, from the state file keyed off the transcript path (`sessionState.ts:68-71`) — or a C3-precedent read-only snapshot frame if polling the file proves wrong. **No mock worker objects, ever** (the prototype's `w.progress` arrays are fixture-fed; the real feeds replace them, they don't get restyled). |

---

## 1. What the recon established (source, not prototype comments)

The prototype's own grounding comments turned out accurate — re-verified rather than trusted:

- **Real TUI roster:** `AgentModeWorkerRoster` (`src/agent-mode/AgentModeWorkerRoster.tsx:30`)
  renders workers above the prompt with count summary + per-worker status lines — the direct
  ancestor of the prototype's `OrchestratorModeWorkerRoster`.
- **Real derivations:** `summarizeAgentModeWorkers` (`src/agent-mode/workerUxSummary.ts:96-112`)
  produces active/ready/reviewed/resumable/stale/attention counts; `getWorkerStatusLabel`
  (`:72-94`) is the lifecycle-label vocabulary; `deriveCurrentPhase`
  (`src/agent-mode/sessionState.ts:158-178`) derives the run phase. The prototype's
  `deriveWorker`/`summarizeWorkers` are re-expressions of these — including the two-axis
  subtlety it got right: there is **no** `escalate:user` field; a blocked worker is a terminal
  `completed` task carrying `handoffStatus:'blocked'`, owned by the orchestrator
  (`LocalAgentTask.tsx:184,473-530`, `AskOrchestratorTool.ts:83`).
- **Real footer pill:** `BackgroundTaskStatus` (`src/components/tasks/BackgroundTaskStatus.tsx:25`)
  with `getPillLabel`/`pillCtaText` (`src/tasks/pillLabel.ts`) and the shared status
  icon/color vocabulary (`src/components/tasks/taskStatusUtils.tsx:25,52`).
- **Real tasks panel:** `BackgroundTasksDialog` (`src/components/tasks/BackgroundTasksDialog.tsx:131`)
  plus per-type detail dialogs (`AsyncAgentDetailDialog.tsx`, `ShellDetailDialog.tsx`,
  `InProcessTeammateDetailDialog.tsx`, `RemoteSessionDetailDialog.tsx`).
- **Real "open a worker" experience:** the teammate view — `enterTeammateView` /
  `exitTeammateView` (`src/state/teammateViewHelpers.ts:46,88`) swap the main view to one
  task's thread (`viewingAgentTaskId`), with `retain: true` blocking eviction.
- **Real per-session leases:** `getCodexLeaseSnapshot` (`src/services/api/codexAccountLeaseManager.ts:163`),
  `getCodexLeaseForOwner` (`:194`), already surfaced in task UI via `getAgentProfileLabel`
  (`taskStatusUtils.tsx:86-91`).
- **Real inline agent card:** the Agent tool renders inline in the transcript like any tool —
  `renderToolUseMessage` (`src/tools/AgentTool/UI.tsx:458`), result (`:319`), progress
  (`:513`), and **grouped parallel agents** (`renderGroupedAgentToolUse`, `:740`).
- **Real worker naming:** role-keyed name pools (`src/agent-mode/workerNames.ts:1-22`).

## 2. Keep/adapt — each anchored

| Prototype surface | Verdict | Real shape it adapts |
|---|---|---|
| `OrchestratorModeWorkerRoster` (block above composer) | **adapt** | `AgentModeWorkerRoster.tsx:30` + `workerUxSummary.ts:96-112` |
| `deriveWorker` / `summarizeWorkers` | **adapt** | `getWorkerStatusLabel` `workerUxSummary.ts:72-94`, `deriveCurrentPhase` `sessionState.ts:158-178`, blocked/owner semantics `LocalAgentTask.tsx:184,473-530` + `AskOrchestratorTool.ts:83` — derive owner, never store it |
| `TasksPanel` (/tasks drawer) incl. Leases tab | **adapt** | `BackgroundTasksDialog.tsx:131`; leases `codexAccountLeaseManager.ts:163,194` (session-scoped, read-only — prototype's placement note is source-correct) |
| `WorkerDetail` | **adapt** | detail dialogs (`AsyncAgentDetailDialog.tsx` et al.); activity string `describeTeammateActivity` `taskStatusUtils.tsx:79` |
| `WorkerFocusView` (main column swaps to worker thread) | **adapt, claim reduced** | teammate view `teammateViewHelpers.ts:46,88`. The *viewing* is real. "Typing here goes to the worker" is only conditionally real — resume for terminal resumable workers (`src/tools/AgentTool/resumeAgent.ts`), messaging only where the task type supports it — gate the composer affordance per task type, don't promise it universally |
| `AgentToolCard` / `AgentMsgCard` (inline transcript card) | **adapt — as the Agent member of the P2-2 tool-card family** | `AgentTool/UI.tsx:458,319,513`; card status DERIVED from `tool_use`↔`tool_result` correlation + nested subagent frames (C4), never stored |
| `DelegateGroup` (parallel agent cards) | **adapt** | `renderGroupedAgentToolUse` `UI.tsx:740` |
| `BackgroundTaskStatus` (footer pill) | **adapt** | same-named `BackgroundTaskStatus.tsx:25` + `pillLabel.ts`; amber only on user-owned attention, matching source's warning states |

## 3. Cut / redesign — each justified by "no seam backing"

| Prototype surface | Verdict | Why / redesign path |
|---|---|---|
| `AgentEventRow` (`msg.type === 'agent-event'`) | **CUT as a row/message type** | No `agent-event` member exists in the seam union (P2-0 census: 19 members / 15 discriminants, `coreTypes.generated.ts:760`). Lifecycle is *derived state*, not a frame. The only real "task event reaches the transcript" shape is the task-notification user message (`src/types/message.ts:13`, origin.kind `task-notification` → the W3 `TaskAssignRow`, which stays). Redesign: lifecycle state renders as badges *on the agent tool card* (C4 nesting), not as standalone rows. |
| `AttachmentCard` (`msg.type === 'attachment'`) | **CUT for now — extend-engine-vs-change-UI flag** | `AttachmentMessage` is real but engine-internal (`src/types/message.ts:92-97`, payload `attachment: unknown`) and is NOT in the seam `SDKMessage` union — it cannot arrive at the app today (same class as P2-0's 8 unreachable variants). If attachment rendering is wanted, that is a flagged engine-extension decision (C3 precedent), not silent UI invention. |
| `GroupedToolGroup` (`msg.type === 'grouped'`) | **CUT the message type, KEEP grouping as derivation** | No `grouped` frame exists. Read/search collapsing is real display logic (`src/utils/collapseReadSearch.ts`) applied *at render time*. Redesign: a projector/selector-level grouping over correlated tool rows — P2-2 scope, zero new frame types. |
| Prototype worker data feeds (`w.progress`, `w.files`, `w.up/down`, `MOCK_CODEX_LEASES`) | **CUT** | Fixture fields. Progress/activity derive from nested frames (C4) and progress re-emits; files/token stats render only where a real field exists (`AgentModeWorkerSession.outputSummary`, result frames, lease snapshot); anything without a real field is dropped, not mocked. |
| `OrchestratorDemoSwitch` | **already CUT** | INVENTORY CUT table — demo scaffold. Reconfirmed; no change. |

## 4. The data-path rule (what makes the keeps honest)

Two distinct feeds, never conflated:

1. **Transcript plane** — everything inside the transcript (inline agent cards, nesting,
   grouping) derives from seam frames only: `tool_use`/`tool_result` correlation (P2-2) plus
   nested subagent full frames (`queryHelpers.ts:135,145,194`; S1: deltas never arrive, so
   there is no nested *streaming* — nested content updates frame-by-frame).
2. **Session plane** — roster / tasks panel / footer pill state. The engine already persists
   exactly this (`<transcript>.agent-mode-state.json`, `sessionState.ts:68-71`) and the host
   knows the transcript path family from `engineSessionId` (D1 R6). v1 read path: host-side
   read of that file (it is engine-*written*, host-*read* — no writer contention). If file
   polling proves wrong in practice, the fallback is a C3-precedent read-only snapshot frame —
   a ≤1-page flagged proposal, not an ad-hoc frame (F3 rule).

Cross-plane consistency (a card says running, the roster says failed) resolves toward the
session plane for roster surfaces and toward frame correlation for transcript surfaces; they
are allowed to disagree transiently, same as the TUI.

## 5. Pressure test

- **"The Agent-Mode substrate is TUI-process state — none of it flows over the desktop seam;
  you kept chrome whose data feed doesn't exist."** The strongest attack, and it is priced in
  by §4: transcript chrome is fed by frames proven to reach the seam (P2-0 ran the census;
  subagent re-emits verified at `queryHelpers.ts:135-194`), and session chrome is fed by
  engine-persisted state on disk, not by TUI React state. What genuinely does NOT cross today
  (in-process teammate live state, `AppState.tasks` runtime fields like `isIdle`) ships
  degraded or not at all — the keeps are scoped to fields that exist in `AgentModeWorkerSession`
  or in frames. If even the state-file read proves unworkable, the roster ships as a
  transcript-derived approximation and the gap is flagged — never mocked.
- **"INVENTORY said inline `AgentToolCard`/`DelegateGroup` should be cut or replaced with task
  dialog/list plumbing — you overruled the row."** Deliberately, on source evidence the row
  lacked: the engine renders agent tool use inline in the transcript as first-class tool
  chrome (`UI.tsx:458`) *including grouped parallel agents* (`:740`). Inline cards are the
  real idiom, not an invention; what deserved cutting was their *fixture data feed*, and §3
  cuts exactly that. The INVENTORY row's instinct (don't build bespoke agent chrome beside the
  tool system) survives as C4+§4: the card IS tool-family chrome.
- **"Nesting subagent frames hides information the TUI shows interleaved."** The TUI does not
  interleave child frames into the parent transcript either — it shows progress inside the
  tool row (`UI.tsx:513`) and full detail behind dialogs/teammate view. Nesting matches
  source; interleaving would be the invention (and P2-0 explicitly warned "today they'd
  interleave" as a defect to fix).
- **"`AgentEventRow` cut loses the 'worker finished' moment in the transcript."** No: the real
  notification path already lands in the transcript as a task-notification user message
  (`message.ts:13` → `TaskAssignRow`, kept in W3), and the orchestrator narrates outcomes in
  its own assistant turns (the prototype's own header comment says exactly this). The cut
  removes a duplicate, invented channel.

## 6. What this unblocks / carry-forwards

- **P2-2 binding:** C4 (nest, never interleave) + `GroupedToolGroup`-as-derivation are inputs
  to the tool-card family session (its spec already anticipated the nest-vs-hide ruling).
- **Phase-4 backlog:** the Orchestrator/W3-display-type rows can now be decomposed: roster +
  tasks panel + focus view (session plane, §4.2 read path), inline card + grouping (transcript
  plane, extends P2-2), footer pill.
- **Carry-forward (flagged, not solved):** if the agent-mode state file read is rejected at
  implementation time, the C3-style `agentMode.context` snapshot frame proposal must go through
  the F3 extend-engine-vs-change-UI gate. Do not widen the envelope silently.
- **Carry-forward:** in-process teammate live-activity fidelity (`describeTeammateActivity`
  inputs) is not seam-visible; the desktop shows persisted/derived status only until an
  explicit engine extension is ruled.
