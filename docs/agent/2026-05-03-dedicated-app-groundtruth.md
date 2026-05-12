# Dedicated App Replacement Ground Truth

**Status:** Living roadmap
**Created:** 2026-05-03
**Owner:** Cat Code agent/app migration work

This document is the ground truth for replacing the terminal-first Cat Code UI
with a dedicated app. Keep it updated as decisions change. Detailed execution
plans can live under `docs/superpowers/plans/`, but this file should remain the
stable map of phases, scope, and completion criteria.

## Prototype Reference

There is an existing HTML/React prototype at:

```text
/Users/pt/Downloads/catcode_prototype.zip
```

The durable design brief derived from that prototype is:

```text
docs/design/2026-05-03-dedicated-app-prototype-brief.md
```

The prototype is not complete and does not define final behavior, but it is the
current design and product-direction reference for the dedicated app. Use it to
understand the intended app shape, density, theme, and navigation model before
building new app UI. Do not treat prototype-only mock data as proof that backend
support already exists.

Prototype files inspected:

- `CatCode Web App v2.html`
- `CatCode Web App.html`
- `cat-app/AppV2.jsx`
- `cat-app/WorkspaceLayout.jsx`
- `cat-app/Sidebar.jsx`
- `cat-app/Chat.jsx`
- `cat-app/Messages.jsx`
- `cat-app/Pages.jsx`
- `cat-app/data.js`
- `screenshots/*.png`

If this roadmap becomes long-lived across machines, copy the prototype or a
curated screenshot/design brief into `docs/design/` so the reference is not only
stored in a local Downloads folder.

## Goal

Replace the terminal as the primary Cat Code interface with a dedicated app while
preserving the existing agent runtime, provider routing, tools, permissions,
session transcripts, `/goal`, Agent Mode, and local-first server-Mac direction.

The terminal may remain as a compatibility surface, but it should no longer be
the architectural center of the product.

## Current Reality

- Cat Code is still primarily a terminal coding agent.
- The process starts in `src/entrypoints/cli.tsx`, assembles runtime state in
  `src/main.tsx`, and renders the terminal UI through `src/replLauncher.tsx`.
- `src/screens/REPL.tsx` is the current operational hub. It owns UI rendering,
  prompt input, command dispatch, streaming display, permissions, queues,
  session lifecycle, remote/direct-connect mode, and goal continuation.
- `src/QueryEngine.ts` owns the turn-level agent/model/tool loop and is the most
  important runtime surface to preserve.
- `src/codex-core/` proves a smaller request path can be extracted, but it is
  intentionally too small for the dedicated app because it excludes tools,
  permissions, slash commands, transcripts, and full agent behavior.
- `/goal` already exists as both a slash command and model tools. The app must
  treat it as first-class product state, not terminal-only status text.

## Non-Negotiables

- Keep existing terminal sessions working until the dedicated app is usable for
  normal daily work.
- Do not rewrite provider routing as part of the UI migration.
- Do not replace `QueryEngine` until there is a proven app-facing runtime around
  it.
- Do not make the dedicated app import Ink or `src/screens/REPL.tsx`.
- Do not treat the existing `web/` Vite browser UI as the dedicated app. It may
  be reference or temporary bridge code, but the product goal is a real
  dedicated app path and a runtime refactor, not a webapp reskin.
- Preserve transcript compatibility and resume behavior.
- Preserve permission safety semantics. Changing the UI must not silently allow
  tools that previously required confirmation.
- Preserve `/goal` semantics: explicit goal creation, budget accounting,
  continuation, pausing, clearing, and completion evidence.

## Desired End State

The dedicated app is the primary control surface for Cat Code:

- Start and resume sessions.
- Send prompts and attachments.
- Stream assistant output and reasoning summaries.
- Show tool calls, tool results, diffs, commands, and progress.
- Request and answer permissions.
- Show and control the active `/goal`.
- Show Agent Mode workers and their status.
- Browse transcripts and resume previous work.
- Connect to the server-Mac runtime over a local/private transport.
- Keep working even if the control surface disconnects.

The app should feel like the prototype: a dense, local-first agent workspace,
not a terminal transcript embedded in a browser. The core workspace should
support session navigation, multiple open chats, split/resizable chat panels,
tool cards, permission modals, context/usage visibility, Agent Mode visibility,
and accounts/settings surfaces.

