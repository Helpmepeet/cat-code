# Dedicated App Runtime Contract Map

Created: 2026-06-06

## Purpose

This document maps Claude Design prototype surfaces to current Cat Code runtime
contracts. It exists to prevent the dedicated app from copying prototype mock
behavior where a real terminal or runtime semantic already exists.

## Current Runtime Owners

| Concern | Current owner | Current status |
|---|---|---|
| CLI `--web` startup | `src/main.tsx` and `src/web/startRuntimeBackedWebMode.ts` | Runs normal setup, builds a `QueryEngineAppSessionConfig`, starts the runtime-backed app-session WebSocket server, launches Vite from `web/`, opens a browser, skips Ink REPL only after web startup succeeds, and waits. |
| App session turn lifecycle | `src/app-runtime/AppSessionController.ts` | Runtime boundary exists and has focused tests. |
| App session event types | `src/app-runtime/sessionEvents.ts` | Events exist for message, goal, permissions, and abort. |
| QueryEngine-backed app session | `src/app-runtime/createQueryEngineAppSession.ts`, `src/app-runtime/createQueryEngineSessionController.ts`, and `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts` | Runtime adapter exists and normal startup config is extracted for browser sessions. |
| Runtime-backed browser transport | `src/web/AppSessionWebSocketServer.ts`, `src/web/appSessionProtocol.ts`, and `src/web/appSessionEventMapper.ts` | Localhost WebSocket server exposes the app-runtime contract to `web/`, including submit, abort, permissions, goal snapshots, and ready-state replay. |
| Legacy browser relay | `src/web/WebSocketServer.ts` and `src/web/WebUIBus.ts` | Legacy REPL relay remains for compatibility and sends a notice that it does not accept browser submissions. |
| Current browser UI | `web/src/App.tsx` | Single-session chat shell that submits prompts, renders runtime messages, shows connection/goal/abort status, and handles permission requests. |
| Current browser socket hook | `web/src/hooks/useWebSocket.ts` | Connects to `/ws` with the runtime token subprotocol, receives app-session envelopes, and sends app-session client messages. |
| Terminal session loop | `src/screens/REPL.tsx` | Terminal remains the primary production surface for non-web sessions. Runtime-backed `--web` skips the Ink REPL. |

## App Runtime Events

`src/app-runtime/sessionEvents.ts` currently exposes:

- `message`: wraps an SDK stream-json message.
- `goal.snapshot`: carries `ThreadGoal | null`.
- `permission.requested`: carries a request id and SDK permission request.
- `permission.resolved`: carries the original request plus allow or deny
  response.
- `abort.status`: carries idle, requested, or aborted state.

These are the first events the dedicated app should consume directly or through
a thin web transport adapter.

## Web Events

`src/web/appSessionProtocol.ts` is the browser app contract. The server sends:

- `app.ready`
- `app.event`
- `app.ack`
- `app.error`
- `app.pong`

`app.event` wraps the app-facing browser events for message append/replace/delta,
status updates, goal snapshots, permission request/resolution, and abort status.

`src/web/WebUIBus.ts` still exposes the older `message`, `delta`,
`stream_mode`, `tool_use`, and `status` relay events for legacy REPL-web
integration. Do not use it for new runtime-backed browser work.

## Prototype Surface To Runtime Mapping

| Prototype surface | Current source evidence | Runtime contract | First-slice decision |
|---|---|---|---|
| Message list | `cat-app/Messages.jsx`, `cat-app/Chat.jsx` | `AppSessionEvent.type === "message"` mapped through `appSessionEventMapper.ts` | Implemented for basic user/assistant/system text messages. |
| Composer | `cat-app/Chat.jsx` | `app.submit` into `AppSessionController.submit()` | Implemented for one runtime-backed session. |
| Goal chip and drawer | `cat-app/Surfaces.jsx`, `cat-app/AppV2.jsx` | `goal.snapshot` and `ThreadGoal` | Goal status/objective display implemented; mutation actions remain later. |
| Permission queue/dialog | `cat-app/Surfaces.jsx`, `cat-app/AppV2.jsx` | `permission.requested` and `permission.resolved` | Implemented in the single-session browser panel. |
| Abort/stop state | `cat-app/Chat.jsx`, `cat-app/Surfaces.jsx` | `abort.status` plus controller `abort()` | Stop action and abort status display implemented. |
| Connection chip | `cat-app/Surfaces.jsx` | Runtime-backed app-session ready/status events | Displayed with current transport state in Phase 1. |
| Account chip | `cat-app/Surfaces.jsx`, `cat-app/Pages.jsx` | Account pool and auth modules, not app-runtime events yet | Defer until account contract is defined. |
| Model/effort controls | `cat-app/Surfaces.jsx`, `cat-app/menu-variants.jsx` | Settings/model runtime surfaces | Defer mutation controls. Read-only display may be allowed if already in status. |
| Session sidebar | `cat-app/Sidebar.jsx`, `cat-app/Pages.jsx` | `src/utils/sessionStorage.ts`, optimized list sessions path | Phase 3. |
| Tool cards and diffs | `cat-app/Messages.jsx` | SDK messages and tool result normalization | Phase 4 after message rendering is real. |
| Agents/tasks pages | `cat-app/Pages.jsx` | `src/tasks/`, `src/agent-mode/`, task UI components | Phase 5. |
| Accounts page | `cat-app/Pages.jsx` | Auth/account pool/cost surfaces | Phase 5. |
| Settings page | `cat-app/Pages.jsx` | `src/utils/settings/`, commands, permission config | Phase 5. |

## Runtime Preservation Requirements

- Permission decisions must preserve allow, deny, ask, always-allow,
  classifier, sandbox, network, worker identity, and reconnect semantics.
- Goal completion must remain runtime/model-owned, not user toggled.
- Session persistence must keep JSONL transcript storage semantics.
- Tool states must distinguish input, output, error, cancelled, denied, and
  truncated.
- The terminal remains a compatibility and emergency surface until the app can
  handle the core work loop.

## Known Readiness Findings

- Runtime-backed browser tests cover protocol validation, event mapping,
  WebSocket origin/token handling, permission replay, abort, and startup
  orchestration.
- `web` typecheck and build are part of the Phase 1 verification surface.
- `createQueryEngineAppSession.ts` has focused runtime tests, but richer tool
  rendering and session navigation remain future phases.
- `src/web/WebSocketServer.ts` is legacy; runtime-backed work should use
  `src/web/AppSessionWebSocketServer.ts`.

## First Runtime Gap To Resolve After This Plan

Phase 1 resolved the transport direction by adding a runtime-backed app-session
server rather than extending the legacy REPL relay. The next gaps are richer
message/tool rendering, same-project session navigation, and broader dedicated
app surfaces from later phases.
