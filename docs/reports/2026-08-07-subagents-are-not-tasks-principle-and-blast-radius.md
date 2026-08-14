# Local subagents are not user-facing tasks: principle and blast-radius report

**Date:** 2026-08-07
**Scope:** Cat Code desktop semantics, with engine/TUI/protocol impact assessed
**Status:** decision proposal revised after source-verified adversarial review; no implementation and no visual-design recommendation
**Source basis:** current working-tree source on 2026-08-07; source wins over this dated report

## 1. Executive conclusion

Adopt the principle at the **user-facing classification boundary**:

> A local subagent represented by `local_agent` is a worker, not a user-facing task. A worker may
> be backed internally by a task record, but that implementation detail must not make one worker
> appear in both the Tasks and Workers counts or lists.

Do **not** remove `local_agent` from the engine task framework. That record currently owns
execution lifecycle, cancellation, output, notification, retention, resume, SDK bookends, Codex
lease release, and several safety gates. Replacing it with a new engine-wide worker model would
turn a small product-semantics correction into a cross-runtime migration.

The recommended change is therefore:

1. Keep `local_agent` in `AppState.tasks`, `TaskType`, `tasks.snapshot`, task-control, and SDK
   events as an internal execution record.
2. Treat `agent-mode.snapshot.workers` as the user-facing worker authority.
3. Exclude true local-subagent items from the user-facing Tasks count and Tasks list. Preserve the
   synthetic `agentType: 'main-session'` record as a Task and remove it from the Worker population.
4. Keep lease counts independent. A lease is an account allocation, not a task or worker count.

This is not a new architecture. The desktop's bottom-right `TasksStrip` already implements the
cross-population non-duplication half of this rule: it counts workers from the worker feed and
explicitly excludes `local_agent` from the task half (`app/renderer/src/App.tsx:3635-3638`). It is
not a complete precedent because its worker population currently includes synthetic backgrounded
main sessions, while its inclusion of foregrounded local agents needs to be an explicit invariant.
Separately, `TasksDialog` still groups every
`tasks.snapshot` item into Tasks while also showing the same local agents under Workers
(`app/renderer/src/TasksDialog.tsx:128-133,212-250`).

## 2. Proposed semantic model

### 2.1 Worker

A worker is a delegated actor with identity and lifecycle:

- stable `agentId`;
- optional handle and role;
- delegated work description;
- running/completed/failed/killed state;
- background, handoff, attention-owner, resumability, result, and verifier state;
- an eligible Stop action.

The desktop authority is `AgentModeWorkerItem` in `agent-mode.snapshot`
(`app/shared/protocol.ts:1206-1254`). The sidecar builds it from live `local_agent` records plus
the current session's persisted worker state (`app/sidecar/agentModeDomain.ts:165-206`).

### 2.2 Task

A user-facing task is a background unit of execution that is not already represented as a worker.
Under the immediate desktop scope, this means the Tasks surface continues to show shell work,
dreams, monitors, workflows, the currently supported remote/team task kinds, and a backgrounded
main session. The latter happens to use a synthetic internal `local_agent` record but is not a
delegated subagent.

The internal `TaskType` union is broader and deliberately remains broader. It includes
`local_agent` because the task framework is an execution substrate, not because the product must
call a subagent a task (`src/Task.ts:6-13`; `src/tasks/types.ts:12-29`).

### 2.3 Lease

A lease answers a different question: which Codex account is the main thread or a subagent using
right now? It is an owner-to-account resource assignment with strategy, state, duration, and
failover metadata (`app/shared/protocol.ts:1256-1357`).

Leases are neither workers nor tasks:

- one worker may have no lease before its first Codex request;
- an Anthropic-path worker may have no Codex lease at all;
- the main thread can hold a lease without being a worker-row entry;
- several owners can share one account because leases are not locks;
- therefore Workers and Leases counts are not expected to match.

### 2.4 Transcript Agent cards

