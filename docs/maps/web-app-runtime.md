# App Runtime Routing Map

Last refreshed: 2026-09-06 against `src/app-runtime/`,
`src/bootstrap/state.ts`, `src/QueryEngine.ts`, `app/`, and related tests.

Use this map for the Electron runtime-backed app-session path. It covers the
active desktop app stack, not older dedicated-app design docs.

## First Files To Inspect

1. `app/main/main.ts` for Electron host, IPC, attachment, and cache wiring.
2. `app/shared/protocol.ts` and `app/shared/hostApi.ts` for desktop wire/control contracts.
3. `app/sidecar/sessionController.ts` and `app/sidecar/sidecarServer.ts` for the engine boundary.
4. `app/renderer/src/{App,SessionPane,TranscriptView,BoundedMarkdown,VirtualLineList}.tsx` for session chrome and bounded transcript rendering. `App` is the shell; `SessionPane` is one session's pane.
5. `app/main/{idleParkDriver,mainDecisions}.ts`, `app/scripts/{dev,devLauncher}.ts`, and `app/sidecar/contextBreakdownDomain.ts` for parking, development launch lifecycle, and on-demand context usage.

## Routing Table

| Area | Inspect first | Then inspect | Routing notes |
|---|---|---|---|
| QueryEngine app-session setup | `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts` | `src/services/mcp/client.ts`, `src/state/AppStateStore.ts`, `src/utils/fileStateCache.ts` | This config seam snapshots normal startup owners for runtime-backed app sessions, merges built-in plus MCP tools/commands, and clones prefetched MCP resources into app-state reads. |
| Runtime-backed app session seam | `src/app-runtime/createRuntimeBackedAppSession.ts` | `src/app-runtime/createQueryEngineAppSession.ts`, `src/app-runtime/createQueryEngineSessionController.ts`, `src/app-runtime/index.ts` | The desktop sidecar uses this seam to construct its controller/session pair. The QueryEngine-backed session and controller adapter live underneath it. |
| App session turn lifecycle | `src/app-runtime/AppSessionController.ts` | `src/app-runtime/{sessionEvents,attachThreadGoalScheduler}.ts`, `src/utils/threadGoalScheduler.ts`, `app/renderer/src/{connectionState,rawMessageLog}.ts`, `src/services/api/accountDiagnostics.ts` | `AppSessionController` owns active-turn gating, abort state, goal snapshots, permission request handoff, and emission of session events/messages. `attachThreadGoalScheduler` adapts completed turns to the shared scheduler, so desktop, headless, and terminal runtimes use one continuation policy. Its sole active-turn writer emits `turn.status` on each transition; the desktop renderer reduces that live event into `inputEnabled` rather than relying on the attach-time `app.ready` snapshot. |
| Multi-session process isolation | `src/app-runtime/multiSessionIsolation.probe.test.ts` | `src/bootstrap/state.ts`, `src/QueryEngine.ts`, `src/utils/Shell.ts` | The probe demonstrates that controller-local permission state is isolated, but concurrent sessions in one engine process share process-global cwd and session ID. Route desktop multi-session topology through this evidence before choosing one-process versus per-session processes. |
| Electron desktop startup, security, and observability | `app/main/main.ts` | `app/main/mainDecisions.ts`, `app/scripts/{dev,prepare-dev-electron}.ts`, `app/main/navigationPolicy.ts`, `app/main/{attachmentGate,replayBuffer,operationalLogSink,deliveryTraceSink,diagnosticsBundle}.ts` | Electron main applies the window/security baseline, owns fixed IPC handlers, starts with no engine session, gates/replays frames across renderer attachment and reload, and exposes host-level sidecar restart. It owns the native file chooser too: a session-scoped opaque token resolves in main to an internal `@` mention before a submit crosses to the sidecar. A renderer action creates or restores each sidecar-backed session. It also owns private operational JSONL, delivery-trace persistence, and the allowlisted support-bundle export; raw sidecar stderr never enters those artifacts. `SIDECAR_RUNTIME_ARGS` enables the desktop engine's classifier and reactive-compaction features; the dev launcher starts Vite, but main chooses that origin only when Electron reports an unpackaged app. |
| Desktop host registry and restart policy | `app/host/registry.ts` | `app/host/host.ts`, `app/supervisor/supervisor.ts`, `app/main/main.ts` | The Electron-free host persists restorable session rows and owns renderer-reachable spawn/restart limits. Registry writes take an advisory lock, merge the current document with local deltas, and atomically replace it; a failed read preserves the existing file and disables writes for that run, while a failed write degrades persistence without killing a live session. Route restart-in-place through `host.ts` so replay eviction, transcript viability, and row hints stay synchronized. |
| Desktop peer-session request plane | `app/main/peerRequestPlane.ts` | `app/host/{host,peerNames,registry}.ts`, `app/sidecar/{createPeerTool,listPeersTool,readPeerTool,sendToPeerTool,peerHostRequester}.ts`, `app/shared/{protocol,hostApi,operationalLog}.ts` | Peers are created and named by host-owned policy, not the renderer. The sidecar validates the closed peer-tool frames, main authorizes and routes requests between live/restored sessions, and the operational record admits routing metadata but no message text. Preserve creator identity and the registry churn/live-spawn gates across restore. |
| Desktop sidecar lifecycle | `app/supervisor/supervisor.ts` | `app/shared/framing.ts`, `app/shared/limits.ts`, `app/shared/protocol.ts` | The Electron-free supervisor owns the session-to-child registry, bounded Unix-socket path allocation, framed transport, restart/kill behavior, and sidecar status events. |
| Desktop engine boundary | `app/sidecar/index.ts`, `app/sidecar/sidecarServer.ts` | `app/sidecar/sessionController.ts`, `app/sidecar/initializeRuntime.ts`, `app/shared/limits.ts`, `src/app-runtime/` | The Bun sidecar initializes the real runtime, constructs a QueryEngine-backed controller, strictly validates inbound allowlisted frames, reattaches only engine-minted permission updates, and raw-forwards cloneable, JSON-safe, secret-screened session events. A mid-turn `app.submit` enters the engine command queue (with a bounded desktop depth) and has a sidecar boundary-drain fallback if that turn ends before consumption. |
| Desktop Agent Mode controls | `app/sidecar/agentModeDomain.ts` | `app/sidecar/sidecarServer.ts`, `app/shared/protocol.ts`, `app/main/main.ts`, `app/preload/preload.ts`, `app/renderer/src/AgentChrome.tsx` | The sidecar joins persisted Agent Mode state with live local-agent tasks for a redacted snapshot. Its allowlisted set verb switches only the sidecar process through `matchSessionMode()` and broadcasts a fresh snapshot. |
| Desktop Agent Mode roster and lease read seam | `app/sidecar/{agentModeDomain,leaseDomain,panelTaskReaper}.ts` | `app/shared/protocol.ts`, `app/sidecar/sidecarServer.ts`, `src/utils/task/framework.ts`, `app/renderer/src/{AgentChrome,OrchestratorRoster}.tsx`, `app/renderer/src/workerInspection.ts`, `app/renderer/src/{orchestratorState,leaseState}.ts` | The sidecar joins this session's persisted Agent Mode state with live local-agent tasks, including backgrounded status, and the renderer derives roster/worker display state from that redacted snapshot. `panelTaskReaper` is the desktop equivalent of the terminal panel tick: it schedules terminal local-agent eviction at the engine-stamped deadline through the engine’s guarded eviction entry point. The read-only Codex lease snapshot follows the same lifecycle; lease assignment, release, and failover remain engine-owned, with no renderer-to-sidecar lease verb. |
| Desktop context breakdown | `app/sidecar/contextBreakdownDomain.ts` | `app/sidecar/sidecarServer.ts`, `app/shared/protocol.ts`, `app/renderer/src/{ContextGauge,contextBreakdownState,contextUsage}.ts*` | The sidecar computes the detailed context categories only on an explicit app-local request, coalesces concurrent demand, and returns no collapsed or unavailable row as a usable breakdown. The renderer opens the popover from the returned snapshot rather than estimating categories itself. |
| Desktop permission mode | `app/sidecar/permissionDomain.ts` | `app/sidecar/sidecarServer.ts`, `app/shared/protocol.ts`, `app/renderer/src/{PermissionModeChip,PermissionPrompt}.tsx` | `permission.setMode` is sidecar-local, session-scoped vocabulary. The sidecar rejects unavailable Auto using live classifier facts; `bypassPermissions` is selectable in the app, while the engine's own bypass killswitch remains authoritative. Renderer-supplied destinations or engine-shared-protocol expansion are not valid substitutes. |
| Desktop accounts and OAuth lifecycle | `app/sidecar/accountsDomain.ts`, `app/sidecar/accountsPoolWorker.ts` | `app/main/accountsPoolRunner.ts`, `app/shared/{accountsPoolWorker,protocol}.ts`, `app/sidecar/sidecarServer.ts`, `src/services/api/codexTokenRefresh.ts`, `app/renderer/src/AccountsPage.tsx`, `app/renderer/src/StartupSurfaces.tsx` | The renderer receives redacted Anthropic and Codex pool summaries, including primary and weekly usage-reset times when available, a non-secret `anthropicRouteAvailable` boolean (covers OAuth/API key/Bedrock/Vertex/Foundry), and non-secret OAuth progress. Global Codex profile deletion uses a fixed host command and one-shot engine worker, so it requires no chat session. Deletion shares the profile lock with token refresh, returns a correlated secret-screened result plus the fresh redacted pool, and main invalidates the deleted account's process-local state and leases in every live or starting sidecar. Session-local switching and the long-lived OAuth flow remain on the addressed sidecar. |
| Desktop session and message actions | `app/sidecar/sessionActionsDomain.ts` | `src/{QueryEngine,commands/branch/branch}.ts`, `src/utils/{sessionStorage,conversationRecovery}.ts`, `app/shared/{protocol,hostApi}.ts`, `app/sidecar/sidecarServer.ts`, `app/main/{openHistorySession,replayBuffer}.ts`, `app/renderer/src/{App,SessionPane,TranscriptView,TabBar,sessionActions,composerState}.ts*` | Rename, tag, and plain-text export remain fixed session actions. Operator-authored user messages expose Copy, Edit from here, and Branch from here. The sidecar re-resolves the engine-produced message prefix; Edit durably marks the retained conversation tip, emits `transcript.reset`, and replays the canonical retained history before returning the full prompt for composer restoration. Branch writes a canonical prefix fork, main seeds the existing hardened history-open resolver from trusted sidecar identity plus host-owned cwd, and the registry persists `forked:true` so TabBar renders a split glyph before the title. Both are conversation-only; desktop file checkpointing remains disabled. |
| Desktop worker stop control | `app/sidecar/taskControlDomain.ts` | `app/shared/protocol.ts`, `app/sidecar/sidecarServer.ts`, `app/renderer/src/tasksState.ts`, `app/renderer/src/TasksDialog.tsx` | The renderer can name a running task only. The sidecar re-resolves it in the session store and uses the engine's `stopTask`; the normal task and Agent Mode snapshots carry the resulting state change. |
| Desktop settings editors | `app/sidecar/settingsDomain.ts` | `app/shared/settingsEditable.ts`, `app/shared/protocol.ts`, `app/sidecar/sidecarServer.ts`, `app/renderer/src/settingsState.ts`, `app/renderer/src/SettingsEditors.tsx` | Editable values use a closed non-secret allowlist and the engine’s locked settings writer. The sidecar re-emits provenance and values after a successful write; session-scoped dynamic options include output styles and the engine’s current model-picker options. Choosing the reserved default-model entry removes the override rather than persisting a sentinel. |
| Desktop preload contract | `app/preload/preload.ts` | `app/preload/{rendererIpcGuard,deliveryAckQueue}.ts`, `app/shared/{protocol,deliveryTrace}.ts`, `app/main/main.ts` | The context-isolated preload exposes fixed submit, abort, permission, ping, restart, subscribe, renderer-ready, trace acknowledgement, renderer-fault, and local diagnostics actions. A byte/rate guard protects the fixed senders and there is no generic IPC channel API. Trace acknowledgements use the bounded queue: rate rejection retains and retries the batch, while permanent size/serialization rejection drops it without surfacing through renderer effects. |
| Desktop AskUserQuestion answers | `app/renderer/src/AskQuestionFlow.tsx`, `app/renderer/src/askQuestionState.ts` | `app/renderer/src/permissionState.ts`, `app/shared/protocol.ts`, `app/preload/preload.ts`, `app/main/main.ts`, `app/sidecar/sidecarServer.ts` | AskUserQuestion is rendered from the existing pending-permission queue, not a parallel store. The renderer sends only option indices plus bounded freeform text through a fixed IPC channel. The sidecar strictly validates the app-local frame, matches the engine-minted pending request, rebuilds labels from gated engine input, and resolves through the existing allow path; decline remains the normal permission deny response. |
| Desktop sessions catalog and history opening | `app/renderer/src/sessionsCatalogState.ts` | `app/main/sessionsCatalogRunner.ts`, `app/sidecar/sessionsCatalogWorker.ts`, `app/sidecar/sessionsCatalogCache.ts`, `app/main/{sessionsCatalogBaseline,openHistorySession,replayBuffer}.ts`, `app/shared/{protocol,hostApi}.ts` | One main-supervised, serialized engine-graph worker emits the global catalog; failed runs retain the last good renderer snapshot and the worker best-effort cache remains the cold-launch baseline. A history-only row sends only its engine session ID: main validates it, resolves cache-derived cwd/title, deduplicates existing/in-flight desktop rows, and creates the engine resume. For load-earlier, main stamps the replay ring's oldest retained UUID; the sidecar compares that main-authored anchor after its own bounded disk read, so it cannot call a truncated renderer view complete. Missing catalog data or an empty cwd fails closed. |
| Desktop idle-engine parking | `app/main/idleParkDriver.ts` | `app/main/{main,mainDecisions}.ts`, `app/shared/{protocol,limits}.ts`, `app/sidecar/{sidecarServer,index}.ts`, `app/host/{host,registry}.ts`, `app/preload/preload.ts`, `app/renderer/src/{connectionState,composerState,tabStatus}.ts` | Main enforces the live-engine cap and the 120-minute idle TTL, then sends host-originated `app.park` frames, skipping the panes the renderer reports as on screen. The sidecar alone gates park on no active turn, permission, or task and exits with the dedicated parked code; host retains the tab as restorable. A normal app quit marks parked rows clean, while a real crash remains distinguishable. The renderer classifies that exit code into a non-terminal `'parked'` status, so a park paints no failure and the next submit restores. No renderer or preload path can originate a park. |
| Desktop development launcher | `app/scripts/{dev,devLauncher}.ts` | `app/main/main.ts`, `app/scripts/{prepare-dev-electron,hardening-smoke}.ts`, `app/package.json` | The development wrapper supervises Vite and Electron startup/teardown as one lifecycle. Keep startup failures and child teardown routed through this owner instead of adding an independent launcher path. |
| Desktop restore preview cache | `app/main/transcriptCache.ts` | `app/main/main.ts`, `app/shared/transcriptRunFacts.ts`, `app/shared/hostApi.ts`, `app/preload/preload.ts`, `app/renderer/src/previewTranscriptState.ts` | A dead restorable session may be previewed without spawning a sidecar. The main process reads only bounded, versioned, secret-screened cache frames after the host’s `canPreview()` gate; renderer state merges the later live replay. Both cache writers, startup backfill and the close/park/crash persist, read the newest `system`/`run_facts` snapshot as a unit for the model, permission mode, effort, and actual context window, falling back to legacy byproduct records for older transcripts. The close path is engine-free and so writes a header only when the derived facts are complete; otherwise it writes none and the renderer reads the frames instead. |
| Desktop renderer shell and session routing | `app/renderer/src/App.tsx`, `app/renderer/src/shellState.ts` | `app/renderer/src/SessionPane.tsx`, `app/renderer/src/TabBar.tsx`, `app/renderer/src/Sidebar.tsx`, `app/renderer/src/tabStatus.ts`, `app/renderer/src/sidebarState.ts`, `app/host/registry.ts` | `App` seeds the host roster, folds live host events without polling, and owns active selection plus create/close/restart/restore calls. Tabs retain arrival order; the sidebar projects the merged roster by real message-send time (then transcript activity or creation), never by attach/open time. Its per-workspace plus uses the host-side registry row rather than a renderer-authored path. `SessionPane.tsx` holds what one pane renders once a session is selected; pane work belongs there, not in the shell. |
| Desktop transcript, composer, restore affordance, and picker state | `app/renderer/src/{transcriptProjector,previewTranscriptState,composerState}.ts` | `app/sidecar/subagentHistory.ts`, `app/renderer/src/{TranscriptView,ComposerInput,ToolsExpandedProvider,toolRunLayout,MetadataInspector,messageMetadata,ToolInspector}.ts*`, `app/renderer/src/connectionState.ts`, `app/renderer/src/rawMessageLog.ts`, `app/renderer/src/SlashCommandPicker.tsx`, `app/main/openWorkspaceFile.ts` | Live and cached rows stay separate until replay takes over. Restore splices a subagent's sidechain frames immediately after its parent Agent tool use, stamps the engine-minted name, and drops unreachable branches so children remain nested rather than interleaved. `TranscriptView` projects task notifications, grouped/expanded tool runs, persisted local-command output, clickable model-authored workspace paths, and the hover/focus Copy/Edit/Branch row under eligible user text. `ComposerInput` owns collapsed-paste editing; a confirmed historical Edit/Branch replaces the target composer draft and accepted base64 images from trusted engine output. Metadata joins task snapshots to engine-minted subagent records, while the picker consumes the sidecar’s read-only rich slash-catalog snapshot with names-only fallback. |
| Bounded desktop transcript rendering | `app/renderer/src/BoundedMarkdown.tsx` | `app/renderer/src/markdownRenderPlan.ts`, `app/renderer/src/VirtualLineList.tsx`, `app/renderer/src/lineWindow.ts`, `app/renderer/src/TranscriptView.tsx` | Long assistant prose is planned into render leaves, measured, and windowed within its scroll parent; off-window content is represented by spacers. Inline tool output uses the same virtual line list and preserves reveal-band placement and real line numbers. Open fences stay in the same code-card frame, but their copy control remains disabled until the fence is complete. |
| Streamed prose-arrival preference | `app/renderer/src/proseArrival.ts` | `app/renderer/src/ProseArrivalProvider.tsx`, `app/renderer/src/proseArrivalMark.ts`, `app/renderer/src/ProseArrivalPreview.tsx`, `app/renderer/src/SettingsShell.tsx`, `app/renderer/src/TranscriptView.tsx` | This is renderer-local, versioned local-storage state, not an engine setting. It marks only newly delivered prose for instant, smooth, or flowing presentation; content is never buffered or delayed before visibility. |

