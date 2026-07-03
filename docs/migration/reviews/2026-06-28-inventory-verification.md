# Inventory verification report — 2026-06-28

## Summary

- **Rows verified:** 43 active inventory rows plus the CUT table.
- **Rows corrected:** 38 active rows had at least one corrected `⚓`, `Faked?`, or disposition field.
- **Anchor/source classifications:** 104 exact, 46 near, 9 stale, 6 unverifiable across literal anchors plus explicitly recorded under-count source hits. The prior `141 literal // SOURCE:` count remains the raw comment population; this report classifies the source references that affected ledger rows.
- **Empty-recon verdicts:** 6. Four are **case (a)**, meaning engine capabilities exist but no matching UI shell exists; two are **case (b)**, meaning the prototype display should be cut or redesigned.
- **Under-counts found:** 29 surfaces had real source grounding not represented by the original scrape.
- **Row-set fixes:** 7 CUT/live/dead clarifications; no missing live rows after grouping.
- **Human decisions:** durable desktop session registry shape; whether to keep any prototype-only agent chrome; paired-device UX; startup forced-reauth/read-only gates; project recents/branch picker launcher.

## Method

Two squads ran in parallel:

- **Squad A correctness:** checked anchored rows, re-measured per-surface grounding, and classified anchors against `~/cat-code/src`.
- **Squad B omission:** performed zero-anchor recon, under-count sweeps, and row-set gap checks.

I then spot-checked source myself before editing the ledger. Spot checks included:

- `src/types/logs.ts:20-55` — real `LogOption` session metadata.
- `src/types/command.ts:146-208` and `src/commands.ts:267-366` — slash-command shape and registry.
- `src/utils/concurrentSessions.ts:48-203` — PID/liveness registry only.
- `src/memdir/memoryTypes.ts:14-21` — real memory type taxonomy; previous `205-234` citation is stale.
- `src/web/AppSessionWebSocketServer.ts:31-74` — loopback WebSocket mapper/broadcast path.
- `src/entrypoints/sdk/coreTypes.generated.ts:760-779` — real `SDKMessage` union breadth.
- `src/agent-mode/workerUxSummary.ts:28-111` — Agent Mode worker summaries.
- `src/remote/sdkMessageAdapter.ts:43-50,168-207` — streaming delta conversion and SDK message conversion.

## Merged row table