Inline Agent cards are transcript-plane evidence of delegation, not another session-level count.
They derive from Agent tool messages and nested child frames. They must not be merged into the
Tasks or Workers count model merely because they depict the same real-world actor. The existing
plane separation is intentional (`app/renderer/src/transcriptProjector.ts:776-790` and
`app/renderer/src/TranscriptView.tsx:2981-3039`).

## 3. Required invariants

1. **No double membership on user-facing surfaces.** A live local subagent contributes to Workers,
   never to both Workers and Tasks.
2. **No duplicate identity within Workers.** A live worker and its persisted representation must
   collapse to one Worker entry even when its handle is absent or changes.
3. **Internal storage does not dictate product vocabulary.** An internal `local_agent` task record
   may remain while the UI calls it a worker.
4. **Counts name their population.** A Tasks count is a count of user-facing tasks; a Workers count
   is a count of workers; a Leases count is a count of active owner-account assignments.
5. **Control capability survives reclassification.** Hiding the worker's backing record from the
   Tasks list must not remove Stop, result inspection, blocked handoff, or lifecycle visibility.
6. **Data planes remain authoritative.** Tasks come from the task snapshot, workers from the worker
   snapshot, leases from the lease snapshot, and inline cards from transcript frames.
7. **No protocol rename is required.** Internal names such as `local_agent`, `tasks.snapshot`,
   `task.stop`, and `task_notification` may remain stable.
8. **No silent loss during partial data.** If the worker feed cannot represent a kind, that kind
   must remain in Tasks until a real worker representation exists.

## 4. Current behavior and inconsistency

### 4.1 What is already correct, and what is not

`TasksStrip` correctly reconciles cross-population counts. It derives the worker label from
`agent-mode.snapshot`, filters `local_agent` out of the task half, and renders the remaining
background-task count (`app/renderer/src/App.tsx:3624-3668`). A regression test pins the ordinary
mixed case: one local agent plus one shell renders as one subagent and one background task, not two
background tasks (`app/renderer/src/App.test.tsx:1713-1727`). That non-duplication rule should be
centralized and shared with the dialog.

The strip's worker half is not otherwise correct. `LocalMainSessionTask` creates a backgrounded,
running `local_agent` with `agentType: 'main-session'`
(`src/tasks/LocalMainSessionTask.ts:120-138`). `agentModeSnapshot` selects every `local_agent`
without filtering that type (`app/sidecar/agentModeDomain.ts:177-186`), the renderer classifies it
as background work (`app/renderer/src/orchestratorState.ts:79-99`), and the pill reports it as a
subagent (`:174-187`). Backgrounding the user's own main session therefore currently produces a
false “1 subagent active” claim. The worker feed also includes the foregrounded local agent that
`tasks.snapshot` intentionally removes from its display items (`app/sidecar/tasksDomain.ts:57-72`).
The implementation must preserve the strip's non-duplication rule without copying its population
semantics blindly: the main-session entry is a defect, while foregrounded-subagent inclusion is an
intentional actor-identity rule that needs a regression test.

### 4.2 What is currently inconsistent

`TasksDialog` calls `groupTaskItems(snapshot)` without worker reconciliation, then builds `flat`
from every active and completed item (`app/renderer/src/TasksDialog.tsx:123-133`). Those unfiltered
values drive:

- the dialog header's active/completed counts (`:210-216`);
- the Tasks tab count (`:233-239`);
- the Tasks list rows (`:275-294`);
- keyboard selection and `K` Stop routing (`:145-185`);
- the empty state (`:275-283`).

The same dialog separately renders `agentMode.workers` under Workers (`:133,240-246,269-274`). A
live `local_agent` is therefore present in both populations. The source comment explicitly chose
this three-tab superset behavior (`:30-34`), and the parity ledger records the same rationale
(`docs/migration/PARITY-LEDGER.md:1488`). Adopting the new principle supersedes that rationale.

Concrete current example:

- two live local subagents;
- one background Bash process;
- no completed work.

The strip already reports **2 subagents + 1 background task**. The dialog can report **3 active**,
**Tasks 3**, and **Workers 2**. Nothing crashed, but the product taxonomy contradicts itself.

