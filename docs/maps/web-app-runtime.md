# App Runtime Routing Map

Last refreshed: 2026-08-06 against `src/main.tsx`, `src/app-runtime/`,
`src/bootstrap/state.ts`, `src/QueryEngine.ts`, `src/web/`,
`src/services/mcp/client.ts`, `web/`, `app/`, and related tests.

Use this map for the browser and Electron runtime-backed app-session paths.
It covers the active local app stacks, not older dedicated-app design docs or
the legacy REPL relay server.

## First Files To Inspect

1. `src/main.tsx` and `src/web/startRuntimeBackedWebMode.ts` for browser startup.
2. `app/main/main.ts` for Electron host, IPC, attachment, and cache wiring.
3. `app/shared/protocol.ts` and `app/shared/hostApi.ts` for desktop wire/control contracts.
4. `app/sidecar/sessionController.ts` and `app/sidecar/sidecarServer.ts` for the engine boundary.
5. `app/renderer/src/App.tsx`, `app/renderer/src/sessionsCatalogState.ts`, and `app/renderer/src/permissionState.ts` for session/pane behavior, history, and interactive question handling.
6. `app/main/{sessionsCatalogRunner,idleParkDriver,openHistorySession}.ts` and `app/sidecar/transcriptRunFacts.ts` for global catalog refresh, idle-engine reclaim, history opening, and preview run facts.

## Routing Table