## Tests And Validation

| Change area | Command |
|---|---|
| Docs-only map sanity | `git diff --check -- docs/maps/web-app-runtime.md docs/maps/WORKSPACE_MAP.md docs/maps/build-release-testing.md` |
| App-runtime session seam | `bun test src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts src/app-runtime/createQueryEngineAppSession.test.ts src/app-runtime/createQueryEngineSessionController.test.ts src/app-runtime/AppSessionController.test.ts` |
| App-runtime goal continuation | `bun test src/app-runtime/attachThreadGoalScheduler.test.ts src/utils/threadGoalScheduler.test.ts` |
| Multi-session process isolation probe | `bun test src/app-runtime/multiSessionIsolation.probe.test.ts` |
| Desktop tests | `bun test app/` |
| Desktop shell/preload/renderer typecheck | `bun run --cwd app typecheck` |
| Desktop engine-sidecar typecheck | `bun run --cwd app typecheck:sidecar` |
| Desktop renderer build | `bun run --cwd app renderer:build` |
| Bounded transcript rendering | `bun test app/renderer/src/BoundedMarkdown.test.tsx app/renderer/src/markdownRenderPlan.test.ts app/renderer/src/lineWindow.test.ts` |
| Prose-arrival storage, marking, and preview | `bun test app/renderer/src/ProseArrivalProvider.test.tsx app/renderer/src/proseArrivalMark.test.ts app/renderer/src/proseArrivalPreviewModel.test.ts app/renderer/src/proseArrivalPreview.dom.test.ts` |
| Desktop hardening smoke | `bun run --cwd app test:hardening` |
| Desktop AskUserQuestion flow | `bun test app/renderer/src/AskQuestionFlow.test.tsx app/renderer/src/askQuestionState.test.ts app/sidecar/sidecarServer.test.ts app/preload/preloadSource.test.ts` |
| Desktop action/control seams | `bun test app/sidecar/sessionActionsDomain.test.ts app/sidecar/taskControlDomain.test.ts app/sidecar/settingsDomain.test.ts app/renderer/src/sessionActionRuntimeState.test.ts app/renderer/src/TasksDialog.test.tsx app/renderer/src/SettingsEditors.test.tsx` |
| Desktop sessions catalog and history opening | `bun test app/main/openHistorySession.test.ts app/main/sessionsCatalogBaseline.test.ts app/sidecar/sessionsCatalogDomain.test.ts app/sidecar/sessionsCatalogCache.test.ts app/renderer/src/sessionsCatalogState.test.ts` |
| Desktop catalog worker and idle parking | `bun test app/main/sessionsCatalogRunner.test.ts app/main/idleParkDriver.test.ts app/sidecar/sidecarServer.test.ts app/host/{host,registry}.test.ts` |
| Desktop attachment, replay, and history boundary | `bun test app/main/mainDecisions.test.ts app/main/replayBuffer.test.ts app/main/mainSourceGuards.test.ts app/preload/preloadSource.test.ts app/sidecar/historyLoadEarlier.test.ts` |
| Desktop host registry durability and restart limits | `bun test app/host/{host,registry}.test.ts app/supervisor/supervisor.test.ts` |
| Desktop peer-session request plane | `bun test app/main/peerRequestPlane.test.ts app/host/{host,peerNames,registry}.test.ts app/sidecar/{createPeerTool,listPeersTool,readPeerTool,sendToPeerTool,sidecarServer}.test.ts` |
| Desktop Agent Mode roster, terminal-worker expiry, and restored Agent cards | `bun test app/sidecar/agentModeDomain.test.ts app/sidecar/panelTaskReaper.test.ts app/sidecar/subagentHistory.test.ts app/sidecar/subagentRestore.probe.test.ts app/renderer/src/{orchestratorState,workerInspection,transcriptProjector}.test.ts` |
| Desktop delivery acknowledgement queue | `bun test app/preload/deliveryAckQueue.test.ts app/preload/rendererIpcGuard.test.ts app/main/deliveryTraceSink.test.ts` |