### 4.3 Existing decisions affected

The 2026-07-30 orchestrator ruling chose one combined entry point, a Workers detail inside
`TasksDialog`, and no second footer pill
(`docs/migration/decisions/ORCHESTRATOR-IN-SESSION.md:428-463`). It also required task and worker counts to be reconciled without double-counting the
same `local_agent` (`:187-201`). The strip implements that requirement, while the dialog does not.

The proposed principle does not reopen the ruled placement, worker-detail, lease, result, or
control decisions. It changes only the classification of `local_agent` inside the Tasks
population. Implementation should amend the decision's old “Tasks is a superset” explanation and
the corresponding parity-ledger evidence rather than leaving contradictory canonical text.

## 5. Recommended implementation boundary

### 5.1 Renderer-only classification

Create one read-time selector in `app/renderer/src/tasksState.ts` that returns the user-facing Task
population. For the immediate desktop scope it should exclude true local-subagent items before
sorting and active/completed grouping: `type === 'local_agent'` with an `agentType` other than the
synthetic `main-session`. Do not use a blind type-only predicate, because that would also remove the
user's backgrounded main session from Tasks.

Both `TasksDialog` and `TasksStrip` should consume this selector. The current one-off filter inside
`TasksStrip` (`app/renderer/src/App.tsx:3635-3638`) should not remain a separate rule because that is
how the two surfaces drifted.

Filtering by task type is preferable to an ID join against the worker snapshot:

- the immediate principle is categorical: a true local subagent is not a user-facing task, while a
  synthetic backgrounded main session is;
- both sidecar builders read `AppState.tasks`; `tasksSnapshot` applies background visibility and
  foreground exclusion, while `agentModeSnapshot` selects every `local_agent`
  (`app/sidecar/tasksDomain.ts:65-78`; `app/sidecar/agentModeDomain.ts:177-206`);
- consequently, the live Worker population is structurally a superset of the task-plane
  `local_agent` population. Categorical filtering cannot permanently orphan a task-visible local
  agent, although separately delivered frames can still be momentarily stale;
- the worker snapshot's asynchronous persisted-state read adds persisted-only entries; it does not
  determine whether a live task becomes a Worker.

This selector is a display projection only. It must not mutate or replace the stored
`TasksSnapshot`.

### 5.2 Keep the raw task snapshot intact

Do not remove local agents from `tasks.snapshot` in `app/sidecar/tasksDomain.ts`. The snapshot also
carries `subagents` metadata used to join transcript messages to engine-minted subagent identity
(`app/shared/protocol.ts:1130-1165`; `app/renderer/src/MetadataInspector.tsx:104`). The raw task ID
also remains the control target that Worker detail passes to `task.stop`
(`app/renderer/src/workerInspection.ts:77-97`).

Keeping the raw snapshot avoids a protocol change and preserves diagnostic/metadata consumers
while allowing each user-facing projection to apply the correct vocabulary.

### 5.3 Keep worker control on the worker path

The Tasks tab currently advertises `K` Stop for its selected task. Once local agents no longer
appear there, that keyboard path stops only genuine task rows. A worker remains stoppable from its
Worker detail when current and running (`app/renderer/src/workerInspection.ts:91-97`;
`app/renderer/src/TasksDialog.tsx:258-266`).

That parity depends on the sidecar folding a pending task status to the Worker's `running` status
(`app/sidecar/agentModeDomain.ts:244-249`). The Tasks keyboard path permits any non-terminal task,
whereas Worker detail permits only `status === 'running'`
(`app/renderer/src/tasksState.ts:61-74`; `app/renderer/src/workerInspection.ts:91-96`). Preserve this
fold or broaden the Worker Stop gate explicitly; otherwise a future “honest pending state” change
would silently remove Stop from queued local agents.

The sidecar should continue to execute both actions through the existing task-control seam. It
already returns “Stopped worker” for `local_agent` and “Stopped task” for other types
(`app/sidecar/taskControlDomain.ts:72-103`). Product vocabulary is therefore already separated at
the result-message boundary.

