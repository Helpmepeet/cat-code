# P4-32 — superseded Orchestrator chrome decision

**Status: SUPERSEDED 2026-09-07.** Agent Mode and its Orchestrator chrome are
retired. This historical proposal is not an active implementation contract.

**Retirement amendment 2026-09-07.** The generic worker surfaces that remain are
the worker roster and inspection, Tasks Workers tab, permission identity, task
stop/dismiss/background controls, transcript cards, and Codex lease joins. They
consume the outbound-only live-worker snapshot; the mode badge, toggle, and
Orchestrator-specific state are removed. The desktop inbound Agent Mode verb is
removed and rejected by the sidecar vocabulary. Locked transport, N-process,
raw-event, die-with-window, and two-id decisions are unchanged.

This proposal is the Phase-1 deliverable for P4-32. It re-audits the complete 903-line
prototype, current app/engine source, D2, and the UI-drift review after the invented
Orchestrator page was removed. It intentionally leaves the choices in §9 open.

## 1. Premise: a mode, not a destination

The prototype says Orchestrator Mode is **“NOT a separate product”**. It is a mode of the
ordinary Cat Code session: the assistant on that same thread delegates through the Agent
tool; workers appear as inline Agent-tool cards; `/tasks` lists them on demand; the user
talks only to the orchestrator, never directly to a worker. It also says the main agent
narrates worker conclusions rather than exposing worker output directly
(`~/catcode_prototype/cat-app/OrchestratorMode.jsx:1-15`).

Therefore:

- there is no Orchestrator page;
- there is no proposed Orchestrator navigation destination;
- there is no proposed always-on “per-session Orchestrator view”;
- the target is small chrome attached to the ordinary session: transcript cards, `/tasks`,
  a roster above the composer, a title-adjacent mode marker, and at most a deliberately
  chosen read-only worker drilldown.

The current Sidebar agrees: its destinations are chat, sessions, goals, accounts, and
settings, with no Orchestrator entry (`app/renderer/src/Sidebar.tsx:91-97`). The previous
page-shaped implementation must not be recreated under another name.

## 2. First-hand prototype inventory

The prototype has four layers.

### 2.1 Vocabulary and derivation

| Piece | Prototype behavior | Source-backed interpretation |
|---|---|---|
| `WDot` | filled, ringed, or pulsing lifecycle dot (`OrchestratorMode.jsx:36-41`) | Already served by `AgentPip` (`app/renderer/src/AgentChrome.tsx:63-84`). |
| `WStatusText` | dot plus list-context status word (`OrchestratorMode.jsx:43-51`) | Already served in spirit by `AgentStateLabel` (`AgentChrome.tsx:121-135`); list wording remains a host-surface concern. |
| `WMeta` | model, account, elapsed, tool count, failover, traffic (`OrchestratorMode.jsx:53-70`) | Mostly fixture-only. `AgentModeWorkerItem` has none of model/elapsed/tool-count/traffic/cost (`app/shared/protocol.ts:975-1003`). Account can become real only through a lease seam. |
| `WLabel` | 9.5px uppercase section caption (`OrchestratorMode.jsx:90-92`) | Genuinely missing as a reusable app primitive; useful only if detail sections are approved. |
| `WBtn` | neutral/accent/danger outline action (`OrchestratorMode.jsx:93-99`) | Genuinely missing; the real `task.stop` action already exists in `TasksDialog` (`app/renderer/src/TasksDialog.tsx:43-49,82-92`). |
| `OWNER` | independent attention owner: none/orchestrator/user (`OrchestratorMode.jsx:125-129`) | Real derivation, not stored data. Current implementation exists but is dead outside tests (`app/renderer/src/orchestratorState.ts:66-111`). |
| `deriveWorker` | lifecycle plus attention owner (`OrchestratorMode.jsx:131-157`) | Current read-time equivalents exist in `orchestratorWorkerState` and `deriveWorkerOwner` (`orchestratorState.ts:77-111`) but have no production consumer. |
| `workerStateKey` | maps the two-axis model into display vocabulary (`OrchestratorMode.jsx:161-168`) | Current equivalent is `orchestratorWorkerState` (`orchestratorState.ts:77-92`), also test-only. |
| `summarizeWorkers` | working/orchestrator/user/done counts (`OrchestratorMode.jsx:171-183`) | Current equivalent is `summarizeOrchestratorWorkers` (`orchestratorState.ts:124-142`), also test-only. |
| `LifeDot` | roster-specific rendering of lifecycle (`OrchestratorMode.jsx:187-191`) | Already served by `AgentPip`; do not introduce a second state-dot vocabulary. |
| `Baton` | neutral `→orchestrator`, amber `→you` (`OrchestratorMode.jsx:194-211`) | Primitive exists (`AgentChrome.tsx:142-155`) but its sole production call passes `owner="none"` (`app/renderer/src/TranscriptView.tsx:1100-1102`), so it never renders. |
| `workerEventPriority` | user=3, failed=2, result-ready=1 (`OrchestratorMode.jsx:216-221`) | Current equivalent exists at `orchestratorState.ts:175-199`, test-only. |
| `CountTail` | neutral, separator-delimited roster counts (`OrchestratorMode.jsx:224-233`) | Genuinely missing with the roster host. |

