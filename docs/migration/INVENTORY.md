# CatCode migration — surface inventory & disposition ledger

**Verified 2026-06-28.** This ledger was repaired against `~/cat-code/src` after a full-population source pass. `⚓` is now a **per-surface grounding count**: literal `// SOURCE:` anchors when a prototype file has them, plus explicitly recorded source-backed under-counts found during recon. `❌` means no useful source grounding was found for that surface.

**Spec IDs for faked/runtime behavior:**
- **S1 Streaming:** real `SDKPartialAssistantMessage` / `stream_event`; prototype used scripted timers.
- **S2 Permission round-trip:** real control permission request/response/update protocol; prototype used a mock queue.
- **S3 Multi-session process model:** one desktop window managing N Bun engine processes plus an app-owned registry; prototype used in-page mock state.
- **S4 Session catalog:** real file-backed `LogOption` / transcript metadata; prototype used simplified session fixtures.
- **S5 Agent Mode / tasks:** real `LocalAgentTask` / Agent Mode worker state; prototype used mock workers and display groupings.
- **S6 Startup/resume/auth:** real trust/OAuth/resume primitives; prototype added GUI gates and overlays.
- **S7 Settings/remote:** real settings, MCP, plugin, skill, hook, bridge, and remote state; prototype flattens these domains.
- **S8 Goal/memory/accounts:** real thread-goal, memdir, and Codex account/pool state; prototype uses simplified rosters/dialogs.

**Resolved faked count:** 28 active rows are `yes` or `partial`. That is not six surfaces; the six-ish number only described cross-cutting behavior families. Rows with `yes/partial` must name a spec ID before build work.

**Columns:**
- **Surface** — exported component(s) or source-only migration capability.
- **File / source** — prototype source-of-design or direct engine source.
- **⚓** — per-surface grounding count after verification. `real:N` means direct engine rows, not prototype anchors.
- **Faked?** — whether prototype runtime/data behavior is mocked or flattened; spec IDs identify the required behavior spec.
- **Disposition** — `port` (faithful rebuild on real data), `adapt` (UX stays but real shape differs), `build-new` (new app-side wiring), `cut` (do not migrate as a product surface), `recon` (human/source decision still required).

**Standing rule:** every build session still starts by reading this row, then opening cited `~/cat-code/src` files. A count here is a routing hint, not permission to skip source.

---

## W1 — Engine seam & transport
*(infrastructure, not prototype UI — sourced from `~/cat-code/src`, listed for completeness)*

| Surface | Source | ⚓ | Faked? | Disposition |
|---|---|---:|---|---|
| `AppSessionController` driver | `src/app-runtime/AppSessionController.ts` | real:1 | — | port (adopt; tested) |
| Message stream (`SDKMessage`) | `src/app-runtime/sessionEvents.ts` / `src/entrypoints/sdk/coreTypes.generated.ts` | real:2 | — | port |
| Transport topology | `src/web/startRuntimeBackedWebMode.ts`, `src/web/AppSessionWebSocketServer.ts` | real:2 | — | build-new via **P0 topology bake-off**; loopback-WS is one candidate, in-process is refuted |
| Streaming deltas | `src/remote/sdkMessageAdapter.ts`, `SDKPartialAssistantMessage` | real:2 | yes (**S1**) | build-new + spec |

## W2 — App shell & multi-session

| Surface | File | ⚓ | Faked? | Disposition |
|---|---|---:|---|---|
| `Sidebar` | `Sidebar.jsx` | 4 | yes (**S3/S4**) | adapt (real `LogOption`/resume metadata; prototype `cost/model/tags/workspace` are fixture fields) |
| `TabBar` | `TabBar.jsx` | 4 | yes (**S3**) | adapt (real current-session status/panel routing exists; durable desktop tab manager is app-owned) — **❓ D1 registry** |
| `WorkspaceLayout` (1–3 split panels, resize, drag) | `WorkspaceLayout.jsx` | 4 | — | adapt (source backs panel/session routing; splitter resize chrome is prototype-only) |
| `CommandPalette` | `CommandPalette.jsx` | 6 | — | adapt (real command registry, bridge filtering, and session search are split across source) |
| `SlashCommandPicker` | `SlashCommandPicker.jsx` | 5 | — | adapt (real `CommandBase` / typeahead behavior; standalone picker is presentation split) |
| Root state / routing | `AppV2.jsx` | 7 | yes (**S3/S6**) | adapt/build-new (source has app state/routing primitives; prototype root is mock glue) |
| **N-process spawn/attach/multiplex + app registry** | app-owned; `src/utils/concurrentSessions.ts` is liveness only | 0 | yes (**S3**) | build-new + spec; do **not** treat `concurrentSessions.ts` as a durable registry — **❓ D1 registry** |