## Traps And Stale Assumptions

- The desktop protocol snapshot in `app/shared/engine-types.snapshot.d.ts`
  isolates Electron/preload/renderer typechecking from the Bun engine graph.
  Keep it synchronized with the canonical source types it cites.
- `app/renderer/src/transcriptProjector.ts` is the renderer anti-corruption
  boundary for SDK messages. Keep its exhaustive switch and
  `sdkMessageFixtures.ts` coverage aligned when the SDK union grows.
- A restored subagent transcript lives in its own sidechain, not the parent
  transcript. Route restoration through `app/sidecar/subagentHistory.ts` and
  preserve the `parent_tool_use_id` join; never append an unreachable branch to
  the top-level transcript merely to show it.
- `app/renderer/src/shellState.ts` owns roster ordering, not active focus.
  `App.tsx` owns focus transitions so background frames and host events cannot
  silently steal the active pane. Splitting `SessionPane.tsx` out of `App.tsx`
  (2026-09-06) did not move either ownership: the pane renders one session, the
  shell still decides which one is active.
- A transcript cache is an untrusted recovery artifact, not a second transcript
  authority: preserve its size, schema/version, and secret checks, and do not
  bypass the host’s not-live/restorable gate to display it.
- Desktop Electron main and the renderer must not import engine runtime modules.
  The Bun sidecar is the engine boundary; `app/supervisor/` must remain
  Electron-free.