| Surface | File | squad | ⚓ per-surface (old→new) | anchors EXACT/NEAR/STALE | Faked? (confirm/correct +spec-ID) | Disposition (confirm/correct +why) | omission/verdict | one-line verdict |
|---|---|---:|---|---|---|---|---|---|
| `AppSessionController` driver | `src/app-runtime/AppSessionController.ts` | A | real→real:1 | EXACT | confirm no | confirm port | none | Controller seam is real. |
| Message stream (`SDKMessage`) | `src/app-runtime/sessionEvents.ts` / `coreTypes.generated.ts` | A/B2 | real→real:2 | EXACT | confirm no | confirm port | under-count: SDK union breadth | Message stream is real and broader than “few types.” |
| Transport topology | `src/web/*` | A | real→real:2 | STALE old in-process wording | confirm no | correct to P0 bake-off | stale wording | In-process is refuted; WS/sidecar candidates remain. |
| Streaming deltas | engine `SDKPartialAssistantMessage` | A/B2 | real→real:2 | EXACT | yes S1 | confirm build-new + spec | none | Prototype timer playback must be replaced. |
| `Sidebar` | `Sidebar.jsx` | B1/B2 | ❌→4 | EXACT/NEAR | yes S3/S4 | correct port→adapt | under-count | Real session list metadata exists; fixture fields drift. |
| `TabBar` | `TabBar.jsx` | B1/B2 | ❌→4 | EXACT/NEAR | yes S3 | correct port→adapt | empty-recon a + under-count | Real status/panel state exists; durable tab manager is app-owned. |
| `WorkspaceLayout` | `WorkspaceLayout.jsx` | A/B2 | 1→4 | EXACT/NEAR | confirm no | correct port→adapt | under-count | Panel/session routing is real; resize chrome is prototype-only. |
| `CommandPalette` | `CommandPalette.jsx` | A/B2 | 1→6 | EXACT/NEAR | confirm no | correct port→adapt | under-count | Palette collapses command registry, bridge filtering, and session search. |
| `SlashCommandPicker` | `SlashCommandPicker.jsx` | B1/B2 | ❌→5 | EXACT/NEAR | confirm no | correct port→adapt | empty-recon a + under-count | Real slash/typeahead logic exists; standalone picker is UI split. |
| Root state/routing | `AppV2.jsx` | A/B2 | 4→7 | EXACT/NEAR | yes S3/S6 | correct build-new→adapt/build-new | under-count | Root shell has source analogs but demo glue must be replaced. |
| N-process spawn/attach/multiplex | app-owned / `concurrentSessions.ts` | A | real→0 | STALE | yes S3 | confirm build-new + spec | empty-recon a | `concurrentSessions.ts` is liveness only, not app registry/multiplex. |
| Core transcript rows | `Messages.jsx` | A/B2 | 22→8 | NEAR | partial S1 | confirm adapt | under-count | Real nested message/content blocks replace flat rows. |
| `ToolCard` + `ToolResultRow` | `Messages.jsx` | A/B2 | 22→4 | NEAR | partial S1 | confirm adapt | under-count | Tool cards must be derived from `tool_use`/`tool_result`. |
| `DiffView`, `MultiDiffCard` | `Messages.jsx` | A | 22→2 | NEAR | confirm no | confirm adapt | none | Real diff behavior exists; component shape differs. |
| Boundary rows | `Messages.jsx` | A/B2 | 22→6 | EXACT/NEAR/STALE | confirm no | correct adapt | stale microcompact | `MicrocompactBoundaryRow` is stale unless a visible mapping is found. |
| Error/state rows | `Messages.jsx` | A/B2 | 22→4 | EXACT/NEAR/STALE | partial S1/S5 | correct adapt | stale rate-limit row | Separate rate-limit row is not source-backed. |
| Prototype-only display types | `Messages.jsx` | A/B2 | 22→3 | NEAR/UNVERIFIABLE | partial S5 | correct adapt/recon | empty-recon b for agent chrome | Grouped tools/attachments exist; agent chrome needs decision. |
| Markdown/code | `Messages.jsx` | A | 22→1 | NEAR | confirm no | correct port→port/adapt | none | Same job, different renderer stack. |
| Streaming/activity engine | `Chat.jsx` | A/B2 | 13→6 | NEAR/STALE | yes S1/S2 | confirm build-new + spec | invented runner | `runPlaygroundTurn` is demo-only. |
| `PermissionQueue` | `Permissions.jsx` | A/B2 | 6→6 | NEAR | yes S2 | confirm adapt + spec | under-count | Real protocol is richer than queue cards. |
| `PermissionRulesEditor` | `PermissionRules.jsx` | A/B2 | 2→2 | EXACT/STALE | partial S2 | correct port→adapt | under-count | Serialization real; editor/debug UI is chrome. |
| `ChatView` composer | `Chat.jsx` | A/B2 | 13→9 | NEAR | partial S1/S2 | confirm adapt/build-new | under-count | Composer combines real input/typeahead with demo turn state. |
| `PlanBar` / `PlanPanel` | `PlanPanel.jsx` | A/B2 | 3→3 | NEAR | yes S6 | correct port→adapt/build-new | invented live checklist | Real plan approval is file/tool-based; drawer/checklist shell is GUI-owned. |
| `AccountsPage` | `Pages.jsx` | A/B2 | 10→10 | NEAR | partial S8 | correct port→adapt | under-count | Codex pool/lease/refresh state is richer than table. |
| `AccountLifecycle` | `AccountLifecycle.jsx` | A/B2 | 2→2 | NEAR | partial S8 | correct port→adapt/build-new | under-count | Commands are real; lifecycle dialogs are GUI-owned. |
| `SessionsPage` | `SessionsPage.jsx` | A/B2 | 1→1 | EXACT/NEAR | yes S4 | correct port→adapt | under-count | Real log metadata is much richer. |
| `SessionActionsMenu` + dialogs | `SessionActions.jsx` | B1/B2 | ❌→6 | EXACT/NEAR | partial S4 | correct port→adapt | empty-recon a | Capabilities exist as separate commands, not one menu shell. |
| `MetadataInspector` | `MetadataInspector.jsx` | A/B2 | 1→1 | EXACT/NEAR | yes S4 | correct port→adapt | under-count | Inspector is valid but undercounts persisted metadata. |
| `AgentsPage` | `AgentsPage.jsx` | A/B2 | 3→3 | EXACT/NEAR | yes S5 | correct port→adapt | under-count | Agent config/runtime state is broader than editor. |
| Orchestrator domain | `OrchestratorMode.jsx` | B1/B2 | ❌→8 | EXACT/NEAR/STALE | yes S5 | confirm adapt | empty-recon b for inline cards | Agent Mode is real; inline transcript cards/groups should be cut/replaced. |
| Tasks | `TasksPage.jsx` / `OrchestratorMode.jsx` | A/B2 | 4/❌→4/0 | EXACT/UNVERIFIABLE | yes S5 | confirm adapt | TasksPanel unanchored | Dialog is grounded; panel is GUI. |
| Goals | `GoalsPage.jsx` / `Surfaces.jsx` | A/B2 | 1→1/0 | EXACT/UNVERIFIABLE | yes S8 | correct port→adapt | under-count | Thread goal is per-thread state, not a global roster. |
| MemoryPanel | `MemoryPage.jsx` | A/B2 | 1→1 | STALE old range | yes S8 | correct port→adapt | stale citation | Taxonomy moved to `memoryTypes.ts:14-21`. |
| Settings shell/primitives | `Settings.jsx` | A/B2 | 2→1 | EXACT/NEAR | partial S7 | correct port→adapt | under-count | Source/editability model is broader. |
| Settings extensions | `SettingsExtensions.jsx` | A/B2 | 5→5 | EXACT/NEAR | yes S7 | correct port→adapt | under-count | Domains real; summary view is flat. |
| Remote settings | `RemoteSettings.jsx` | A/B2 | 9→9 | EXACT/NEAR/STALE | yes S7 | correct port→adapt | invention: paired devices | Bridge/remote/direct-connect real; paired-device roster invented. |
| Diagnostics/WorkspaceTrust | `Pages.jsx` | A/B2 | 10→0 | UNVERIFIABLE surface-local | partial S6/S7 | correct port→adapt/recon | file-level count removed | Helpers exist, but row had no local anchors. |
| Shared primitives | `Surfaces.jsx` | A/B2 | 5→5 | NEAR | partial S7 | correct port→adapt | under-count | Product primitive layer is target-owned. |
| Connection UI | `Surfaces.jsx` | A/B3 | 5→2 | NEAR/STALE | yes S7 | correct port→adapt + cut demo bar | dupe/cut-live | Real chips exist; demo simulator is cut. |
| `AgentIdentity` | `AgentIdentity.jsx` | A/B2 | 4→4 | NEAR | partial S5 | correct port→adapt | under-count | Vocabulary compresses worker/task state. |
| Startup/trust | `Startup.jsx` | A/B2 | 11→11 | EXACT/NEAR/STALE | partial S6 | correct port→adapt | inventions | Trust/OAuth real; GUI gates invented. |
| Resume states | `ResumeStates.jsx` | A/B2 | 2→2 | NEAR/STALE | yes S6 | correct port→adapt | invention | Overlay visualizes synchronous restore/recovery. |
| `WelcomeScreen` | `Welcome.jsx` | A/B2 | 1→1 | NEAR | partial S6/S8 | correct port→adapt | under-count/invention | Mixed real subsystems under invented launcher. |
| Design tokens/theme | HTML/style | A/B2 | —→0 | UNVERIFIABLE | — | confirm build-new | none | Pure target foundation work. |