| Area | Inspect first | Then inspect | Routing notes |
|---|---|---|---|
| Web-mode startup path | `src/main.tsx` | `src/web/startRuntimeBackedWebMode.ts`, `src/web/launchWebAppDevServer.ts`, `web/package.json` | `main.tsx --web` now builds a runtime-backed app-session config, starts `AppSessionWebSocketServer`, launches Vite on `127.0.0.1`, and skips the Ink REPL. |
| Runtime-backed web-mode orchestrator | `src/web/startRuntimeBackedWebMode.ts` | `src/app-runtime/createRuntimeBackedWebAppSession.ts`, `src/web/AppSessionWebSocketServer.ts`, `src/web/launchWebAppDevServer.ts` | This helper owns runtime-backed `--web` startup order, token redaction in startup/cleanup errors, and coordinated shutdown of the browser server plus Vite child process. |
| QueryEngine app-session setup | `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts` | `src/services/mcp/client.ts`, `src/state/AppStateStore.ts`, `src/utils/fileStateCache.ts` | This config seam snapshots normal startup owners for runtime-backed app sessions, merges built-in plus MCP tools/commands, and clones prefetched MCP resources into app-state reads. |
| Runtime-backed app session seam | `src/app-runtime/createRuntimeBackedWebAppSession.ts` | `src/app-runtime/createQueryEngineAppSession.ts`, `src/app-runtime/createQueryEngineSessionController.ts`, `src/app-runtime/index.ts` | Use this seam when startup wiring needs a controller/session pair for the browser app. The QueryEngine-backed session and controller adapter live underneath it. |
| App session turn lifecycle | `src/app-runtime/AppSessionController.ts` | `src/app-runtime/sessionEvents.ts`, `app/renderer/src/{connectionState,rawMessageLog}.ts`, `src/services/api/accountDiagnostics.ts` | `AppSessionController` owns active-turn gating, abort state, goal snapshots, permission request handoff, and emission of session events/messages. Its sole active-turn writer emits `turn.status` on each transition; the desktop renderer reduces that live event into `inputEnabled` rather than relying on the attach-time `app.ready` snapshot. The browser mapper deliberately drops this desktop-only event. |
| Multi-session process isolation | `src/app-runtime/multiSessionIsolation.probe.test.ts` | `src/bootstrap/state.ts`, `src/QueryEngine.ts`, `src/utils/Shell.ts` | The probe demonstrates that controller-local permission state is isolated, but concurrent sessions in one engine process share process-global cwd and session ID. Route desktop multi-session topology through this evidence before choosing one-process versus per-session processes. |
| Browser transport server | `src/web/AppSessionWebSocketServer.ts` | `src/web/appSessionProtocol.ts`, `src/web/appSessionEventMapper.ts` | This is the runtime-backed localhost WebSocket server: token/origin/host validation, `app.ready`, submit/abort/permission handling, and status broadcasts all start here. |
| Browser/server message contract | `src/web/appSessionProtocol.ts` | `web/src/appProtocol.ts`, `src/web/appSessionProtocol.test.ts` | Keep server and browser schemas aligned when changing event names, permission payload shape, or persisted permission-update schemas. |
| SDK-to-browser event mapping | `src/web/appSessionEventMapper.ts` | `src/app-runtime/sessionEvents.ts`, `src/web/appSessionEventMapper.test.ts` | Maps streamed SDK messages into append/replace/delta browser events and folds account diagnostics into system messages. |
| Browser app state and reducer | `web/src/appState.ts` | `web/src/appState.test.ts`, `web/src/appProtocol.ts` | `reduceAppServerMessage()` is the owner for connection state, pending permissions, abort state, goal snapshots, and streamed message assembly in the browser. |
| Browser chat surface | `web/src/App.tsx` | `web/src/components/MessageContent.tsx`, `web/src/hooks/useWebSocket.ts`, `web/src/appProtocol.ts` | `App.tsx` owns chat layout, submit gating, reconnect notices, and the browser permission panel, including edited JSON input plus selected persisted permission updates. `MessageContent.tsx` owns markdown/code rendering. |
| Browser transport client | `web/src/hooks/useWebSocket.ts` | `web/src/appProtocol.ts`, `web/src/App.tsx` | The browser always connects back to `/ws` on the current host and uses `VITE_CAT_CODE_WS_TOKEN` to set the required subprotocol. |
| Electron desktop startup, security, and observability | `app/main/main.ts` | `app/main/mainDecisions.ts`, `app/scripts/{dev,prepare-dev-electron}.ts`, `app/main/navigationPolicy.ts`, `app/main/{attachmentGate,replayBuffer,operationalLogSink,deliveryTraceSink,diagnosticsBundle}.ts` | Electron main applies the window/security baseline, owns fixed IPC handlers, starts one sidecar-backed session, gates/replays frames across renderer attachment and reload, and exposes host-level sidecar restart. It also owns private operational JSONL, delivery-trace persistence, and the allowlisted support-bundle export; raw sidecar stderr never enters those artifacts. `SIDECAR_RUNTIME_ARGS` keeps the unbundled Bun sidecar on the engine classifier feature; the dev launcher starts Vite, but main chooses that origin only when Electron reports an unpackaged app. |
| Desktop sidecar lifecycle | `app/supervisor/supervisor.ts` | `app/shared/framing.ts`, `app/shared/limits.ts`, `app/shared/protocol.ts` | The Electron-free supervisor owns the session-to-child registry, bounded Unix-socket path allocation, framed transport, restart/kill behavior, and sidecar status events. |
| Desktop engine boundary | `app/sidecar/index.ts`, `app/sidecar/sidecarServer.ts` | `app/sidecar/sessionController.ts`, `app/sidecar/initializeRuntime.ts`, `src/app-runtime/` | The Bun sidecar initializes the real runtime, constructs a QueryEngine-backed controller, strictly validates inbound allowlisted frames, reattaches only engine-minted permission updates, and raw-forwards cloneable, JSON-safe, secret-screened session events. |
| Desktop Agent Mode controls | `app/sidecar/agentModeDomain.ts` | `app/sidecar/sidecarServer.ts`, `app/shared/protocol.ts`, `app/main/main.ts`, `app/preload/preload.ts`, `app/renderer/src/AgentChrome.tsx` | The sidecar joins persisted Agent Mode state with live local-agent tasks for a redacted snapshot. Its allowlisted set verb switches only the sidecar process through `matchSessionMode()` and broadcasts a fresh snapshot. |
| Desktop permission mode | `app/sidecar/permissionDomain.ts` | `app/sidecar/sidecarServer.ts`, `app/shared/protocol.ts`, `app/renderer/src/{PermissionModeChip,PermissionPrompt}.tsx` | `permission.setMode` is sidecar-local, session-scoped vocabulary. The sidecar rejects unavailable Auto using live classifier facts and rejects bypass unless the trusted launch gate enabled it; renderer-supplied destinations or engine-shared-protocol expansion are not valid substitutes. |
| Desktop accounts and OAuth lifecycle | `app/sidecar/accountsDomain.ts` | `app/shared/protocol.ts`, `app/sidecar/sidecarServer.ts`, `app/renderer/src/AccountsPage.tsx`, `app/renderer/src/StartupSurfaces.tsx` | The renderer receives redacted Anthropic and Codex pool summaries, a non-secret `anthropicRouteAvailable` boolean (covers OAuth/API key/Bedrock/Vertex/Foundry), and non-secret OAuth progress. `account.login {provider}` selects the engine-owned Anthropic or Codex runner at the strict sidecar boundary. Anthropic login honors managed method/org policy, defers token installation until after the cancellation-generation check, and a pending callback rejects on cancel. Usage refresh uses the cached Codex endpoint without token refresh or completion use. |
| Desktop session actions and catalog writes | `app/sidecar/sessionActionsDomain.ts` | `app/shared/protocol.ts`, `app/sidecar/sidecarServer.ts`, `app/renderer/src/{sessionActions,SessionActionsMenu,SessionsPage,sessionsPageState}.ts*` | Rename, tag, plain-text export, and branch are fixed app-local verbs. Catalog-row rename/tag writes target the row’s live owning sidecar and apply only after its confirmation; closed/history rows remain non-writable. The sidecar invokes the engine’s title save, tag save, export renderer, and full-transcript fork; a branch writes a transcript but is not auto-opened because it has no host registry row. |
| Desktop worker stop control | `app/sidecar/taskControlDomain.ts` | `app/shared/protocol.ts`, `app/sidecar/sidecarServer.ts`, `app/renderer/src/tasksState.ts`, `app/renderer/src/TasksDialog.tsx` | The renderer can name a running task only. The sidecar re-resolves it in the session store and uses the engine's `stopTask`; the normal task and Agent Mode snapshots carry the resulting state change. |
| Desktop settings editors | `app/sidecar/settingsDomain.ts` | `app/shared/settingsEditable.ts`, `app/shared/protocol.ts`, `app/sidecar/sidecarServer.ts`, `app/renderer/src/settingsState.ts`, `app/renderer/src/SettingsEditors.tsx` | Editable values use a closed non-secret allowlist and the engine’s locked settings writer. The sidecar re-emits provenance and values after a successful write; session-scoped dynamic options include output styles and the engine’s current model-picker options. Choosing the reserved default-model entry removes the override rather than persisting a sentinel. |
| Desktop preload contract | `app/preload/preload.ts` | `app/preload/rendererIpcGuard.ts`, `app/shared/{protocol,deliveryTrace}.ts`, `app/main/main.ts` | The context-isolated preload exposes fixed submit, abort, permission, ping, restart, subscribe, renderer-ready, trace acknowledgement, renderer-fault, and local diagnostics actions. A byte/rate guard protects the fixed senders and there is no generic IPC channel API. |
| Desktop AskUserQuestion answers | `app/renderer/src/AskQuestionFlow.tsx`, `app/renderer/src/askQuestionState.ts` | `app/renderer/src/permissionState.ts`, `app/shared/protocol.ts`, `app/preload/preload.ts`, `app/main/main.ts`, `app/sidecar/sidecarServer.ts` | AskUserQuestion is rendered from the existing pending-permission queue, not a parallel store. The renderer sends only option indices plus bounded freeform text through a fixed IPC channel. The sidecar strictly validates the app-local frame, matches the engine-minted pending request, rebuilds labels from gated engine input, and resolves through the existing allow path; decline remains the normal permission deny response. |
| Desktop sessions catalog and history opening | `app/renderer/src/sessionsCatalogState.ts` | `app/main/sessionsCatalogRunner.ts`, `app/sidecar/sessionsCatalogWorker.ts`, `app/sidecar/sessionsCatalogCache.ts`, `app/main/{sessionsCatalogBaseline,openHistorySession}.ts`, `app/shared/{protocol,hostApi}.ts` | One main-supervised, serialized engine-graph worker emits the global catalog; failed runs retain the last good renderer snapshot and the worker best-effort cache remains the cold-launch baseline. A history-only row sends only its engine session ID: main validates it, resolves cache-derived cwd/title, deduplicates existing/in-flight desktop rows, and creates the engine resume. Missing catalog data or an empty cwd fails closed. |
| Desktop idle-engine parking | `app/main/idleParkDriver.ts` | `app/main/{main,mainDecisions}.ts`, `app/shared/{protocol,limits}.ts`, `app/sidecar/{sidecarServer,index}.ts`, `app/host/{host,registry}.ts`, `app/preload/preload.ts`, `app/renderer/src/{connectionState,composerState,tabStatus}.ts` | Main enforces the live-engine cap and idle TTL, then sends host-originated `app.park` frames, skipping the panes the renderer reports as on screen. The sidecar alone gates park on no active turn, permission, or task and exits with the dedicated parked code; host retains the tab as restorable. The renderer classifies that exit code into a non-terminal `'parked'` status, so a park paints no failure and the next submit restores. No renderer or preload path can originate a park. |
| Desktop restore preview cache | `app/main/transcriptCache.ts` | `app/main/main.ts`, `app/sidecar/transcriptRunFacts.ts`, `app/shared/hostApi.ts`, `app/preload/preload.ts`, `app/renderer/src/previewTranscriptState.ts` | A dead restorable session may be previewed without spawning a sidecar. The main process reads only bounded, versioned, secret-screened cache frames after the host’s `canPreview()` gate; renderer state merges the later live replay. The cache backfill reads the newest `system`/`run_facts` snapshot as a unit for the model, permission mode, effort, and actual context window; it falls back to legacy byproduct records for older transcripts. |
| Desktop renderer shell and session routing | `app/renderer/src/App.tsx`, `app/renderer/src/shellState.ts` | `app/renderer/src/TabBar.tsx`, `app/renderer/src/Sidebar.tsx`, `app/renderer/src/tabStatus.ts`, `app/renderer/src/sidebarState.ts`, `app/host/registry.ts` | `App` seeds the host roster, folds live host events without polling, and owns active selection plus create/close/restart/restore calls. Tabs retain arrival order; the sidebar projects the merged roster by real message-send time (then transcript activity or creation), never by attach/open time. Its per-workspace plus uses the host-side registry row rather than a renderer-authored path. |
| Desktop transcript, restore affordance, and picker state | `app/renderer/src/transcriptProjector.ts`, `app/renderer/src/previewTranscriptState.ts`, `app/renderer/src/slashCatalogState.ts` | `app/renderer/src/{TranscriptView,MetadataInspector,messageMetadata,ToolInspector}.ts*`, `app/renderer/src/connectionState.ts`, `app/renderer/src/rawMessageLog.ts`, `app/renderer/src/SlashCommandPicker.tsx` | Live and cached rows stay separate until replay takes over; `TranscriptView` distinguishes preview, resuming, and no-cache connection states, hosts the tool-output inspector, and projects task notifications plus persisted local-command output as system-side rows. Metadata joins task snapshots to engine-minted subagent records. The picker consumes the sidecar’s read-only rich slash-catalog snapshot, with names-only initialization as fallback. |
| Legacy REPL web relay | `src/web/WebSocketServer.ts` | `src/web/WebUIBus.ts`, `src/screens/REPL.tsx` | This older server relays REPL events and intentionally disables sending; do not confuse it with `AppSessionWebSocketServer.ts` when routing runtime-backed browser work. |

