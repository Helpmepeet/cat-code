# Dedicated App Migration Scope

Created: 2026-06-06

## Scope Rule

Do not migrate the entire Claude Design prototype in one plan. Each plan must
produce one reviewable and testable slice.

## Eventual MVP Surface Classification

This section classifies the broader design handoff MVP. It is not the next
implementation slice. The next implementation slice is Phase 1 below and is
intentionally smaller.

### Eventual MVP

- Startup trust/auth state.
- Global app shell.
- Sidebar/session list.
- One main chat panel.
- Prompt composer.
- Streaming response display.
- Thinking block display policy.
- Tool cards.
- Permission queue.
- Command palette as an accelerator.
- Same-project new and resume session actions.
- Goal chip and detail panel.
- Basic task/agent status indicators.
- Model, provider, effort, reasoning, fast, and thinking visibility.
- Account switch/login visibility.
- Context and usage status.
- Reconnect, blocked-send, error, banner, and toast surfaces.

### Parity

- Full command coverage and app-native command routing.
- Full session management.
- Full Agent Mode and task roster/details.
- Settings for permissions, MCP, plugins, skills, hooks, privacy, keybindings,
  output style, and managed configuration.
- MCP elicitation dialogs.
- Complete tool renderers.
- IDE, LSP, native, and computer-use surfaces.
- Diagnostics, status, stats, cost, and usage surfaces.
- Remote/server viewer and control modes.

### Future

- Rich split-pane workspace.
- Pinned tool output.
- Drag/drop for files, sessions, and panels.
- Image and attachment lightbox.
- Richer charts.
- Mermaid and document previews.
- Persistent agent tree.
- Browser or OS notifications.
- Mobile and tablet layouts.

## Phase 0: Handoff Normalization

Status: first executable plan.

Outcome:

- Handoff files are indexed.
- Runtime contracts are mapped.
- Production component candidates are named.
- Prototype-only behavior is explicitly excluded.
- MVP, parity, and future surfaces are separated.

No runtime or UI files change in this phase.

## Phase 1: Runtime-Backed Single Chat

Outcome:

- Browser app can display real app-runtime messages for one session.
- Browser app can submit one prompt through an explicit app-runtime path.
- Permission requests can be approved or denied from the app.
- Goal snapshots are visible.
- Abort/blocked/reconnect state is visible.

Excluded from Phase 1:

- Multi-tab.
- Split panels.
- Real session browser.
- Accounts charts.
- Agents and tasks pages.
- Settings redesign.
- Command palette.
- Launcher variants.

## Phase 2: UI Tokens And Production Components

Outcome:

- Prototype visual language is represented as named tokens and small production
  components.
- Component states are tested or previewed.
- `web/src/App.tsx` is split only where it directly supports the dedicated app
  slice.

## Phase 3: Session Navigation

Outcome:

- New session and resume same-project session are app-native.
- Cross-project warning is present.
- Draft input and transcript position are preserved.
- Session list rendering uses optimized metadata and does not read full
  transcripts per row.

## Phase 4: Tool Work Artifacts

Outcome:

- Tool calls and outputs are inspectable.
- Bash output, diffs, denials, cancellations, truncation, and errors have
  distinct UI states.
- Jump-to-latest behavior works under streaming output.

## Phase 5: Work Management And Settings

Outcome:

- Agents, tasks, accounts, command palette, settings, model/provider controls,
  and split-panel workflows migrate only after the core work loop is real.

## Definition Of Ready For Phase 1

Phase 1 can start when Phase 0 docs exist and reviewers agree on:

- The app transport boundary.
- Whether `web/` remains the dedicated app target or a new app directory is
  needed.
- The browser transport security model, including origin/auth expectations
  before browser-originated prompts or permission responses are accepted.
- The first session lifecycle supported by the browser app.
- The backend bootstrap/session assembly path for setup, commands, agents, MCP,
  permission mode, app state, and QueryEngine config outside the Ink REPL.
- The exact permission request and response flow.
- The exact permission wire schemas for allow, deny, cancel, updated input,
  persistent rule updates, recheck, sandbox/network distinction, worker identity,
  and reconnect replay of pending requests.
- The SDK-message mapper scope from app-runtime stream-json messages to browser
  UI state, including partial streaming behavior.
- The QueryEngine assembly strategy for app sessions outside the Ink REPL path.
- The abort lifecycle behavior for interrupted and subsequent app turns.
- The minimum status fields available to the UI.
- Whether existing web TypeScript failures are fixed inside Phase 1 or in a
  separate prep patch.
- The web verification strategy. `web/package.json` currently has no test
  script, and root lint excludes `web/`, so Phase 1 must add or choose a focused
  browser/component verification command before relying on web UI tests.

## Definition Of Done For Phase 1

Phase 1 is done when:

- A focused automated test proves app-runtime events are forwarded to the
  browser app or its adapter.
- A focused web verification command proves messages, permission request, goal
  snapshot, and abort state render correctly.
- Permission acceptance coverage includes allow, deny, cancel, updated input,
  persistent permission updates, worker identity display, sandbox/network
  distinction, and pending request behavior across reconnect.
- Browser-originated prompts and permission responses are protected by the
  transport security model chosen in Definition of Ready.
- A manual `cat-code --web` smoke test demonstrates the single-session path.
- Terminal mode still works.
- No `MOCK_*` handoff data is used in the production path.