## 6. Blast radius

### 6.1 Recommended classification change plus Worker-feed hardening: moderate

| Surface | Required change | Risk |
|---|---|---|
| `app/renderer/src/tasksState.ts` | Central user-facing task selector/grouping that excludes true local subagents while retaining `agentType: 'main-session'`; audit local-agent-only display branches and `TASK_KIND_META.local_agent` for deliberate retention or removal | Low; pure read-time derivation, while shared agent logic remains reachable for remote/team kinds |
| `app/renderer/src/TasksDialog.tsx` | Use filtered groups for header counts, Tasks badge/list, selection, and keyboard Stop; make the zero-Tasks copy stop promising that an agent will appear there | Medium; several values and one factual empty-state sentence must stay aligned |
| `app/renderer/src/App.tsx` | Replace the strip's local filter with the shared selector; consume the corrected main-session/foregrounded-worker population | Medium; ordinary mixed counts should remain stable, but today's false main-session count changes |
| `app/sidecar/agentModeDomain.ts` | Exclude `main-session` from Workers; replace handle-only live/persisted de-duplication with stable identity semantics | Medium; this is targeted Worker-feed hardening, not a protocol redesign |
| `app/renderer/src/tasksState.test.ts` | Pin mixed worker/task filtering, active/completed grouping, null snapshots, and the disposition of local-agent-only helpers | Low |
| `app/renderer/src/TasksDialog.test.tsx` | Pin disjoint counts/lists, truthful empty copy, and move local-agent Stop/state assertions to the Worker path | Medium; current tests explicitly render local agents as Tasks |
| `app/renderer/src/App.test.tsx` and `orchestratorState` tests | Preserve ordinary no-double-count behavior; add backgrounded-main-session and foregrounded-agent population cases | Medium; both sides of the actor-vs-task rule need regression coverage |
| Decision/ledger/STATUS docs | Record that the Tasks population is no longer a superset containing workers | Medium bookkeeping; required to avoid canonical drift |

No renderer state migration or protocol migration is needed. Counts are derived from live snapshots
and nothing relevant is persisted in local storage. The sidecar work is limited to correcting which
existing records enter the existing Worker array and how its two sources de-duplicate.

### 6.2 Surfaces that should not change under the recommendation

- `app/shared/protocol.ts`: no type, frame, or version change.
- `app/sidecar/tasksDomain.ts`: continue projecting the raw engine task store.
- `app/sidecar/agentModeDomain.ts`: its protocol shape and live task authority remain, although its
  population/de-duplication policy needs the targeted audit above.
- `app/sidecar/leaseDomain.ts`: continue projecting account allocation.
- `app/sidecar/taskControlDomain.ts`: continue resolving Worker Stop through the backing task ID.
- `app/main/replayBuffer.ts`: sticky snapshot behavior is unchanged.
- `app/renderer/src/MetadataInspector.tsx`: keep consuming `TasksSnapshot.subagents`.
- `app/renderer/src/TranscriptView.tsx` and `transcriptProjector.ts`: inline Agent cards and
  completion notices are unchanged.
- engine `src/Task.ts`, `src/tasks/**`, and `src/tools/AgentTool/**`: no runtime refactor.
- SDK `task_started` / `task_notification` events: no compatibility change.
- idle-engine parking: `hasLiveWork()` intentionally reads raw, foreground-inclusive
  `AppState.tasks`, not the display snapshot (`app/sidecar/tasksDomain.ts:21-49`).

### 6.3 Removing local agents from the desktop wire: medium to high, not recommended

If `tasks.snapshot.items` stopped carrying `local_agent`, the immediate UI duplication would also
disappear, but the blast radius would expand to:

- sidecar snapshot semantics and tests;
- task-control targeting assumptions;
- transcript metadata joins if `subagents` were removed or conflated with `items`;
- attach/rebroadcast and secret-guard tests;
- protocol comments and compatibility expectations;
- worker-detail control tests;
- diagnostics that intentionally inspect the raw task plane.