The terminal remains useful for scripts, emergency access, and compatibility,
but it is a client of the runtime rather than the runtime owner.

## Design Direction From Prototype

**Product shape:**

- Fixed left sidebar with Cat Code identity, session search, workspace-grouped
  sessions, and navigation for Chat, Agents, Accounts, and Settings.
- Top tab bar for multiple open chats.
- Main workspace with one to three resizable chat panels.
- Drag/drop or explicit controls to move sessions into split panels.
- Chat surface with assistant/user messages, thinking blocks, tool cards,
  diffs, command output, and sticky prompt input.
- Command palette for sessions and slash commands.
- Permission modal with allow, deny, and always-allow choices.
- Context/session usage gauge near the input, with expanded model/profile
  details.
- Agent page for running/completed workers and kill/control actions.
- Accounts/usage page for token charts, profile/account breakdown, cache usage,
  and rate-limit status.

**Visual language:**

- Dark zinc/black base surfaces, low-contrast borders, and compact spacing.
- Primary accent is pink (`#f472b6`), with blue, green, and purple variants for
  status or user-selectable accents.
- Status colors should remain explicit: green for success, yellow for warning,
  red for error/destructive, and pink for active agent/generation state.
- UI should be compact and app-like: small labels, dense rows, restrained
  radius, subtle hover states, translucent overlays, and minimal animation.
- Tool and code output should use a mono font treatment and be visually distinct
  from prose.

**Prototype caveats:**

- The prototype uses mock sessions, mock messages, mock agents, mock accounts,
  and simulated generation.
- The prototype is a design reference, not a runtime architecture.
- Any feature shown in the prototype still needs to be mapped to real Cat Code
  runtime state before being marked complete.
- Missing prototype features do not mean missing product scope. `/goal`, server
  runtime state, durable reconnect, and transcript compatibility remain
  required even if not fully represented in the prototype.

## Phase Overview

| Phase | Name | Outcome |
|---|---|---|
| 0 | Baseline And Inventory | Document what the terminal owns and what must move. |
| 1 | Runtime Boundary | Create an app-facing session controller and event contract. |
| 2 | Permissions And Streaming | Move permission requests and live stream events through the controller. |
| 3 | Terminal As Client | Route a narrow terminal path through the new runtime boundary. |
| 4 | First Dedicated App Shell | Build the first local app UI against the runtime boundary. |
| 5 | Session And Goal Parity | Add resume, transcript browsing, `/goal`, and Agent Mode visibility. |
| 6 | Server Runtime Mode | Make the server Mac the durable execution host. |
| 7 | App Becomes Primary | Flip daily usage to the app and reduce terminal-only assumptions. |
| 8 | Cleanup And Hardening | Remove obsolete terminal-centered coupling and stabilize packaging. |

## Phase 0: Baseline And Inventory

**Purpose:** Make the hidden terminal coupling explicit before extracting
runtime code.

**Key work:**

- Map all responsibilities currently owned by `src/screens/REPL.tsx`.
- Identify which responsibilities are runtime concerns and which are purely UI.
- Confirm the current transcript, resume, permissions, `/goal`, and Agent Mode
  behavior.
- Record which existing docs are stale or misleading.

**Primary files:**

- `docs/maps/WORKSPACE_MAP.md`
- `docs/reference/2026-04-30-codex-core-extraction-map.md`
- `src/screens/REPL.tsx`
- `src/QueryEngine.ts`
- `src/utils/handlePromptSubmit.ts`
- `src/utils/sessionStorage.ts`
- `src/utils/threadGoal.ts`

**Done when:**

- There is a current written inventory of terminal-owned behavior.
- The first runtime extraction target is agreed.
- The existing terminal and `/goal` tests still pass.

## Phase 1: Runtime Boundary

**Purpose:** Create the first app-facing boundary without changing visible
terminal behavior.

**Key work:**

- Add `src/app-runtime/`.
- Define app-facing session events.
- Add a minimal `AppSessionController`.
- Add a `QueryEngine` adapter.
- Write a boundary doc that future agents can follow.

**Detailed plan:**

- `docs/superpowers/plans/2026-05-03-dedicated-app-replacement-plan.md`

**Done when:**

- Tests can exercise the app runtime without importing Ink or `REPL.tsx`.
- The controller can emit status, message, permission, and goal events.
- The terminal still builds and behaves as before.

