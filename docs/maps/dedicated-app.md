# Dedicated App Routing Map

Last refreshed: 2026-05-12 against `src/app-runtime/`,
`src/dedicated-app/`, `scripts/validate-dedicated-app.ts`,
`package.json`, and `docs/agent/2026-05-03-dedicated-app-groundtruth.md`.

Use this as the daily-refreshable routing layer for dedicated app work. It is
not the source of truth for exact behavior; after using this map to choose the
owner file, verify the current implementation before changing code.

## Refresh Checklist

Run this quick pass before relying on the map:

- Read `docs/maps/WORKSPACE_MAP.md`.
- Re-open `docs/agent/2026-05-03-dedicated-app-groundtruth.md` for current
  phase scope and non-negotiables.
- Inspect `src/app-runtime/` before `src/dedicated-app/` for shared session,
  permission, goal, and event behavior.
- Inspect `src/dedicated-app/` only after confirming whether the change is shell
  presentation or host wiring.
- Check `package.json` dedicated-app scripts and
  `scripts/validate-dedicated-app.ts` before marking boundary work complete.
- Search docs for stale root `web/` assumptions when a plan says "web app",
  "Vite", or "browser UI".

## Boundary Rule

Dedicated app runtime work belongs in `src/app-runtime/`. Browser/app shell and
Bun host wiring belong in `src/dedicated-app/`.

Do not route dedicated app replacement work to root `web/`, Ink components, or
`src/screens/REPL.tsx` unless the task is explicitly about compatibility,
extracting shared behavior out of the terminal shell, or documenting stale
assumptions.

## Routing Table

| Concern | Start here | Then inspect | Routing decision |
|---|---|---|---|
| Shared app-facing runtime contract | `src/app-runtime/index.ts` | `src/app-runtime/AppSessionController.ts`, `src/app-runtime/sessionEvents.ts` | Runtime exports are centralized from `index.ts`. Keep reusable session/control behavior here, not in the shell. |
| Session turn orchestration | `src/app-runtime/AppSessionController.ts` | `src/app-runtime/AppSessionController.test.ts` | Owns submit lifecycle, event subscription, active-turn guard, goal snapshots, pending permissions, and abort state. |
| QueryEngine app session bridge | `src/app-runtime/createQueryEngineAppSession.ts` | `src/app-runtime/createQueryEngineSessionController.ts`, `src/app-runtime/createQueryEngineSessionController.test.ts`, `src/QueryEngine.ts` | `createQueryEngineAppSession()` wraps `QueryEngine` with an app permission bridge. `createQueryEngineSessionController()` adapts a QueryEngine-like session into `AppSessionController`. |
| App event payloads | `src/app-runtime/sessionEvents.ts` | `src/app-runtime/sessionEvents.test.ts`, `src/entrypoints/agentSdkTypes.ts` | Current app-facing events are `message`, `goal.snapshot`, `permission.requested`, `permission.resolved`, and `abort.status`. Messages preserve SDK payloads. |
| Permission bridge | `src/app-runtime/appRuntimeCanUseTool.ts` | `src/app-runtime/appRuntimeCanUseTool.test.ts`, `src/hooks/useCanUseTool.tsx`, `src/utils/permissions/permissions.ts` | App runtime keeps existing permission policy by delegating to `baseCanUseTool`; only `ask` decisions become app permission requests when a handler is active. |
| Placeholder runtime state shape | `src/app-runtime/dedicatedAppState.ts` | `src/dedicated-app/placeholderState.ts` | Types for placeholder workspace, sessions, panels, permissions, goal, runtime, agents, accounts, and settings live in runtime because the shell consumes that state contract. |
| Placeholder state values and inert actions | `src/dedicated-app/placeholderState.ts` | `src/dedicated-app/DedicatedAppShell.tsx`, `src/dedicated-app/renderDocument.ts` | Placeholder values and no-op controller methods are shell scaffolding. Do not treat them as backend capability. |
| React shell presentation | `src/dedicated-app/DedicatedAppShell.tsx` | `src/app-runtime/dedicatedAppState.ts` | This is the thin React shell scaffold. It should render state and call controller actions, not own runtime behavior. |
| Static document render | `src/dedicated-app/renderDocument.ts` | `src/dedicated-app/host.ts` | Produces a server-rendered placeholder HTML document from runtime state. Keep it shell/host oriented. |
| Bun host and routes | `src/dedicated-app/host.ts` | `src/dedicated-app/placeholderState.ts`, `src/dedicated-app/renderDocument.ts` | Serves `/` or `/index.html` as HTML and `/state.json` as placeholder JSON. Default host is `127.0.0.1`; default port is `3457`; env overrides are `CAT_CODE_DEDICATED_APP_HOST` and `CAT_CODE_DEDICATED_APP_PORT`. |
| Shell entry exports | `src/dedicated-app/index.ts` | `src/dedicated-app/host.ts`, `src/dedicated-app/DedicatedAppShell.tsx` | Re-exports shell and runtime state types for bundling. Do not add runtime logic here. |
| Build, serve, and validate scripts | `package.json` | `scripts/validate-dedicated-app.ts` | Current scripts are `validate:dedicated-app`, `build:dedicated-app`, and `serve:dedicated-app`. Build bundles `src/dedicated-app/index.ts` for browser and `src/dedicated-app/host.ts` for Bun into `dist/dedicated-app`. |
| Boundary validation | `scripts/validate-dedicated-app.ts` | `src/app-runtime/`, `src/dedicated-app/` | Validator requires both source areas to exist and checks TypeScript imports. `src/app-runtime` must not import React, Ink, screens, terminal components, or `web`; `src/dedicated-app` may import React but not Ink, screens, terminal components, or `web`. |
| Terminal compatibility shell | `src/screens/REPL.tsx` | `src/components/`, `src/replLauncher.tsx`, `src/main.tsx` | REPL remains the current terminal shell and compatibility hub. Do not make it the dedicated app shell; extract shared behavior into `src/app-runtime/` first. |
| Stale root web assumptions | `docs/agent/2026-05-03-dedicated-app-groundtruth.md` | `docs/superpowers/plans/2026-05-03-dedicated-app-cat-swarm-task.md`, `docs/plans/2026-04-30-ui-web-ui-plan.md`, `docs/maps/WORKSPACE_MAP.md` | Root `web/` is historical/browser debug or bridge work, not the dedicated app replacement target. A plan that only expands `web/` does not satisfy dedicated app runtime work. |