## Tests And Validation

| Change area | Command |
|---|---|
| Docs-only map sanity | `git diff --check -- docs/maps/web-app-runtime.md docs/maps/WORKSPACE_MAP.md docs/maps/build-release-testing.md` |
| App-runtime session seam | `bun test src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts src/app-runtime/createQueryEngineAppSession.test.ts src/app-runtime/createQueryEngineSessionController.test.ts src/app-runtime/AppSessionController.test.ts` |
| Multi-session process isolation probe | `bun test src/app-runtime/multiSessionIsolation.probe.test.ts` |
| Web-mode startup and transport | `bun test src/web/startRuntimeBackedWebMode.test.ts src/web/launchWebAppDevServer.test.ts src/web/AppSessionWebSocketServer.test.ts src/web/appSessionProtocol.test.ts src/web/appSessionEventMapper.test.ts` |
| Browser frontend | `bun run --cwd web test && bun run --cwd web build` |
| Desktop tests | `bun test app/` |
| Desktop shell/preload/renderer typecheck | `bun run --cwd app typecheck` |
| Desktop engine-sidecar typecheck | `bun run --cwd app typecheck:sidecar` |
| Desktop renderer build | `bun run --cwd app renderer:build` |
| Desktop hardening smoke | `bun run --cwd app test:hardening` |
| Desktop AskUserQuestion flow | `bun test app/renderer/src/AskQuestionFlow.test.tsx app/renderer/src/askQuestionState.test.ts app/sidecar/sidecarServer.test.ts app/main/mainSource.test.ts app/preload/preloadSource.test.ts` |
| Desktop action/control seams | `bun test app/sidecar/sessionActionsDomain.test.ts app/sidecar/taskControlDomain.test.ts app/sidecar/settingsDomain.test.ts app/renderer/src/sessionActionRuntimeState.test.ts app/renderer/src/TasksDialog.test.tsx app/renderer/src/SettingsEditors.test.tsx` |
| Desktop sessions catalog and history opening | `bun test app/main/openHistorySession.test.ts app/main/sessionsCatalogBaseline.test.ts app/sidecar/sessionsCatalogDomain.test.ts app/sidecar/sessionsCatalogCache.test.ts app/renderer/src/sessionsCatalogState.test.ts app/main/mainSource.test.ts` |
| Desktop catalog worker and idle parking | `bun test app/main/sessionsCatalogRunner.test.ts app/main/idleParkDriver.test.ts app/sidecar/sidecarServer.test.ts app/host/{host,registry}.test.ts` |