## Phase 2: Permissions And Streaming

**Purpose:** Make the app runtime capable of handling real interactive agent
turns, not just mocked messages.

**Key work:**

- Surface tool permission requests as app-runtime events.
- Accept allow/deny responses through the controller.
- Stream assistant text, tool progress, tool results, and final result events.
- Preserve existing permission policy and hook behavior.
- Define abort behavior for active turns.

**Primary files:**

- `src/app-runtime/`
- `src/QueryEngine.ts`
- `src/hooks/useCanUseTool.tsx`
- `src/utils/permissions/permissions.ts`
- `src/cli/structuredIO.ts`
- `src/remote/RemoteSessionManager.ts`
- `src/server/directConnectManager.ts`

**Done when:**

- A non-terminal test can run a turn that requests permission and receives a
  decision.
- A non-terminal test can abort a running turn.
- Streaming event order is documented and tested.
- Existing terminal permission dialogs still work.

## Phase 3: Terminal As Client

**Purpose:** Start moving terminal behavior onto the shared runtime without
removing the terminal.

**Key work:**

- Route one narrow local prompt path from `REPL.tsx` through
  `AppSessionController`.
- Keep current `PromptInput`, `Messages`, and permission UI rendering intact.
- Avoid moving all slash commands at once.
- Compare transcript output before and after the routing change.

**Primary files:**

- `src/screens/REPL.tsx`
- `src/components/PromptInput/PromptInput.tsx`
- `src/components/Messages.tsx`
- `src/app-runtime/`
- `src/utils/handlePromptSubmit.ts`

**Done when:**

- A normal terminal prompt uses the shared runtime path.
- Visible terminal behavior remains equivalent.
- Transcript persistence remains equivalent.
- A feature flag or narrow fallback exists if the new path regresses.

## Phase 4: First Dedicated App Shell

**Purpose:** Build the first actual dedicated app interface against the runtime
boundary.

**Decision still required:** Choose the shell technology. Options include
Electron, Tauri, native macOS, or another packaged local app approach. The
existing `web/` app is not the target; using it alone does not satisfy this
phase.

**Key work:**

- Create a local app shell that consumes `src/app-runtime`.
- Use the prototype as the design reference for the first shell: sidebar,
  session list, tabs, chat workspace, tool cards, sticky input, command palette,
  permission modal, and context gauge.
- Render transcript messages.
- Provide prompt input.
- Show streaming assistant output.
- Show permission requests and send responses.
- Show session status.

**Done when:**

- The app can start a local session and complete a basic prompt.
- The app can display a tool permission request and answer it.
- The app shell visibly follows the prototype's workspace structure and theme.
- The app does not import Ink or `REPL.tsx`.
- The terminal still works.

## Phase 5: Session And Goal Parity

**Purpose:** Make the dedicated app usable for real Cat Code work.

**Key work:**

- Add session resume and transcript browsing.
- Add visible `/goal` state.
- Add goal controls: create, pause, resume, clear, replace.
- Show context budget and live goal usage.
- Show Agent Mode workers and unresolved-worker blockers.
- Add app pages/surfaces corresponding to the prototype's Agents, Accounts, and
  Settings navigation where real runtime data exists.
- Show tool call history and command output in a usable way.

**Primary files:**

- `src/utils/sessionStorage.ts`
- `src/utils/threadGoal.ts`
- `src/utils/threadGoalActions.ts`
- `src/tools/AgentTool/`
- `src/agent-mode/`
- `src/tasks/`
- `src/app-runtime/`

**Done when:**

- The app can resume an existing session.
- The app can create and monitor a `/goal`.
- Goal continuation still works.
- Agent Mode worker state is visible enough to finish long-running tasks.
- Daily coding work can be completed from the app.

## Phase 6: Server Runtime Mode

**Purpose:** Move from a local UI replacement to the intended server-Mac
runtime architecture.

**Key work:**

- Run Cat Code as a durable server-Mac runtime.
- Let the dedicated app connect and disconnect without killing work.
- Preserve active turns and queued work across app disconnects.
- Add health/status visibility.
- Decide the durable task queue shape.

**Primary files:**

- `src/server/`
- `src/remote/`
- `src/cli/structuredIO.ts`
- `src/tasks/`
- `src/utils/sessionStorage.ts`
- `docs/vision/2026-04-30-GOAL_PLAN.md`

