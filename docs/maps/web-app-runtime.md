# App Runtime Routing Map

Last refreshed: 2026-07-05 against `src/main.tsx`, `src/app-runtime/`,
`src/bootstrap/state.ts`, `src/QueryEngine.ts`, `src/web/`,
`src/services/mcp/client.ts`, `web/`, `app/`, and related tests.

Use this map for the browser and Electron runtime-backed app-session paths.
It covers the active local app stacks, not older dedicated-app design docs or
the legacy REPL relay server.

## Start Here

1. `docs/maps/WORKSPACE_MAP.md`
2. `src/main.tsx` for `--web` startup wiring
3. `app/main/main.ts` for Electron startup, or
   `src/web/startRuntimeBackedWebMode.ts` for browser startup
4. The owner surface below that matches the behavior you are changing

## Routing Table

| Area | Inspect first | Then inspect | Routing notes |
|---|---|---|---|
| Web-mode startup path | `src/main.tsx` | `src/web/startRuntimeBackedWebMode.ts`, `src/web/launchWebAppDevServer.ts`, `web/package.json` | `main.tsx --web` now builds a runtime-backed app-session config, starts `AppSessionWebSocketServer`, launches Vite on `127.0.0.1`, and skips the Ink REPL. |
| Runtime-backed web-mode orchestrator | `src/web/startRuntimeBackedWebMode.ts` | `src/app-runtime/createRuntimeBackedWebAppSession.ts`, `src/web/AppSessionWebSocketServer.ts`, `src/web/launchWebAppDevServer.ts` | This helper owns runtime-backed `--web` startup order, token redaction in startup/cleanup errors, and coordinated shutdown of the browser server plus Vite child process. |
| QueryEngine app-session setup | `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts` | `src/services/mcp/client.ts`, `src/state/AppStateStore.ts`, `src/utils/fileStateCache.ts` | This config seam snapshots normal startup owners for runtime-backed app sessions, merges built-in plus MCP tools/commands, and clones prefetched MCP resources into app-state reads. |
| Runtime-backed app session seam | `src/app-runtime/createRuntimeBackedWebAppSession.ts` | `src/app-runtime/createQueryEngineAppSession.ts`, `src/app-runtime/createQueryEngineSessionController.ts`, `src/app-runtime/index.ts` | Use this seam when startup wiring needs a controller/session pair for the browser app. The QueryEngine-backed session and controller adapter live underneath it. |
| App session turn lifecycle | `src/app-runtime/AppSessionController.ts` | `src/app-runtime/sessionEvents.ts`, `src/services/api/accountDiagnostics.ts` | `AppSessionController` owns active-turn gating, abort state, goal snapshots, permission request handoff, and emission of session events/messages. |
| Multi-session process isolation | `src/app-runtime/multiSessionIsolation.probe.test.ts` | `src/bootstrap/state.ts`, `src/QueryEngine.ts`, `src/utils/Shell.ts` | The probe demonstrates that controller-local permission state is isolated, but concurrent sessions in one engine process share process-global cwd and session ID. Route desktop multi-session topology through this evidence before choosing one-process versus per-session processes. |
| Browser transport server | `src/web/AppSessionWebSocketServer.ts` | `src/web/appSessionProtocol.ts`, `src/web/appSessionEventMapper.ts` | This is the runtime-backed localhost WebSocket server: token/origin/host validation, `app.ready`, submit/abort/permission handling, and status broadcasts all start here. |
| Browser/server message contract | `src/web/appSessionProtocol.ts` | `web/src/appProtocol.ts`, `src/web/appSessionProtocol.test.ts` | Keep server and browser schemas aligned when changing event names, permission payload shape, or persisted permission-update schemas. |
| SDK-to-browser event mapping | `src/web/appSessionEventMapper.ts` | `src/app-runtime/sessionEvents.ts`, `src/web/appSessionEventMapper.test.ts` | Maps streamed SDK messages into append/replace/delta browser events and folds account diagnostics into system messages. |
| Browser app state and reducer | `web/src/appState.ts` | `web/src/appState.test.ts`, `web/src/appProtocol.ts` | `reduceAppServerMessage()` is the owner for connection state, pending permissions, abort state, goal snapshots, and streamed message assembly in the browser. |
| Browser chat surface | `web/src/App.tsx` | `web/src/components/MessageContent.tsx`, `web/src/hooks/useWebSocket.ts`, `web/src/appProtocol.ts` | `App.tsx` owns chat layout, submit gating, reconnect notices, and the browser permission panel, including edited JSON input plus selected persisted permission updates. `MessageContent.tsx` owns markdown/code rendering. |
| Browser transport client | `web/src/hooks/useWebSocket.ts` | `web/src/appProtocol.ts`, `web/src/App.tsx` | The browser always connects back to `/ws` on the current host and uses `VITE_CAT_CODE_WS_TOKEN` to set the required subprotocol. |
| Electron desktop startup and security | `app/main/main.ts` | `app/main/navigationPolicy.ts`, `app/main/attachmentGate.ts`, `app/main/replayBuffer.ts` | Electron main applies the window/security baseline, owns fixed IPC handlers, starts one sidecar-backed session, gates/replays frames across renderer attachment and reload, and exposes host-level sidecar restart. |
| Desktop sidecar lifecycle | `app/supervisor/supervisor.ts` | `app/shared/framing.ts`, `app/shared/limits.ts`, `app/shared/protocol.ts` | The Electron-free supervisor owns the session-to-child registry, bounded Unix-socket path allocation, framed transport, restart/kill behavior, and sidecar status events. |
| Desktop engine boundary | `app/sidecar/index.ts`, `app/sidecar/sidecarServer.ts` | `app/sidecar/sessionController.ts`, `app/sidecar/initializeRuntime.ts`, `src/app-runtime/` | The Bun sidecar initializes the real runtime, constructs a QueryEngine-backed controller, strictly validates inbound allowlisted frames, reattaches only engine-minted permission updates, and raw-forwards cloneable, JSON-safe, secret-screened session events. |
| Desktop preload contract | `app/preload/preload.ts` | `app/preload/rendererIpcGuard.ts`, `app/shared/protocol.ts`, `app/main/main.ts` | The context-isolated preload exposes fixed submit, abort, permission, ping, restart, subscribe, and renderer-ready operations; a byte/rate guard protects the fixed senders and there is no generic IPC channel API. |
| Desktop renderer shell and session routing | `app/renderer/src/App.tsx`, `app/renderer/src/shellState.ts` | `app/renderer/src/TabBar.tsx`, `app/renderer/src/Sidebar.tsx`, `app/renderer/src/tabStatus.ts`, `app/renderer/src/sidebarState.ts` | `App` seeds the session roster from `listSessions()`, folds live host events without polling, and owns active selection plus create/close/restart/restore calls. Tabs retain arrival order; the sidebar independently projects the same live/restorable roster by recency. Per-session connection, transcript, and permission stores remain resident while focus changes. |
| Desktop renderer transcript and permission state | `app/renderer/src/transcriptProjector.ts`, `app/renderer/src/permissionState.ts` | `app/renderer/src/TranscriptView.tsx`, `app/renderer/src/connectionState.ts`, `app/renderer/src/rawMessageLog.ts` | The renderer subscribes before signaling readiness and keeps session-keyed reducers for connection, permissions, bounded raw diagnostics, and projected transcript rows. The projector exhaustively dispatches the SDK message union; background permission counts feed tab attention without moving focus. |
| Legacy REPL web relay | `src/web/WebSocketServer.ts` | `src/web/WebUIBus.ts`, `src/screens/REPL.tsx` | This older server relays REPL events and intentionally disables sending; do not confuse it with `AppSessionWebSocketServer.ts` when routing runtime-backed browser work. |