### 2.2 In-session chrome

| Piece | Prototype behavior | Source-backed interpretation |
|---|---|---|
| `OrchestratorModeWorkerRoster` | block above `PromptInput`; null for zero workers; distinct one-worker row; multi-worker whisper line; news-bearing lead promotion; full hover roster; dimmer `compact` state while generating (`OrchestratorMode.jsx:237-373`) | Genuinely missing. The exact host is the docked max-740px column above the composer (`app/renderer/src/App.tsx:3070-3078`). |
| `bgTaskPill` / `BackgroundTaskStatus` | accent active count; amber only when the user owns the next action; hidden when settled (`OrchestratorMode.jsx:376-407`) | Logic exists but is test-only (`orchestratorState.ts:154-168`). The live slot is already `TasksStrip` (`App.tsx:2428,2462-2483`). |
| `OrchestratorBadge` | icon plus “Orchestrator” beside the session title (`OrchestratorMode.jsx:410-417`) | Genuinely missing. The actual title is the tab title (`app/renderer/src/TabBar.tsx:283-292`); the chat intentionally has no duplicate header. |
| `TasksButton` | top-bar `/tasks` button with running/attention counts (`OrchestratorMode.jsx:420-433`) | Capability is already reachable through `TasksStrip` and the command palette. There is no top bar to host a second control. |

### 2.3 Worker inspection and transcript

| Piece | Prototype behavior | Source-backed interpretation |
|---|---|---|
| `WorkerDetail` | metadata, prompt, live activity, blocked note, changed files, Stop (`OrchestratorMode.jsx:436-488`) | Partially served by real wire data and stop control. `handle`, `description`, `blockReason`, `verdict`, and `outputSummary` cross today (`protocol.ts:975-1003`; populated at `app/sidecar/agentModeDomain.ts:206-238`), but there is no detail host. Activity and changed-files arrays are not on this seam. |
| `WorkerFocusView` | swaps the main column into a worker thread, shows activity/block/result, and says typing addresses the worker (`OrchestratorMode.jsx:491-559`) | Genuinely missing. Viewing has an engine ancestor (D2 cites teammate view), but the typing promise conflicts with the prototype’s own lines 1-15 and has no approved desktop write path. |
| `AgentToolCard` | inline card in the ordinary transcript (`OrchestratorMode.jsx:562-578`) | Already served by `AgentToolCard` (`app/renderer/src/TranscriptView.tsx:1072-1112`). It uses real transcript-plane input/status/children only. |
| `DelegateGroup` | stacks parallel Agent cards (`OrchestratorMode.jsx:581-595`) | Already served as a read-time derivation (`TranscriptView.tsx:1126`; grouping source `app/renderer/src/transcriptProjector.ts:477-503`). |

The six P4-32 §13 rows are mixed:

- mono vocabulary is already served by literal `font-mono` in `AgentChrome.tsx:104,114`;
- `AgentTypeChip` and `AgentHandle` already exist (`AgentChrome.tsx:98-118`) but are not
  imported by a production worker-roster/detail surface;
- compressed transcript state is already served by `AgentStateLabel`
  (`TranscriptView.tsx:1099`);
- the uppercase transcript section label and a visible real Agent result section are not
  served: the Agent card body renders nested children only
  (`TranscriptView.tsx:1105-1110`).

These already-served or partially-served rows require a **follow-up ledger pass after the
operator rules**. This document does not retag them.

### 2.4 Leases, panel, and scaffolding

| Piece | Prototype behavior | Source-backed interpretation |
|---|---|---|
| `LEASE_STATE`, `leaseAccountRollup`, `LeaseRow`, `LeaseRoster` | per-session strategy, owner→account rows, non-exclusive account rollup, failover count/reason, empty state, and event strip (`OrchestratorMode.jsx:598-711`) | Genuinely missing from `app/`. The engine owns real lease state: `CodexLease` carries owner/account/strategy/state/timestamps/failover/reason (`src/services/api/codexAccountLeaseManager.ts:20-47`); `getCodexLeaseSnapshot` exposes main lease, strategy, and account rollup (`:163-186`); `getCodexLeaseForOwner` exposes a known owner’s live lease (`:194-196`). A new read-only outbound seam is required. There is no source-backed failover event history for the prototype strip. |
| `TasksPanel` | Workers/Leases tabs, role-grouped worker rows, detail drilldown (`OrchestratorMode.jsx:713-811`) | Partially served by the existing `TasksDialog`, which uses real `tasks.snapshot` data but groups Active/Completed and explicitly defers detail dialogs (`app/renderer/src/TasksDialog.tsx:1-16`). Its domain excludes the foregrounded `local_agent` (`app/sidecar/tasksDomain.ts:53-68`), so it cannot become the worker roster without a deliberate union with `agent-mode.snapshot`. |
| `ODEMO_STATES`, `OrchestratorDemoSwitch`, mock workers/leases | review-only A/B/C fixture switch (`OrchestratorMode.jsx:827-901`) | Cut. The prototype itself says “DEMO-ONLY: delete on migration” (`:814-826`), and D2 already ruled the fixture feeds out. |

## 3. Disposition proposal for every prototype family

The verdicts below are proposals for Phase 2, not ledger changes.

### Already served — follow-up ledger pass required

- `WDot` and `LifeDot` → `AgentPip` (`AgentChrome.tsx:63-84`).
- `WStatusText` state vocabulary → `AgentStateLabel` (`AgentChrome.tsx:121-135`).
- inline `AgentToolCard` (`TranscriptView.tsx:1072-1112`).
- parallel `DelegateGroup` (`TranscriptView.tsx:1126`; `transcriptProjector.ts:477-503`).
- transcript-plane nested activity from real child frames
  (`TranscriptView.tsx:1105-1110`).
- the `/tasks` entry capability through `TasksStrip` and the command palette
  (`App.tsx:2428,2462-2483`; `app/renderer/src/commandPaletteModel.ts:166-171`).
- `AgentPip`, `AgentStateLabel`, `AgentTypeChip`, `AgentHandle`, and mono styling in
  `AgentChrome.tsx:63-135`.

### Partially served — retain the host, fill only the approved gap

- `BackgroundTaskStatus`: extend `TasksStrip`; do not add a second pill.
- `TasksPanel`: retain `TasksDialog`; if approved, add a Workers/Leases tab structure and a
  worker-detail drilldown fed by `agent-mode.snapshot`.
- `WorkerDetail`: render only source-backed prompt/identity/status/block reason/stop fields.
- Agent transcript “Result”: the real result exists on the projected tool row, but the
  specialized Agent card currently hides it. Whether to render it is an operator choice
  because it conflicts with the prototype header’s “main agent narrates” premise.

### Genuinely missing — proposed host

- roster/whisper/popover/lead/count-tail → the `SessionPane` docked column immediately before
  the existing permission/question/activity stack (`App.tsx:3075-3122`);