It would also create two meanings for the same task store: the engine and TUI would still call the
record a task while the desktop wire selectively erased it. The renderer projection is the cleaner
classification boundary.

### 6.4 Removing `local_agent` from the engine task model: very high, not recommended

An engine-level split affects at least:

- `TaskType`, `TaskState`, `AppState.tasks`, task registration, state updates, retention, and
  eviction (`src/Task.ts`; `src/tasks/types.ts`; `src/utils/task/framework.ts`);
- foreground/background Agent launch and conversion (`src/tools/AgentTool/AgentTool.tsx`;
  `src/tasks/LocalAgentTask/LocalAgentTask.tsx`);
- abort, aggregate kill, `TaskStopTool`, SDK stop control, and desktop `task.stop`
  (`src/tasks/stopTask.ts`; `app/sidecar/taskControlDomain.ts`);
- TaskOutput and sidechain output-file/symlink behavior (`src/tools/TaskOutputTool` and task
  disk-output helpers);
- asynchronous completion notifications and partial results;
- resume and mid-turn message steering;
- Codex account lease registration/release;
- SDK `task_started` and `task_notification` bookends (`src/utils/task/framework.ts:69-112`);
- TUI task footer, `/tasks` dialog, task navigation, viewed-agent mode, and backgrounding;
- desktop task, worker, lease, metadata, replay, and idle-park seams;
- tests across engine, sidecar, renderer, SDK, and TUI.

This migration might eventually produce a cleaner internal ontology, but it is not required to
make the product truthful. It would add compatibility and lifecycle risk without a user benefit
beyond what the renderer classification plus targeted Worker-feed correction already delivers.

## 7. User-facing impact

Under the recommended change:

- the bottom status strip keeps its no-double-count behavior for ordinary local subagents and
  tasks; its count changes for the present main-session defect, while a foregrounded true subagent
  intentionally remains counted as a Worker;
- the Tasks dialog's active/completed header numbers decrease when local subagents exist;
- the Tasks tab count decreases by the same amount;
- local subagent rows disappear from the Tasks list;
- the Tasks empty state must no longer say “Run a background bash, agent, or dream to see it here,”
  because an agent will now appear under Workers rather than Tasks;
- those subagents remain in Workers with the same underlying lifecycle, attention, detail, result,
  and Stop capabilities, but not always the same state word: a blocked local agent changes from the
  Tasks path's “Needs you” to the Worker path's intentional “waiting” state while an orchestrator is
  active (`app/renderer/src/tasksState.ts:163-178`;
  `app/renderer/src/orchestratorState.ts:72-99`);
- Bash and other real task rows remain selectable and stoppable from Tasks;
- Leases remains independent and can show a different number from Workers;
- inline Agent cards, the docked roster, transcript completions, and composer behavior do not
  change;
- a session may correctly show zero Tasks while Workers is non-zero.

The user will notice the changed dialog counts/list/empty copy and, when backgrounding a main
session, the corrected strip classification. There should be no change to execution, performance,
stored sessions, worker execution, provider routing, or account selection.

This report intentionally does not decide the dialog/container title, tab placement, entry-point
wording, or other visual design. Those labels deserve a separate design pass because a container
that hosts Tasks, Workers, and Leases while being titled “Tasks” is a naming question beyond the
classification rule.

## 8. Edge cases and unresolved scope

### 8.1 What counts as a subagent?

The current Worker feed contains live `local_agent` records plus persisted Agent Mode workers. It
does not model every agent-like task kind. `remote_agent` and `in_process_teammate` still exist only
in the generic task plane for this desktop surface.

Immediate recommendation: apply the rule to `local_agent` only. Do not hide other agent-like kinds
until the Worker plane can represent their identity, lifecycle, control, and result without loss.
If the long-term principle is “no actor of any kind is a task,” that is a separate worker-union
project with a materially larger protocol and UI blast radius.

### 8.2 Backgrounded main sessions