## Validation

| Change area | Command |
|---|---|
| Docs-only map sanity | `git diff --check -- docs/maps/web-app-runtime.md docs/maps/WORKSPACE_MAP.md docs/maps/build-release-testing.md` |
| App-runtime session seam | `bun test src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts src/app-runtime/createQueryEngineAppSession.test.ts src/app-runtime/createQueryEngineSessionController.test.ts src/app-runtime/AppSessionController.test.ts` |
| Multi-session process isolation probe | `bun test src/app-runtime/multiSessionIsolation.probe.test.ts` |
| Web-mode startup and transport | `bun test src/web/startRuntimeBackedWebMode.test.ts src/web/launchWebAppDevServer.test.ts src/web/AppSessionWebSocketServer.test.ts src/web/appSessionProtocol.test.ts src/web/appSessionEventMapper.test.ts` |
| Browser frontend | `bun run --cwd web test && bun run --cwd web build` |
| Desktop tests | `bun test app/` |
| Desktop shell/preload/renderer typecheck | `bunx tsc --noEmit -p app/tsconfig.json` |
| Desktop engine-sidecar typecheck | `bun run --cwd app typecheck:sidecar` |
| Desktop renderer build | `bun run --cwd app renderer:build` |
| Desktop hardening smoke | `bun run --cwd app test:hardening` |

## Common Traps

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
- Desktop Electron main and the renderer must not import engine runtime modules.
  The Bun sidecar is the engine boundary; `app/supervisor/` must remain
  Electron-free.
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