## W3 — Transcript & tool rendering
*(derive off real `SDKMessage` through the protocol + transcript-projector boundary in PROGRAM-PLAN §5)*

| Surface | File | ⚓ | Faked? | Disposition |
|---|---|---:|---|---|
| Core rows: `MessageRow`, `ThinkingBlock`, `RedactedThinkingBlock`, `UserImageRow`, `CommandEchoRow`, `LocalCommandRow`, `SystemNoticeRow` | `Messages.jsx` | 8 | partial (**S1**) | adapt (real messages are nested SDK/message content blocks, not a flat row zoo) |
| `ToolCard` + `ToolResultRow` (tool-card families) | `Messages.jsx` | 4 | partial (**S1**) | adapt (derive cards by correlating `tool_use` / `tool_result`; status is not stored) |
| `DiffView`, `MultiDiffCard` | `Messages.jsx` | 2 | — | adapt |
| Boundary rows: `CompactBoundaryRow`, `MicrocompactBoundaryRow`, `SnipBoundaryRow`, `SessionInitRow`, `ResultRow`, `TombstoneRow` | `Messages.jsx` | 6 | — | adapt; `MicrocompactBoundaryRow` is stale/cut unless a real visible mapping is found |
| Error/state rows: `ApiErrorRow`, `RateLimitRow`, `InterruptedRow`, `HookProgressRow`, `TaskAssignRow` | `Messages.jsx` | 4 | partial (**S1/S5**) | adapt; separate `RateLimitRow` is stale because source folds it into API error/retry handling |
| Prototype-only display types: `GroupedToolGroup`, `AgentEventRow`, `AgentMsgCard`, `AttachmentCard` | `Messages.jsx` | 3 | partial (**S5**) | adapt/recon; keep source-backed grouped tools/attachments, cut or redesign unverifiable agent chrome — **❓ D2 agent-chrome** |
| Markdown/code: `Prose`, `ProseCode`, Prism themes | `Messages.jsx` | 1 | — | port/adapt (target has `react-markdown` + `shiki`; source renderer differs) |
| Streaming/activity engine | `Chat.jsx` | 6 | yes (**S1/S2**) | build-new + spec; prototype `runPlaygroundTurn`/timers are demo-only |

## W4 — Feature domains

| Surface | File | ⚓ | Faked? | Disposition |
|---|---|---:|---|---|
| **Permissions** `PermissionQueue` | `Permissions.jsx` | 6 | yes (**S2**) | adapt + spec (real control request/response/update protocol is richer than queue cards) |
| `PermissionRulesEditor` | `PermissionRules.jsx` | 2 | partial (**S2**) | adapt (rule serialization is real; inline editor/debug/denial UI is prototype chrome) |
| **Composer** `ChatView` (input, slash, @-mention, paste-collapse, history) | `Chat.jsx` | 9 | partial (**S1/S2**) | adapt/build-new |
| `PlanBar` / `PlanPanel` | `PlanPanel.jsx` | 3 | yes (**S6**) | adapt/build-new (real plan is file/tool approval; live checklist/progress drawer is GUI-owned) |
| **Accounts** `AccountsPage`, Codex pool, leases | `Pages.jsx` | 10 | partial (**S8**) | adapt (real Codex pool/lease/refresh state is richer than prototype table) |
| `AccountLifecycle` dialogs | `AccountLifecycle.jsx` | 2 | partial (**S8**) | adapt/build-new (real commands exist; dialog surface is GUI-owned) |
| **Sessions page** `SessionsPage` | `SessionsPage.jsx` | 1 | yes (**S4**) | adapt (real session metadata is much richer than `MOCK_SESSIONS_EXTENDED`) |
| `SessionActionsMenu` + `BranchDialog`/`ExportDialog`/`RewindDialog` | `SessionActions.jsx` | 6 | partial (**S4**) | adapt (real branch/export/rewind commands exist separately; menu/dialog shell is GUI-owned) |
| `MetadataInspector` | `MetadataInspector.jsx` | 1 | yes (**S4**) | adapt (read-only metadata inspector over real log/message fields; no per-message account field) |
| **Agents config** `AgentsPage` | `AgentsPage.jsx` | 3 | yes (**S5**) | adapt (real agent/runtime model is broader than the prototype editor) |
| **Orchestrator** roster/detail/focus: `OrchestratorModeWorkerRoster`, `WorkerDetail`, `WorkerFocusView`, `AgentToolCard`, `DelegateGroup`, `BackgroundTaskStatus`, `deriveWorker`, `summarizeWorkers` | `OrchestratorMode.jsx` | 8 | yes (**S5**) | adapt; real Agent Mode roster/detail/focus/status exist, but inline `AgentToolCard`/`DelegateGroup` should be cut or replaced with task dialog/list plumbing — **❓ D2 agent-chrome** |
| **Tasks** `BgTasksDialog` / `TasksPanel` | `TasksPage.jsx` / `OrchestratorMode.jsx` | 4 / 0 | yes (**S5**) | adapt; `BgTasksDialog` is grounded, `TasksPanel` is unanchored GUI |
| `GoalsPage` + `GoalDetail` + create/replace dialogs | `GoalsPage.jsx` / `Surfaces.jsx` | 1 / 0 | yes (**S8**) | adapt (real thread goal is per-thread persisted state; roster/dialogs are GUI wrappers) |
| `MemoryPanel` (`/memory`) | `MemoryPage.jsx` | 1 | yes (**S8**) | adapt; anchor line range was stale, real memory types are `src/memdir/memoryTypes.ts:14-21` |

