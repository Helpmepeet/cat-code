# Web App Runtime Routing Map

Last refreshed: 2026-06-08 against `src/main.tsx`, `src/app-runtime/`,
`src/web/`, `src/services/mcp/client.ts`, `web/src/`, `web/package.json`, and
related tests.

Use this map for the browser chat/runtime-backed app session path. It covers
the current local web app stack, not the older dedicated-app design docs or the
legacy REPL relay server.

## Start Here

1. `docs/maps/WORKSPACE_MAP.md`
2. `src/main.tsx` for `--web` startup wiring
3. `src/web/startRuntimeBackedWebMode.ts` for the runtime-backed startup helper
4. The owner surface below that matches the behavior you are changing

## Routing Table

| Area | Inspect first | Then inspect | Routing notes |
|---|---|---|---|
| Web-mode startup path | `src/main.tsx` | `src/web/startRuntimeBackedWebMode.ts`, `src/web/launchWebAppDevServer.ts`, `web/package.json` | `main.tsx --web` now builds a runtime-backed app-session config, starts `AppSessionWebSocketServer`, launches Vite on `127.0.0.1`, and skips the Ink REPL. |
| Runtime-backed web-mode orchestrator | `src/web/startRuntimeBackedWebMode.ts` | `src/app-runtime/createRuntimeBackedWebAppSession.ts`, `src/web/AppSessionWebSocketServer.ts`, `src/web/launchWebAppDevServer.ts` | This helper owns runtime-backed `--web` startup order, token redaction in startup/cleanup errors, and coordinated shutdown of the browser server plus Vite child process. |
| QueryEngine app-session setup | `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts` | `src/services/mcp/client.ts`, `src/state/AppStateStore.ts`, `src/utils/fileStateCache.ts` | This config seam snapshots normal startup owners for browser sessions, merges built-in plus MCP tools/commands, and clones prefetched MCP resources into app-state reads. |
| Runtime-backed app session seam | `src/app-runtime/createRuntimeBackedWebAppSession.ts` | `src/app-runtime/createQueryEngineAppSession.ts`, `src/app-runtime/createQueryEngineSessionController.ts`, `src/app-runtime/index.ts` | Use this seam when startup wiring needs a controller/session pair for the browser app. The QueryEngine-backed session and controller adapter live underneath it. |
| App session turn lifecycle | `src/app-runtime/AppSessionController.ts` | `src/app-runtime/sessionEvents.ts`, `src/services/api/accountDiagnostics.ts` | `AppSessionController` owns active-turn gating, abort state, goal snapshots, permission request handoff, and emission of session events/messages. |
| Browser transport server | `src/web/AppSessionWebSocketServer.ts` | `src/web/appSessionProtocol.ts`, `src/web/appSessionEventMapper.ts` | This is the runtime-backed localhost WebSocket server: token/origin/host validation, `app.ready`, submit/abort/permission handling, and status broadcasts all start here. |
| Browser/server message contract | `src/web/appSessionProtocol.ts` | `web/src/appProtocol.ts`, `src/web/appSessionProtocol.test.ts` | Keep server and browser schemas aligned when changing event names, permission payload shape, or persisted permission-update schemas. |
| SDK-to-browser event mapping | `src/web/appSessionEventMapper.ts` | `src/app-runtime/sessionEvents.ts`, `src/web/appSessionEventMapper.test.ts` | Maps streamed SDK messages into append/replace/delta browser events and folds account diagnostics into system messages. |
| Browser app state and reducer | `web/src/appState.ts` | `web/src/appState.test.ts`, `web/src/appProtocol.ts` | `reduceAppServerMessage()` is the owner for connection state, pending permissions, abort state, goal snapshots, and streamed message assembly in the browser. |
| Browser chat surface | `web/src/App.tsx` | `web/src/components/MessageContent.tsx`, `web/src/hooks/useWebSocket.ts`, `web/src/appProtocol.ts` | `App.tsx` owns chat layout, submit gating, reconnect notices, and the browser permission panel, including edited JSON input plus selected persisted permission updates. `MessageContent.tsx` owns markdown/code rendering. |
| Browser transport client | `web/src/hooks/useWebSocket.ts` | `web/src/appProtocol.ts`, `web/src/App.tsx` | The browser always connects back to `/ws` on the current host and uses `VITE_CAT_CODE_WS_TOKEN` to set the required subprotocol. |
| Legacy REPL web relay | `src/web/WebSocketServer.ts` | `src/web/WebUIBus.ts`, `src/screens/REPL.tsx` | This older server relays REPL events and intentionally disables sending; do not confuse it with `AppSessionWebSocketServer.ts` when routing runtime-backed browser work. |

## Validation

| Change area | Command |
|---|---|
| Docs-only map sanity | `git diff --check -- docs/maps/web-app-runtime.md docs/maps/WORKSPACE_MAP.md docs/maps/build-release-testing.md` |
| Auto-map keyword routing | `bun test src/utils/processUserInput/subsystemMapContext.test.ts` |
| App-runtime session seam | `bun test src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts src/app-runtime/createQueryEngineAppSession.test.ts src/app-runtime/createQueryEngineSessionController.test.ts src/app-runtime/AppSessionController.test.ts` |
| Web-mode startup and transport | `bun test src/web/startRuntimeBackedWebMode.test.ts src/web/launchWebAppDevServer.test.ts src/web/AppSessionWebSocketServer.test.ts src/web/appSessionProtocol.test.ts src/web/appSessionEventMapper.test.ts` |
| Browser frontend | `bun run --cwd web test && bun run --cwd web build` |

## Common Traps

- `src/main.tsx --web` no longer uses `src/web/WebSocketServer.ts` for the
  browser chat path. Treat `WebSocketServer.ts` as the legacy REPL relay unless
  you are intentionally working on that older transport.
- The browser protocol exists in two places: `src/web/appSessionProtocol.ts`
  for server validation and `web/src/appProtocol.ts` for client typing.
- `createQueryEngineAppSessionConfigFromSetup.ts` snapshots MCP tools,
  commands, clients, and resources for browser sessions. If startup data is
  missing only in web mode, inspect this seam before changing controller logic.
- `AppSessionController` and `AppSessionWebSocketServer` both guard active
  turns; concurrency fixes usually need both layers understood before changes.
- The root `bun run lint` script excludes `web/`. Use `bun run --cwd web
  typecheck` or `bun run --cwd web build` when browser code changes.