`LocalMainSessionTask` also creates a synthetic `local_agent` with
`agentType: 'main-session'` (`src/tasks/LocalMainSessionTask.ts:120-138`). The current
`agentModeDomain` selects every `local_agent` into the worker feed
(`app/sidecar/agentModeDomain.ts:177-186`), while user-facing roster copy calls the resulting population “subagents.” This is an
existing, user-visible classification defect, not merely a future edge: the renderer maps the
backgrounded record to `background` and the pill includes that state in “N subagents active”
(`app/renderer/src/orchestratorState.ts:79-99,174-187`).

Recommended classification: a backgrounded main session is a Task, not a Worker. It is the user's
existing primary actor continuing in the background, not a delegated actor, and the task snapshot
already carries enough `agentType` information to preserve it. The Worker snapshot should exclude
`agentType === 'main-session'`; the renderer Task selector should retain that same record. The
existing `TasksStrip` provably does the opposite today—filtering it from the task half and counting
it in the worker half—so both sides require explicit regression coverage.

### 8.3 Live population asymmetry and snapshot timing

At the pure snapshot-builder level, every `local_agent` included in `tasks.snapshot.items` is also
included in the live Worker population: Tasks applies visibility and foreground filters, while
Workers filters the same `AppState.tasks` map only by `type === 'local_agent'`
(`app/sidecar/tasksDomain.ts:65-78`; `app/sidecar/agentModeDomain.ts:177-186`). Worker completeness
for task-visible local agents is therefore structural, not an open test hypothesis.

The meaningful asymmetry is the other direction. A foregrounded local agent is intentionally absent
from `tasks.snapshot.items` because the user is viewing it in the main pane, but remains in Workers
and can contribute to the strip's “subagents active” label. Under the actor-based principle in this
report, that is intentional: foregrounding changes where the actor's transcript is viewed, not
whether it is a delegated Worker. Pin the behavior explicitly so a future background-only filter
does not silently change the Worker population.

The two frames are still delivered separately, so the renderer can briefly hold different snapshot
generations. Categorical filtering is robust against cross-list duplication during that interval;
it may transiently show neither representation until the Worker frame arrives, but it does not need
an ID join. The asynchronous persisted-state read affects persisted extras, not live-worker
membership (`app/sidecar/agentModeDomain.ts:87-102`).

### 8.4 Duplicate identities inside Workers

Treat `agent-mode.snapshot.workers` as the intended worker authority, but do not assume its current
union is duplicate-free. Live and persisted workers are de-duplicated only by normalized handle;
every persisted worker with a null handle is retained (`app/sidecar/agentModeDomain.ts:188-205`).
This conflicts with `toLiveWorkerItem`'s own statement that `agentId` matches the persisted identity
for de-duplication (`:209-216`). An unnamed worker present in both planes can therefore appear
twice, inflating the Workers tab and strip even after Tasks-versus-Workers overlap is fixed.

The implementation should define stable-identity de-duplication—normally `agentId` first, with a
carefully justified handle fallback—and test missing, changed, duplicate, and case-variant handles.
This is a Worker-plane correctness prerequisite, not a reason to keep the worker in Tasks.

### 8.5 Completed and prior workers

Workers can include persisted prior-session entries that have no live task record. They should
remain Worker-only. Terminal live workers retained for blocked handoff, result review, or panel
grace must also remain visible after their backing row disappears from Tasks.

The principle does not decide whether the Workers tab badge counts all retained workers or only
active workers. That is a separate count-definition/design decision.

### 8.6 TUI consistency

The terminal UI still treats local agents as part of the task framework and can list them in its
background-tasks dialog (`src/components/tasks/BackgroundTasksDialog.tsx:122-225`). It also has
special worker/agent roster and pill behavior. Applying the product principle to TUI presentation
would require a separate reachability review so hiding a local-agent row does not remove its only
detail, navigation, resume, or stop path.

No TUI change is required for the desktop correction. A product-wide wording cleanup should be a
follow-up, not bundled into the renderer fix.

## 9. Behavioral acceptance criteria for a future implementation

1. Given two live non-main-session local agents and one live Bash process, the strip and dialog
   both classify them as two Workers and one Task.
