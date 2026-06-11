# Dedicated App Runtime Contract Map

Created: 2026-06-06

## Purpose

This document maps Claude Design prototype surfaces to current Cat Code runtime
contracts. It exists to prevent the dedicated app from copying prototype mock
behavior where a real terminal or runtime semantic already exists.

## Current Runtime Owners

| Concern | Current owner | Current status |
|---|---|---|
| CLI `--web` startup | `src/main.tsx` | Starts `src/web/WebSocketServer.ts`, spawns Vite from `web/`, opens a browser, skips Ink REPL, and waits. |
| App session turn lifecycle | `src/app-runtime/AppSessionController.ts` | Runtime boundary exists and has focused tests. |
| App session event types | `src/app-runtime/sessionEvents.ts` | Events exist for message, goal, permissions, and abort. |
| QueryEngine-backed app session | `src/app-runtime/createQueryEngineAppSession.ts` and `src/app-runtime/createQueryEngineSessionController.ts` | Runtime adapter exists. QueryEngine assembly remains non-trivial. |
| Current browser relay | `src/web/WebSocketServer.ts` and `src/web/WebUIBus.ts` | Separate relay exists, but it does not expose the full app-runtime contract to `web/`. |
| Current browser UI | `web/src/App.tsx` | Minimal chat shell. Sending is intentionally disabled by current server status. |
| Current browser socket hook | `web/src/hooks/useWebSocket.ts` | Connects to `/ws`, receives `message`, `delta`, and `status`, and can send `user_input`. |
| Terminal session loop | `src/screens/REPL.tsx` | Terminal remains the primary production surface. Existing web proof-of-life wiring lives here, but `--web` does not reach REPL. |

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

## Current Web Events

`src/web/WebUIBus.ts` currently exposes a smaller browser relay contract:

- `message`
- `delta`
- `stream_mode`
- `tool_use`
- `status`

`src/web/WebSocketServer.ts` currently sends an initial status with
`inputEnabled: false` and a notice that browser input is disabled until the
backend path no longer depends on REPL wiring.

`web/src/hooks/useWebSocket.ts` currently types only `message`, `delta`, and
`status`, so `stream_mode` and `tool_use` are backend-emittable but not yet
frontend-handled in the browser app.

## Prototype Surface To Runtime Mapping

| Prototype surface | Current source evidence | Runtime contract | First-slice decision |
|---|---|---|---|
| Message list | `cat-app/Messages.jsx`, `cat-app/Chat.jsx` | `AppSessionEvent.type === "message"` | Implement in Phase 1. |
| Composer | `cat-app/Chat.jsx` | Needs submit path into `AppSessionController.submit()` | Implement basic single-session submit in Phase 1 only after transport design is explicit. |
| Goal chip and drawer | `cat-app/Surfaces.jsx`, `cat-app/AppV2.jsx` | `goal.snapshot` and `ThreadGoal` | Display in Phase 1; mutate actions later unless runtime API is present. |
| Permission queue/dialog | `cat-app/Surfaces.jsx`, `cat-app/AppV2.jsx` | `permission.requested` and `permission.resolved` | Implement in Phase 1 because safety blocks app viability. |
| Abort/stop state | `cat-app/Chat.jsx`, `cat-app/Surfaces.jsx` | `abort.status` plus controller `abort()` | Display in Phase 1; stop action can call controller only after transport is defined. |
| Connection chip | `cat-app/Surfaces.jsx` | Current web `status`, future app transport status | Display with current transport state in Phase 1. |
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

- `bun test src/app-runtime/*.test.ts` passed during planning.
- Current web type checking failed before migration work:
  - `web/src/App.tsx`: `data.message` possibly undefined.
  - `web/src/components/MessageContent.tsx`: `inline` prop typing mismatch.
- `AppSessionController` is not currently used by `src/web` or `src/main.tsx`.
- Browser permission response, abort, and app-runtime event handling are not
  currently implemented.
- `--web` starts the socket/Vite path before the normal `setup(...)`, commands,
  agents, MCP, permission mode, and state wiring are assembled for the REPL.
- `createQueryEngineAppSession.ts` should be audited before Phase 1 because its
  abort-controller lifecycle may affect later turns after an interrupt.
- `src/web/WebSocketServer.ts` currently uses a fixed port and has minimal
  browser-origin/auth hardening. Treat that as a Phase 1 risk.

## First Runtime Gap To Resolve After This Plan

The next implementation plan must decide whether Phase 1 connects `web/`
directly to `AppSessionController` through a new web transport adapter or
adapts `src/web/WebSocketServer.ts` to forward app-runtime events.

That Phase 1 plan must also define:

- The SDK-message mapper from raw app-runtime stream-json messages to browser UI
  state, including partial streaming behavior.
- The QueryEngine assembly strategy for app sessions outside the Ink REPL path.
- The permission request and response WebSocket protocol.
- The abort lifecycle for interrupted and later app turns.
- The transport security model for browser-originated prompts and permission
  decisions.
- Whether existing `stream_mode` and `tool_use` relay events are reused,
  replaced, or intentionally ignored.
- Whether preexisting web TypeScript failures are fixed inside Phase 1 or as a
  prep patch.

Those decisions belong in the Phase 1 runtime-backed single chat plan, not in
this docs-only normalization plan.