### W4 — Settings sub-domains

| Surface | File | ⚓ | Faked? | Disposition |
|---|---|---:|---|---|
| Settings shell + `Field`/`SourceBadge`/`ManagedBadge` primitives | `Settings.jsx` | 1 | partial (**S7**) | adapt (real settings source/editable/managed model is broader) |
| `MCPPanel`, `PluginsPanel`, `SkillsPanel`, `HooksPanel`, `ElicitationDialog` | `SettingsExtensions.jsx` | 5 | yes (**S7**) | adapt (real domains exist; prototype flattens scoped state and hook outcomes) |
| `RemoteSettingsPanel`, `RemoteRolePill` | `RemoteSettings.jsx` | 9 | yes (**S7**) | adapt; bridge/remote/direct-connect are real, paired-device roster is invented — **❓ D3 paired-devices** |
| `DiagnosticsSection`, `WorkspaceTrustSection` | `Pages.jsx` | 0 | partial (**S6/S7**) | adapt/recon; no surface-local anchors, but real status/trust helpers exist |

## W5 — Foundations, shared primitives & release

| Surface | File | ⚓ | Faked? | Disposition |
|---|---|---:|---|---|
| Shared primitives: `Chip`, `ChipStrip`, `BannerStack`, `ToastHost`, `MentionPicker`, `ToolInspector` | `Surfaces.jsx` | 5 | partial (**S7**) | adapt (source analogs are split TUI primitives; product primitive layer is target-owned) |
| Connection UI: `ConnectionChip`, `ConnectionDemoBar`, `CONN_STATES` | `Surfaces.jsx` | 2 | yes (**S7**) | adapt; **cut `ConnectionDemoBar` simulator** |
| `AgentIdentity` (shared agent vocabulary) | `AgentIdentity.jsx` | 4 | partial (**S5**) | adapt (useful vocabulary, but compresses real worker/task/agent state) |
| **Startup/trust** `StartupFlow`, `ReauthGate`, `WorkspaceSwitchPrompt` | `Startup.jsx` | 11 | partial (**S6**) | adapt; trust/OAuth are real, read-only/workspace-switch/forced-reauth gates are GUI inventions — **❓ D4 startup-gates** |
| Resume: `CrossProjectResumeDialog`, `HydrationOverlay` | `ResumeStates.jsx` | 2 | yes (**S6**) | adapt; real resume is synchronous restore/recovery, overlay/diff list is visualization |
| `WelcomeScreen` | `Welcome.jsx` | 1 | partial (**S6/S8**) | adapt (trust/account/orchestrator pieces are real; project recents/branch picker launcher is GUI-owned) — **❓ D5 welcome-launcher** |
| Design tokens / theme → Tailwind | `CatCode Web App.html` `<style>` + inline | 0 | — | build-new (W5 Phase 0) |

## CUT — demo-only / excluded (do not migrate)