## QueryEngine Bridge Notes

`createQueryEngineAppSession()` is the current app-runtime entrypoint for real
turns. It constructs `QueryEngine` with an abort controller and a wrapped
`canUseTool` function. During `submitMessage()`, it installs the active app
permission handler, yields QueryEngine SDK messages, and clears the handler when
the turn finishes.

`createQueryEngineSessionController()` is the controller bridge. It adapts any
QueryEngine-like object with `submitMessage()` into `AppSessionController`, so
tests and future shells can exercise the app runtime without importing terminal
UI.

## Permission Notes

Permission behavior is a bridge, not a new policy engine.

- `allow` and `deny` decisions from the existing policy path pass through.
- `ask` decisions become `permission.requested` events only when an app
  permission handler exists.
- If no app handler is active, `ask` is returned unchanged so existing callers
  can still handle it.
- App responses are normalized back into the existing permission decision shape,
  preserving `updatedInput` and `toolUseID`.
- Abort denies pending permission requests with the abort reason and emits abort
  status updates.

## Placeholder State Notes

The dedicated app shell currently renders placeholder state. Treat these as
scaffold-only surfaces:

- `boundaryPhase: "placeholder"` means the shell is not claiming a live backend.
- `runtime.actionsReady: false` disables shell actions.
- Placeholder sessions, agents, accounts, settings, permissions, and workspace
  items describe intended UI lanes, not completed runtime integration.
- The placeholder controller methods are intentionally no-ops.

## Validation Commands

Use these for the current boundary:

```bash
bun run validate:dedicated-app
bun run build:dedicated-app
bun run serve:dedicated-app
bun test src/app-runtime/sessionEvents.test.ts src/app-runtime/AppSessionController.test.ts src/app-runtime/createQueryEngineSessionController.test.ts src/app-runtime/appRuntimeCanUseTool.test.ts
```

`serve:dedicated-app` starts the Bun host from source. `build:dedicated-app`
writes browser and Bun bundles to `dist/dedicated-app`. Validation should pass
before treating the runtime/shell boundary as intact.

## Root Web Warning

Root `web/` can still appear in older UI plans and code comments. For dedicated
app replacement work, it is stale routing unless a task explicitly says it is
using `web/` as historical reference or bridge code.

Current dedicated app routing is:

1. `src/app-runtime/` for shared runtime behavior.
2. `src/dedicated-app/` for shell, placeholder document rendering, and Bun host.
3. `scripts/validate-dedicated-app.ts` and package scripts for boundary checks.
4. Existing terminal surfaces only when preserving compatibility or extracting
   behavior out of the terminal shell.
