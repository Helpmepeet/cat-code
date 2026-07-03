# P1-1 Connection Handshake Design

**Date:** 2026-07-03

## Goal

Launch the Electron app, attach its single Unix-socket IPC session to a real
`AppSessionController` backed by a real `QueryEngine`, and render `ready` only
after the renderer receives the controller-derived `app.ready` handshake. P1-1
does not submit a prompt or render transcript data.

## Source Contract

The canonical handshake remains
`src/web/AppSessionWebSocketServer.ts:79-87`:

```ts
{
  type: 'app.ready',
  protocolVersion: 1,
  inputEnabled: !activeTurn,
  activeTurn,
  abort: controller.getAbortState(),
  goalSnapshot: controller.getGoalSnapshot(),
  pendingPermissionRequests: controller.getPendingPermissionRequests(),
}
```

IPC keeps the scaffold's transport envelope (`kind`, `protocolVersion`, and
`sessionId`), but its `payload` is the exact object above. The desktop protocol
snapshot will be synchronized with the source shape by adding the
`type: 'app.ready'` discriminant.

## Sidecar and Controller

Production sidecar startup will use `createRuntimeBackedWebAppSession`, which
constructs `createQueryEngineAppSession` and therefore a real `QueryEngine`
behind the real `AppSessionController`. Its minimal configuration uses the
hardcoded repository cwd `/Users/pt/cat-code`, an in-memory app-state store and
file cache, and empty tool, command, MCP, and agent collections. These empty
collections are sufficient because P1-1 starts a session but never runs a turn.

The P1-0 probe path may remain available only when the explicit
`CATCODE_SIDECAR_PROBE=1` test environment flag is supplied. Electron's normal
startup will no longer set that flag, so the launched app always uses the real
engine session and emits no fixture message.

On socket attachment, `SidecarServer` reads all session state directly from the
controller and sends the canonical handshake as the ready-frame payload. It
does not hardcode abort, goal, permission, or turn state.

## Renderer

The renderer subscribes before signaling `rendererReady`, preserving the P1-0
attachment/replay contract. Its complete visible output is one connection-state
string:

- `connecting` before a canonical ready payload arrives.
- `ready` after a frame whose `kind` is `ready` and whose
  `payload.type` is `app.ready` arrives.

Probe diagnostics, raw frame dumps, headings, and tool-use status are removed.

## Failure Behavior

Malformed or unrelated frames do not transition the renderer to `ready`.
Existing framing, secret scanning, replay buffering, process supervision, and
sidecar error behavior remain unchanged. New disconnected/error UI is outside
P1-1.

## Testing and Verification

The change follows test-first development:

1. Strengthen the sidecar unit test to require the canonical payload shape and
   controller-derived initial values; observe it fail because `type` is absent.
2. Strengthen the real sidecar/supervisor Unix-socket probe to run without the
   P1-0 fixture flag and assert every observed handshake field.
3. Extract or expose the renderer's ready-state predicate and test that only the
   canonical real payload changes the displayed state.
4. Implement the minimal protocol, sidecar, main-process, and renderer changes.
5. Run the focused tests, all `app/` tests, both app typechecks, renderer build,
   the repository-required `bun run build:dev:full`, and an Electron smoke that
   records the real handshake fields.

P1-1 is complete only when the launch smoke observes the canonical payload from
the production real-controller path and the renderer displays `ready` from that
payload.