| Surface | Why |
|---|---|
| `ConnectionDemoBar` / connection demo state machine | Loaded demo simulator; migrate only real connection diagnostics/chips. |
| `OrchestratorDemoSwitch` | Loaded A/B/C demo scaffold (`s-orchestrator` only); keep out of product migration. |
| `PrototypeControlsSection` / `ConnectionDemoSection` | Loaded settings diagnostics stub for prototype controls; do not migrate as product UI. |
| DEMO-ONLY sessions (`s-perm`, `s-tool-gallery`, `s-taxonomy`) | Fixture sessions. |
| `Workspace.jsx`, `composer-variants.jsx`, `menu-variants.jsx`, `profile-variants.jsx`, `design-canvas.jsx` | Historical paths; absent from current loaded prototype. |
| `ConnectionDemo.jsx` | Exists on disk but is not loaded by `CatCode Web App.html`. |
| `saCopy`/`saToMarkdown`/`saToText`/`saGetMessages`, `resetStartup`, leaked globals | Helper fns / utilities, not migration surfaces. |

---

## What the repaired ledger exposes

1. **Zero-anchor is no longer the main risk signal.** Several formerly `❌` rows have real grounding through unanchored source shapes (`Sidebar`, `TabBar`, `SlashCommandPicker`). The risk is now **shape drift**: prototype shells compress richer real state.
2. **Only one active row remains truly source-empty for its claimed capability:** the durable **N-process app registry/multiplex**. `concurrentSessions.ts` is PID/liveness metadata only, so this remains build-new + S3.
3. **Faked/runtime behavior is broader than the old prose claimed:** 28 active rows are `yes`/`partial`, grouped under eight spec IDs above.
4. **Most `port` rows became `adapt`.** The migration remains a faithful UX rebuild, but production code must map real engine shapes instead of copying prototype fixture schemas.
5. **CUT now means “do not migrate,” not necessarily “dead code.”** Several cut surfaces are loaded demo scaffolds; they stay excluded because they are simulators, not because they are absent.

---

## Human-decision list (OPEN — `❓ Dx` rows above are PROVISIONAL until these are made)

These are **product/architecture calls a subagent cannot make.** The dispositions on the
tagged rows reflect a *recommendation*, not a settled decision — do not build them as final
until the owner rules. (Stamped onto rows as `❓ D1`…`❓ D5`.)

1. **D1 — Desktop session registry.** Define the app-owned durable registry + attach/
   multiplex/restore contract. `concurrentSessions.ts` cannot fill it. *Rows: N-process,
   TabBar.* — this is also the plan's P0-2 existential risk (PROGRAM-PLAN §4/§7).
2. **D2 — Which Agent-Mode chrome survives.** Cut or redesign prototype `AgentEventRow`/
   `AgentMsgCard`/inline `AgentToolCard`/`DelegateGroup` over the real task dialogs/lists?
   *Rows: W3 prototype-only display types, Orchestrator.*
3. **D3 — Paired devices: back it or cut it.** The paired-device roster/wizard is a
   prototype invention; add a real backing model or cut. *Row: RemoteSettings.*
4. **D4 — Are startup GUI gates real requirements?** Read-only startup, workspace-switch
   prompt, forced reauth — product requirement or prototype storytelling? *Row: Startup/trust.*
5. **D5 — Does welcome launcher state persist?** Do project recents, branch chooser, and
   "start in" become desktop-owned persistence? *Row: WelcomeScreen.*
6. **D6 — When the window closes, does the agent stop? → ✅ DECIDED 2026-07-02: DIE-WITH-WINDOW
   for v1.** *(added 2026-07-02 from `reviews/2026-07-02-direction-review.md` DR-1; ruled by owner same
   day.)* The locked topology makes Electron main the **parent** of the N engine sidecars, so by
   default sessions die with the window and every auto-update (Phase 5) kills live agent work. The
   product's own identity is an **always-on** agent that "keeps working while the main Mac sleeps" /
   "must function independently on the server Mac" (`package.json:5`, `README.md:7-10`,
   `docs/vision/2026-04-30-GOAL_PLAN.md:16-22,75`) — the agent is *meant* to outlive the control
   surface — but that is a later milestone, not a v1 requirement. **Ruling: v1 sessions die with
   the window** (parity with today's TUI). **Non-negotiable structural condition of that ruling:**
   the P1-0 brief still pins the window-independent host structure (filesystem socket + Electron-free
   supervisor module) so the server-Mac milestone is an *attach*, not a Phase-3 rewrite. The
   decision was to accept die-with-window *behavior* for v1, NOT to weld the sidecars to the window.
   *Rows: N-process, TabBar; overlaps [[D1]] (the registry is that host module's API).* The
   always-on flip becomes a future milestone against the same host module, not a re-architecture.

> **Provenance:** repaired from the 2026-06-26 scrape via the two-squad source pass of
> 2026-06-28 — full evidence (per-row anchor classifications, empty-recon verdicts,
> under-counts, row-set fixes) in `reviews/2026-06-28-inventory-verification.md`.