**Done when:**

- The server Mac can continue running a task after the app disconnects.
- The app can reconnect and recover live session state.
- Reboot/disconnect behavior is documented.
- There is a clear operator command for starting/stopping the runtime.

## Phase 7: App Becomes Primary

**Purpose:** Make the dedicated app the default human interface.

**Key work:**

- Move high-value terminal-only UX into the app.
- Make app startup and connection reliable enough for daily use.
- Add app-first onboarding/status/help.
- Decide what remains terminal-only.
- Update root operator docs to reflect the new primary interface.

**Primary files:**

- `README.md`
- `CLAUDE.md`
- `AGENTS.md`
- app shell files
- `src/app-runtime/`
- `src/screens/REPL.tsx`

**Done when:**

- README describes the app as the primary interface.
- The terminal is documented as compatibility/scripting access.
- Normal work no longer requires opening the terminal UI.

## Phase 8: Cleanup And Hardening

**Purpose:** Pay down coupling once the app is real and used.

**Key work:**

- Remove or isolate terminal-only assumptions from runtime modules.
- Simplify `REPL.tsx` once responsibilities have moved.
- Harden app/runtime tests.
- Package the dedicated app.
- Remove stale docs and update the workspace map.

**Primary files:**

- `src/screens/REPL.tsx`
- `src/app-runtime/`
- `src/ink/`
- `docs/maps/WORKSPACE_MAP.md`
- packaging/build files for the chosen app shell

**Done when:**

- Runtime modules do not import terminal UI code.
- The app has stable packaging.
- Terminal compatibility is intentionally scoped.
- The docs match the new architecture.

## Open Decisions

- Which shell technology should the dedicated app use first?
- Should the app connect directly to the same process or to a server-Mac
  service from the beginning?
- What is the minimum acceptable permission UI for daily use?
- Should slash commands remain text commands in the app, become UI actions, or
  both?
- What is the first durable task queue implementation?
- How much of Agent Mode worker control should be visible in the first app?

## Current Next Step

Execute the dedicated app refactor swarm task:

```text
docs/superpowers/plans/2026-05-03-dedicated-app-cat-swarm-task.md
```

Use `/goal` with:

```text
/goal --budget 250K Refactor Cat Code from a terminal-first product into a real dedicated app path, preserving provider routing, tools, permissions, transcripts, Agent Mode, and goal behavior while making the terminal a compatibility client rather than the runtime owner.
```

## Current Refactor Boundary Handoff

As the first scaffold lands, keep the dedicated app path conservative:

- `src/app-runtime/` is the intended app-facing boundary for shared runtime
  behavior that a dedicated app can consume without importing terminal UI code.
- The first dedicated shell should stay thin and live outside the root `web/`
  browser/Vite surface.
- The root `web/` surface may remain useful history or bridge code, but it is
  not the destination for the dedicated app replacement.
- The dedicated app path must remain no-Ink and no-REPL: no imports from `ink`,
  no imports from `src/screens/REPL.tsx`, and no dependency on REPL-owned event
  loops as the way the app works.
- Do not mark any roadmap phase complete until the corresponding filesystem
  paths, wiring, and validation have actually landed.

Before claiming boundary work complete, verify:

```bash
test -d src/app-runtime
bun run validate:dedicated-app
bun run build:dedicated-app
bun test src/app-runtime/sessionEvents.test.ts src/app-runtime/AppSessionController.test.ts src/app-runtime/createQueryEngineSessionController.test.ts src/app-runtime/appRuntimeCanUseTool.test.ts
bun run build:dev:full
```

Also search docs for stale copy that routes the dedicated app replacement back
to root `web/`.

Current status: the scaffold has a React shell, a Bun-served local HTML host, and
an app-runtime bridge that can turn `QueryEngineConfig.canUseTool` ask decisions
into app permission events. The next phase must supply the real session bootstrap
configuration and connect the host to live `AppSessionController` events before
the app can complete real turns independently of the REPL.

## Update Rules

- Update this file when a phase changes, completes, or splits.
- Keep detailed coding steps in `docs/superpowers/plans/`.
- Keep this file focused on durable direction, phase boundaries, and completion
  criteria.
- Do not mark a phase done unless the listed completion criteria are actually
  satisfied.