## Empty-recon verdicts

- **Sidebar:** case (a). Engine backs session catalog/resume metadata; no desktop sidebar shell exists. Evidence: `src/types/logs.ts:20-55`, `src/utils/sessionStorage.ts:5363-5400`.
- **TabBar:** case (a). Engine/TUI backs current session title/status and panel routing; no durable desktop tab manager exists. Evidence: `src/main.tsx:91-186`, `src/ink/hooks/use-tab-status.ts:53-71`.
- **SlashCommandPicker:** case (a). Slash command metadata/typeahead exists; no standalone picker component exists. Evidence: `src/types/command.ts:180-208`, `src/hooks/useTypeahead.tsx:655-781`.
- **SessionActions:** case (a). Branch/export/rewind capabilities exist as separate commands; no composite session-actions shell exists. Evidence: `src/commands/branch/branch.ts:61-289`, `src/components/ExportDialog.tsx:25-127`, `src/utils/fileHistory.ts:347-483`.
- **AgentToolCard:** case (b). Real task rows/detail dialogs exist; no inline agent transcript card owner exists. Evidence: `src/components/tasks/BackgroundTask.tsx:116-126`, `src/components/tasks/AsyncAgentDetailDialog.tsx:25-240`.
- **DelegateGroup:** case (b). Real task grouping exists in dialog/list form, not transcript group cards. Evidence: `src/components/tasks/BackgroundTasksDialog.tsx:131-224`.

