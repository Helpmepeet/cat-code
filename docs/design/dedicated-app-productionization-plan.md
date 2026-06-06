# Dedicated App Productionization Plan

## Status

Blocked on Claude Design export for visual matching.

This plan prepares the Cat Code workspace for Claude Design productionization without inventing the final UI.

## Phase 0: Design intake

Status: current phase.

Tasks:

- create `docs/design/claude-design/`
- place Claude Design files there after export
- capture screenshots
- capture original prompts
- capture handoff bundle, if available
- document what must stay visually close
- document what can change for maintainability

## Phase 1: Production UI foundation

Tasks after export:

- extract design tokens from Claude Design
- normalize colors, spacing, radius, shadows, and typography
- split shell into reusable components
- keep UI implementation under `src/dedicated-app/`
- keep app-facing state/contracts under `src/app-runtime/`
- use placeholder/mock state only
- preserve runtime honesty
- preserve local-first assumptions

## Phase 2: State contract cleanup

Tasks:

- review `src/app-runtime/dedicatedAppState.ts`
- decide which placeholder types should become durable app-facing types
- separate placeholder-only data from future runtime-backed state
- document state model in `dedicated-app-api-contract.md`
- avoid React imports in `src/app-runtime/`

## Phase 3: Visual productionization

Tasks after export:

- rebuild Claude Design visual direction using production components
- avoid direct HTML paste
- centralize tokens
- remove duplicated inline styles where appropriate
- preserve current dedicated app validation
- document visual mismatches
- keep `runtime.actionsReady` respected
- keep placeholder controller actions inert until real integration

## Phase 4: Runtime integration later

Out of scope for now:

- real sessions
- real QueryEngine turns
- live permission events
- file diffs from real workspace
- agent/worker lifecycle
- account/provider state
- settings mutation
- shell command execution from browser
- filesystem writes from browser

## Validation

Use these commands for dedicated-app work:

```bash
bun run validate:dedicated-app
bun run build:dedicated-app
bun run serve:dedicated-app
```

Only run broader build/test commands if the touched files justify it.

## Non-goals

This productionization plan does not include:

* a new root `web/` app
* a full terminal-to-web rewrite
* replacement of `src/screens/REPL.tsx`
* real runtime connection
* real background task queue
* auth/account mutation
* provider setting mutation