- badge → the session tab title row (`TabBar.tsx:283-292`), unless the operator explicitly
  chooses the costlier new chat header;
- detail → a drilldown inside `TasksDialog`;
- focus → only if explicitly approved, as a read-only main-column swap with no composer;
- leases → a read-only sidecar snapshot feeding the Leases tab;
- `WLabel`/`WBtn` → local shared primitives only if the approved detail surfaces consume them.

### Cut under existing rulings

- `OrchestratorDemoSwitch` and `ODEMO_STATES`;
- mock `w.progress`, `w.files`, `w.up`, `w.down`, `w.cost`, mock account, and
  `MOCK_CODEX_LEASES`;
- a standalone Orchestrator page/nav destination;
- invented standalone `agent-event`, attachment, or grouped message types (D2 C3);
- a second footer tasks pill.

## 4. Placement decisions

Each question has real alternatives. The recommendation is called out, but does not close
the choice.

### 4a. Roster above the composer

**Option R1 — mount it in the existing docked column.** Put the roster at
`App.tsx:3075`, before `AskQuestionFlow` and `PermissionQueue`, so it remains immediately
above the composer and in the same 740px measure as the transcript. This is the prototype’s
declared host.

- Cost: `SessionPane` gains the active session’s full `AgentModeSnapshot`; hover-only
  acceptance remains operator-driven; the compact state needs the existing `generating`
  signal.
- Recommendation: **R1**.

**Option R2 — no persistent roster; use `/tasks` only.**

- Cost: waives the roster shell, single-worker row, whisper line, promotion, count tail,
  popover, compact state, and FLOW-5 roster step. It is simpler but materially below the
  prototype.

### 4b. Mode badge by the title

**Option B1 — badge inside each TabBar tab, adjacent to its title.** The tab is the actual
session-title host (`TabBar.tsx:283-292`). The badge can be a button/switch so mode remains
visible and changeable after the transcript has messages.

- Cost: App must supply per-tab `agentMode.active`, not only the active pane’s snapshot;
  the tab row gets slightly wider; making the prototype’s passive badge interactive needs
  focus/hover/accessible-switch states.
- Recommendation: **B1**.

**Option B2 — introduce a persistent chat header.**

- Cost: duplicates the title already owned by TabBar, consumes vertical space in every
  session, changes shell layout, and creates a new cross-surface visual contract with P4-33.
  It is the highest-fidelity location only if “next to session title” is read as an
  in-pane title rather than the title the app actually uses.

**Option B3 — status-only TabBar badge plus a separate composer mode control.**

- Cost: two pieces of Orchestrator chrome and potential state drift; more discoverable than
  a status-only badge, but noisier than B1.

### 4c. Footer task pill

**Option P1 — extend `TasksStrip` semantics.** Use `orchestratorPill` over the active
`agent-mode.snapshot` to add the accent active count and the amber “N needs you” case; keep
the same button and `TasksDialog` destination.

- Cost: reconcile task counts and worker counts without double-counting the same
  `local_agent`; preserve the rule that orchestrator-owned blocked workers remain neutral.
- Recommendation: **P1**.

**Option P2 — keep the current neutral `TasksStrip` unchanged.**

- Cost: waives `bgTaskPill`’s attention semantics.