- Auto permission mode depends on the live engine gate and the sidecar's Bun
  classifier feature flag; a renderer mode control cannot enable either one.
- `CATCODE_RENDERER_URL` does not override Electron's packaged branch. If a dev
  launch loads `renderer/dist` or HMR and dev-only UI disappear, inspect
  `app.isPackaged` and the prepared bundle's executable name before rebuilding
  renderer output.
- Desktop sessions are process-isolated because QueryEngine uses process-global
  cwd and session identity. Route lifecycle changes through the supervisor's
  session-addressed child registry.
- `createQueryEngineAppSessionConfigFromSetup.ts` snapshots MCP tools,
  commands, clients, and resources for the desktop sidecar. If startup data is
  missing there, inspect this seam before changing controller logic.
- `AppSessionController` guards active turns; understand its lifecycle before
  changing desktop concurrency behavior.
- Separate `AppSessionController` instances do not isolate the process-global
  cwd and session ID used by `QueryEngine`. Re-run the isolation probe before
  designing a multi-session desktop host around one engine process.
- The root lint configuration also does not cover `app/**`; use the desktop
  tests and both desktop typecheck boundaries for that tree.
- `askUserQuestion.answer` is deliberately app-local vocabulary, not part of
  the shared engine client-message schema. Never trust renderer option labels,
  question text, or a stale request ID: the sidecar must derive labels and
  semantics from the still-pending engine-gated request.