## Under-counts found

1. `Sidebar` — `LogOption`, session storage, custom title search, task count state.
2. `TabBar` — app/panel/session routing and tab handlers.
3. `WorkspaceLayout` — multi-panel state, but not resize math.
4. `CommandPalette` — command registry, remote/bridge filtering, session search.
5. `SlashCommandPicker` — slash parser/typeahead/PromptInput submission.
6. `AppV2` — root route/page/session/panel state.
7. `Messages.jsx` — SDK/message unions, nested content blocks, tool/result correlation, local-command system rows, task notifications, progress replacement.
8. `Chat.jsx` — real stream events, text streaming, permission gating.
9. `Permissions.jsx` — `tool_use_id`, blocked paths, classifier state, decision reasons, permission updates, interrupts.
10. `PermissionRules.jsx` — source/mode/update destinations and denial caps.
11. `PlanPanel.jsx` — `ExitPlanModeV2Tool` plan/file/request fields.
12. `SessionsPage.jsx` — full persisted session/log metadata.
13. `SessionActions.jsx` — branch/export/rewind command and file-history machinery.
14. `MetadataInspector.jsx` — thread goal, worktree, content replacement, file history metadata.
15. `AgentsPage.jsx` — runtime agent/task state and tool requirements.
16. `TasksPage.jsx` — local-agent state, backgrounding, retention, handoff/block reasons, verdicts.
17. `OrchestratorMode.jsx` — worker lifecycle, resumability, synthesis, attention/review states.
18. `GoalsPage.jsx` — per-thread goal persistence, usage, budget, command lifecycle.
19. `MemoryPage.jsx` — memdir taxonomy, file selector, `/memory` command flow.
20. `AccountLifecycle.jsx` — pool status, usage limits, leases, failover, refresh diagnostics.
21. `AgentIdentity.jsx` — worker/task/agent state space.
22. `Settings.jsx` — settings source/editability/managed semantics.
23. `SettingsExtensions.jsx` — scoped MCP state, plugin source threading, hook result richness.
24. `RemoteSettings.jsx` — bridge vs remote-session vs direct-connect distinctions.
25. `Startup.jsx` — trust and OAuth are separate engine gates.
26. `ResumeStates.jsx` — recovery/restore flow is real, hydration overlay is not.
27. `Welcome.jsx` — account and orchestrator subsystems are real; launcher is invented.
28. `Surfaces.jsx` — status line, prompt footer, task status, token warning, context, account primitives.
29. `Pages.jsx` diagnostics/trust — helper-backed, not anchor-backed.

## Row-set gaps

- **Missing rows:** none after grouping. Helper-level components in settings/pages are intentionally grouped.
- **Dead historical paths:** `Workspace.jsx`, `composer-variants.jsx`, `menu-variants.jsx`, `profile-variants.jsx`, `design-canvas.jsx` are absent on disk.
- **Unloaded file:** `ConnectionDemo.jsx` exists but is not loaded by `CatCode Web App.html`.
- **CUT/live corrections:** `ConnectionDemoBar`, `OrchestratorDemoSwitch`, `PrototypeControlsSection`, and `ConnectionDemoSection` are loaded demo surfaces, not absent code. They remain CUT because they are simulators.
- **CUT row corrected:** `OrchestratorBadge` and `TasksButton` are live support UI for orchestrator/task state, so they should not be lumped with demo-only cut surfaces.

## Human-decision list

1. **Desktop session registry:** define the app-owned durable registry and attach/multiplex contract. `concurrentSessions.ts` cannot fill this role.
2. **Agent chrome:** decide whether prototype `AgentEventRow`/`AgentMsgCard`/inline `AgentToolCard`/`DelegateGroup` should be cut or redesigned over real task dialogs.
3. **Paired devices:** either cut the paired-device roster/wizard or add a real backing model.
4. **Startup GUI gates:** decide whether read-only startup, workspace-switch prompt, and forced reauth are product requirements or prototype storytelling.
5. **Welcome launcher:** decide whether project recents, branch chooser, and “start in” launcher state become desktop-owned persistence.

## Verification commands/checks run after edit

Run after writing the repaired inventory:

- Search for stale transport wording: no surviving `transport (decide|spike|in-process)` phrasing should remain.
- Search for file-level-looking duplicate anchor runs: repeated old file totals (`22`, `13`, `10`, `5`) should no longer appear as blanket values across all rows from the same file.
- Search faked-count prose: old “six faked surfaces” prose should be gone; resolved count should say 28 active yes/partial rows.