2. No local-agent ID appears simultaneously in the Tasks list and Workers list.
3. A live worker and the same persisted worker produce one Worker row even when the handle is null,
   changed, duplicated, or differs only by case.
4. Tasks header counts, Tasks tab count, list sections, selection index, empty state, and keyboard
   Stop all derive from the same filtered array.
5. The zero-Tasks copy does not claim that running an agent will create a Task row.
6. A running or pending local agent remains stoppable from Worker detail; an unknown or terminal
   target still fails closed at the sidecar. The pending case remains covered if status folding or
   the Worker Stop gate changes.
7. A blocked local agent under an active orchestrator uses the Worker path's intentional neutral
   “waiting” state rather than restoring the removed Tasks row's “Needs you” wording.
8. A blocked or completed retained Worker remains inspectable after disappearing from Tasks.
9. A prior persisted Worker with no task record remains visible only in Workers.
10. A session with Workers but no non-agent task shows zero Tasks without claiming the session is
    idle.
11. A foregrounded true local subagent remains one Worker and contributes consistently to the
    Worker count/strip without reappearing as a Task.
12. Leases count active leases independently and can be zero, equal to, or greater than Workers.
13. `TasksSnapshot.subagents` continues to supply Metadata Inspector joins.
14. Idle parking still refuses to park over any running/pending raw task, including a foregrounded
    local agent.
15. No protocol, preload, secret-guard, SDK event, engine lifecycle, or persisted-state shape
    changes.
16. A backgrounded `agentType: 'main-session'` record remains one Task, is absent from Workers, and
    is never labeled a subagent.
17. Local-agent-only Tasks display metadata is either removed as unreachable or deliberately
    retained with a named non-Tasks consumer; remote/team agent display behavior remains intact.

## 10. Recommended decision and sequencing

Approve this exact principle:

> In user-facing classification, a local subagent is a Worker and must not contribute to Tasks.
> Its internal `local_agent` task record remains the execution/control substrate. Leases remain an
> independent account-allocation plane.

Then implement in this order:

1. implement and test the report's `main-session`-as-Task and foregrounded-subagent-as-Worker
   population rules;
2. fix or explicitly waive the Worker feed's handle-only live/persisted de-duplication;
3. add the centralized renderer task-population selector;
4. use it in both `TasksDialog` and `TasksStrip`, and make the Tasks empty-state copy truthful;
5. update focused renderer/sidecar tests, preserve pending Worker Stop, and record the intentional
   blocked-state wording convergence;
6. remove or deliberately retain the now-unreachable local-agent Tasks display branches;
7. amend `ORCHESTRATOR-IN-SESSION.md`, `PARITY-LEDGER.md`, and the owning migration STATUS entry;
8. run the normal desktop verification battery and a live behavior check;
9. hand visual naming/layout decisions to the separate design session.

## 11. Bottom line

The principle is sound, and the current strip already proves the narrower non-duplication rule.
It does not prove that today's Worker population is correct: backgrounded main sessions are
currently mislabeled as subagents, and the live/persisted Worker union can duplicate unnamed
identities. A foregrounded true subagent should remain a Worker because foregrounding changes its
view, not its identity. The safest direction remains a shared renderer-level Task taxonomy while
retaining the engine's proven internal task record, accompanied by targeted Worker-feed hardening
and truthful empty-state copy. Splitting the engine substrate would still create a far larger blast
radius without additional user-facing benefit.

## 12. Report verification

```text
VERIFICATION
- git diff --check  → clean (exit 0; Git emitted a non-fatal fsmonitor IPC warning)
- git diff --no-index --check -- /dev/null <this report>  → no whitespace errors (exit 1 is the expected content-difference status for a new file)
- bun run maps:lint  → passed: 18 maps, 8 pre-existing recommended-section warnings
- cited-path existence check  → all 30 cited path expressions resolve to existing files/directories
Stale-reference sweep: N/A — this report performs no rename, removal, or interface change
Not run: code tests/builds — DOCS-only change; no runtime or canonical implementation file changed
```