- Session action and task-stop messages are also app-local, closed vocabulary.
  Do not forward an arbitrary renderer operation to the engine: the sidecar must
  validate the exact verb and re-resolve its live session or task target.
- A branch creates an engine transcript, not an Electron-host session. Message-level
  Branch opens it only through `openHistorySession`: main combines the trusted
  sidecar result with host-owned cwd, then mints a distinct app session. Never
  treat the engine id as an app-session id or accept cwd/title provenance from
  the renderer.
- A transcript-history row is not a host registry row. On history open, never
  accept a renderer cwd or guess one from a sanitized transcript directory; main
  must use the validated sidecar-written catalog cache and fail closed when it
  cannot resolve the workspace. The engine’s ordinary resume path has no
  cross-process liveness lock, so this route intentionally matches that behavior.
- The sessions catalog is no longer refreshed independently by each sidecar.
  Keep its one main-supervised worker serialized and fail closed on malformed or
  secret-bearing output; a failed run must retain the last good catalog.
- `app.park` is host-originated policy input. No renderer or preload path may
  ORIGINATE a park: only the sidecar can approve one, and the host must preserve
  its tab for restore. A preload channel may only ever SUPPRESS a park, which is
  what `reportVisibleSessions` does (it names on-screen panes to exempt, and can
  start nothing) — do not widen it into a park request.
- A parked process exit is not a crash, and that is now a RENDERER-visible fact
  as well as a host one: the renderer classifies `PARKED_EXIT_CODE` off the
  lifecycle frame into a non-terminal `'parked'` connection status, so an
  intentional reclaim paints no failure and needs no Restart
  (`decisions/IDLE-PARK.md` §1a/§3a/§4a). Surfaces keyed on the DESCRIPTOR still
  read a park as `crashed` — the descriptor is deliberately identical to a crash
  (§11), and closing that gap is open work.