## Traps And Stale Assumptions

- `src/main.tsx --web` no longer uses `src/web/WebSocketServer.ts` for the
  browser chat path. Treat `WebSocketServer.ts` as the legacy REPL relay unless
  you are intentionally working on that older transport.
- The browser protocol exists in two places: `src/web/appSessionProtocol.ts`
  for server validation and `web/src/appProtocol.ts` for client typing.
- The desktop protocol snapshot in `app/shared/engine-types.snapshot.d.ts`
  isolates Electron/preload/renderer typechecking from the Bun engine graph.
  Keep it synchronized with the canonical source types it cites.
- `app/renderer/src/transcriptProjector.ts` is the renderer anti-corruption
  boundary for SDK messages. Keep its exhaustive switch and
  `sdkMessageFixtures.ts` coverage aligned when the SDK union grows.
- `app/renderer/src/shellState.ts` owns roster ordering, not active focus.
  `App.tsx` owns focus transitions so background frames and host events cannot
  silently steal the active pane.
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
  commands, clients, and resources for browser sessions. If startup data is
  missing only in web mode, inspect this seam before changing controller logic.
- `AppSessionController` and `AppSessionWebSocketServer` both guard active
  turns; concurrency fixes usually need both layers understood before changes.
- Separate `AppSessionController` instances do not isolate the process-global
  cwd and session ID used by `QueryEngine`. Re-run the isolation probe before
  designing a multi-session desktop host around one engine process.
- The root `bun run lint` script excludes `web/`. Use `bun run --cwd web
  typecheck` or `bun run --cwd web build` when browser code changes.
- The root lint configuration also does not cover `app/**`; use the desktop
  tests and both desktop typecheck boundaries for that tree.
- `askUserQuestion.answer` is deliberately app-local vocabulary, not part of
  the shared engine client-message schema. Never trust renderer option labels,
  question text, or a stale request ID: the sidecar must derive labels and
  semantics from the still-pending engine-gated request.
- Session action and task-stop messages are also app-local, closed vocabulary.
  Do not forward an arbitrary renderer operation to the engine: the sidecar must
  validate the exact verb and re-resolve its live session or task target.
- A branch creates an engine transcript, not an Electron-host session. Do not
  add auto-open behavior by treating its engine session id as an app-session id.
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