Adding a second pill is not an option: the slot already has an owner (CC-5 rule #10).

### 4d. Worker detail and focus

**Option D1 — read-only detail inside `TasksDialog`; no main-column focus.** The detail shows
handle, type, lifecycle, prompt/description, block reason, real output summary/verdict only
if separately approved, and the existing Stop action. It never accepts messages to a worker.

- Cost: waives `WorkerFocusView` and “Open thread”, but honors the prototype’s opening
  premise and avoids a new inbound write path.
- Recommendation: **D1**.

**Option D2 — D1 plus a read-only main-column focus view.** “Open thread” swaps the column,
but there is no worker composer and no claim that the user can address the worker. It shows
only source-backed task/activity/block fields chosen by the operator.

- Cost: new focus state/Escape routing and a second rendering host for worker detail;
  visually recreates part of the deleted surface; showing a worker result in the main column
  still conflicts with lines 1-15.

**Option D3 — full prototype focus including typing to the worker.**

- Cost: requires a new validated inbound control path, task-type capability gates, resume/
  queue semantics, security tests, and a ruling that overturns “the user only ever talks to
  the orchestrator.” It is not implied by existing source.

**Option D4 — neither detail nor focus.**

- Cost: discards already-crossing `blockReason`, `verdict`, `outputSummary`, and handle data,
  and waives the WorkerDetail/FLOW-5 blocked-reason rows.

## 5. Dead two-axis model: wire or delete

There are exactly two valid choices.

**Option T1 — wire it.** The roster, footer semantics, and detail consume:

- `orchestratorWorkerState`;
- `deriveWorkerOwner`;
- `summarizeOrchestratorWorkers`;
- `orchestratorPill`;
- `workerEventPriority`;
- `selectPromotedWorker`;
- `displayHandle`;
- `selectWorkerById`.

This also makes `Baton` reachable from a session-plane surface. Cost: Phase 32a owns the
complete lifecycle/owner truth table and must prove active-orchestrator blocked workers are
neutral while solo blocked workers are amber.

**Option T2 — delete all eight exports and their dead tests.** This is coherent only with
R2/P2/D4 or a simpler roster that explicitly waives lead promotion, attention ownership,
and drilldown. Cost: the corresponding §20 and FLOW-5 rows must be cut/waived.

Recommendation: **T1 if any roster is approved; T2 otherwise.** Keeping tested dead code is
not an option.

## 6. Baton and mode-toggle reachability

### Baton

**Option A1 — render it from the session plane.** Feed `deriveWorkerOwner(worker, active)`
into roster/detail rows. Leave the transcript card’s `owner="none"` untouched because the
transcript frame does not carry handoff ownership (`TranscriptView.tsx:1065-1102`).

- Cost: none beyond T1 and the roster/detail host.
- Recommendation: **A1 with T1**.

**Option A2 — delete it with T2.**

- Cost: waive the baton rows and represent status as lifecycle only.

Joining session-plane ownership into transcript cards is not proposed; D2 deliberately keeps
the transcript and session feeds separate.

### Empty-transcript-only mode toggle

The existing interactive `OrchestratorReflect` renders only in the empty-transcript branch
(`TranscriptView.tsx:189-215`). The real switch is already safe and session-scoped:
`agent-mode.set` calls the engine’s own runtime `matchSessionMode`
(`app/sidecar/agentModeDomain.ts:47-76,95-141`).

**Option M1 — make the TabBar badge itself the always-reachable switch (B1).**

- Cost: per-tab mode snapshots and explicit button/switch accessibility.
- Recommendation: **M1**.

**Option M2 — add an Orchestrator control to `ComposerActionsBar`; leave the TabBar badge
status-only.**

- Cost: a new composer chip and duplicated mode chrome.

**Option M3 — command-palette action only.**

- Cost: mode becomes invisible after messages unless the title badge is also kept; lower
  discoverability than the prototype premise deserves.

Leaving the toggle empty-transcript-only is not recommended; it contradicts the mode’s
ordinary-session premise.

## 7. Leases: session-scoped read seam, Accounts fold, or cut

**Option L1 — build a read-only lease snapshot seam.** The sidecar reads the engine’s real
lease manager, joins known worker IDs to `getCodexLeaseForOwner`, emits a secret-guarded
outbound snapshot, and renders a Leases tab inside `TasksDialog`.

- What can be exact and truthful now: strategy, active main/subagent owner, account ID/alias
  after redaction policy, selection reason, active state, timestamps/held duration,
  failover count/reason, and account holder rollup.
- What cannot be exact without extending engine state: the prototype’s failover/rotation
  event history strip. The engine snapshot exposes no event list.
- Cost: engine-facing read-domain work, an additive app protocol frame, sidecar tests,
  renderer state/tests, secret review, and hardening verification.
- Recommendation: **L1**, with the event strip explicitly cut unless the operator separately
  requests durable diagnostics history.

**Option L2 — fold leases into Accounts.**

- Cost: Accounts is global, while the question is “which accounts is this session’s swarm
  using?” It loses session context and still needs a source seam. This is not recommended.

**Option L3 — cut leases.**

- Cost: waive `LEASE_STATE`, rollup, row, roster, empty-state, the Leases tab, and FLOW-5
  lease coverage despite real engine backing.

The prior “reuse the account pool” adaptation is insufficient: health/usage is not
owner→account lease truth.

## 8. Proposed P4-32a / P4-32b split

The split follows data/component seams rather than row count.

### P4-32a — session chrome and worker summary

**Suggested tag:** `🧠 Model: CLAUDE (visual-design) · Difficulty: 7/10 · 🖐 GUI`

Owns:

- §20 `OWNER`, `deriveWorker`, `workerStateKey`, `summarizeWorkers`, `Baton`,
  `workerEventPriority`, `CountTail`;
- §20 entire roster family: shell/null/single/compact/resting/promoted/popover/chevron;
- §20 `bgTaskPill`/`BackgroundTaskStatus`, `OrchestratorBadge`, `TasksButton`;
- FLOW-5 badge, roster, baton;
- §13 mono, `AgentTypeChip`, and `AgentHandle` where consumed by roster chrome;
- the dead-export wire-or-delete ruling;
- the empty-transcript-only toggle correction.

Primary hosts: `App.tsx` docked composer column, `TabBar`, `TasksStrip`,
`orchestratorState`, and `AgentChrome`. It does not own worker detail/focus or leases.

### P4-32b — on-demand inspection, leases, and Agent-card truth

**Suggested tag:** `🧠 Model: CLAUDE (system-architecture) · Difficulty: 8/10 · 🖐 GUI`

Owns:

- §20 `WMeta`, `WLabel`, `WBtn`;
- §20 `WorkerDetail` and every approved WorkerFocus row;
- §20 `TasksPanel` Workers/Leases tabs, role groups, worker rows, drilldown;
- §20 `LEASE_STATE`, rollup, row, roster, empty state;
- FLOW-5 leases, focus, and blocked/reason state;
- §13 `agentTranscriptStateWord`, `AgentTranscriptLabel`, and real Result section;
- any approved read-only lease frame/domain and its security verification.

Primary hosts: `TasksDialog`, a new lease read domain/state if L1 is chosen, and the existing
Agent card. If D1 is chosen, 32b explicitly records the focus waivers rather than silently
omitting them.

## 9. Proposed cuts/waivers and the operator’s choices

No item below is cut or waived by this proposal. The operator must choose.

### Proposed cuts under all options

1. `OrchestratorDemoSwitch` and `ODEMO_STATES` — prototype-declared migration scaffold.
2. Mock `w.progress`, `w.files`, `w.up`, `w.down`, `w.cost`, mock account, and
   `MOCK_CODEX_LEASES` fields — no app seam backing; source truth wins.
3. WorkerDetail and WorkerFocus **Activity timeline** rows as currently specified — no
   session-plane progress array. Real nested transcript activity remains served in Agent cards.
4. WorkerFocus “messages you send here go to the worker” context promise and any worker
   composer — conflicts with the prototype premise and has no approved write path.
5. Lease failover/rotation **event strip** — the engine exposes current lease/failover state,
   not an event history.
6. A standalone Orchestrator page/nav destination and a second footer pill.

### Proposed conditional waivers

7. `WMeta` row — waive model/elapsed/tool-count/traffic/cost; if L1 is chosen, account and
   failover may render in lease detail rather than fabricate the original line.
8. Roster single-worker **elapsed** subfield — no current `AgentModeWorkerItem` field.
9. Standalone `TasksButton` — waive if P1+B1 provide `/tasks` through `TasksStrip`, roster
   click-through, and the command palette; build only if the operator chooses a new header.
10. All `WorkerFocusView` rows and FLOW-5 focus — waive under D1 or D4.
11. WorkerFocus Result/Verdict and §13 Agent-card Result — choose one:
    - **Result policy Q1:** never surface orchestrated worker conclusions; the orchestrator
      narrates them. Waive these rows for orchestrated workers.
    - **Result policy Q2:** show a real result only inside read-only `/tasks` detail, never the
      main transcript/focus column.
    - **Result policy Q3:** render the real Agent tool result in the inline card and/or focus
      view, accepting the prototype’s internal contradiction.
12. Entire lease family and FLOW-5 Leases — waive only under L3.
13. Entire roster/lead/popover/compact/baton family — waive only under R2+T2+A2.
14. WorkerDetail prompt/block-reason rows and FLOW-5 blocked note — waive only under D4.

### Explicit operator decision set

The operator needs to choose one value from each independent group:

1. **Roster:** R1 docked roster, or R2 `/tasks` only.
2. **Badge/header:** B1 TabBar switch-badge, B2 new chat header, or B3 status badge plus
   composer control.
3. **Footer:** P1 extend `TasksStrip`, or P2 keep it neutral.
4. **Inspection:** D1 read-only TasksDialog detail, D2 detail plus read-only focus, D3 full
   worker-addressable focus, or D4 neither.
5. **Two-axis/Baton:** T1+A1 wire them, or T2+A2 delete them.
6. **Always-reachable toggle:** M1 TabBar switch, M2 composer control, or M3 palette action.
7. **Leases:** L1 new read seam, L2 Accounts fold, or L3 cut.
8. **Result policy:** Q1 never show worker conclusions, Q2 `/tasks` detail only, or Q3
   transcript/focus rendering.
9. **Conditional waivers 7–14:** approve or reject each waiver activated by the choices above.

The recommendation set is **R1 / B1 / P1 / D1 / T1+A1 / M1 / L1 / Q2**. It is only a
recommendation: the options and their costs above remain the decision.

---

## 10. OPERATOR RULING — 2026-07-30

**Status: RULED. Phase 1 is closed and P4-32a / P4-32b are authorized.**

The operator accepted the §9 recommendation set **as written, all nine groups**:

| Group | Ruling |
|---|---|
| 1. Roster | **R1** — docked roster above the composer |
| 2. Badge/header | **B1** — TabBar switch-badge (no new chat header) |
| 3. Footer | **P1** — extend the existing `TasksStrip` (no second pill) |
| 4. Inspection | **D1** — read-only `TasksDialog` detail |
| 5. Two-axis/Baton | **T1+A1** — wire them, do not delete |
| 6. Always-reachable toggle | **M1** — TabBar switch |
| 7. Leases | **L1** — new read seam |
| 8. Result policy | **Q2** — real result only inside read-only `/tasks` detail, never the main transcript or focus column |
| 9. Waivers 7–14 | **Approved as activated by the choices above** |

Consequences that follow, and are therefore also ruled:

- The §9 "proposed cuts under all options" (1–6) are **approved cuts**: `OrchestratorDemoSwitch`
  and `ODEMO_STATES`; all mock worker fields (`progress`/`files`/`up`/`down`/`cost`, mock account,
  `MOCK_CODEX_LEASES`); the Activity-timeline rows as specified; the WorkerFocus worker-composer
  and its "messages go to the worker" promise; the lease failover/rotation event strip; and any
  standalone Orchestrator page, nav destination or second footer pill.
- **D1 means waiver 10 activates:** all `WorkerFocusView` rows and FLOW-5 focus are waived.
  P4-32b must RECORD those waivers explicitly rather than omit them silently.
- **L1 means a new read-only lease seam is authorized** — outbound only, sidecar-validated,
  with the security verification §8 requires.
- **T1+A1 means the 8 test-only `orchestratorState.ts` exports get wired, not deleted**, and the
  unreachable `Baton` (`AgentChrome.tsx:142`, sole caller hard-codes `owner="none"`) gets a real
  owner.
- **M1 supersedes the empty-transcript-only toggle defect** (`TranscriptView.tsx:206`): the mode
  toggle moves to the TabBar and must be reachable on a non-empty transcript.

Phase-2 dispatch: **P4-32a** and **P4-32b** per the §8 split, which stands unchanged.
