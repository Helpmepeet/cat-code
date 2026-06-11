# Claude Design To Dedicated App Migration Roadmap

Created: 2026-06-06

## Purpose

This roadmap explains how to migrate the Claude Design handoff bundle at
`/Users/pt/Downloads/catcode-handoff.zip` into the Cat Code codebase without
mistaking the prototype for production code.

The target is a dedicated Cat Code app experience that can eventually replace
normal terminal-driven daily work. The near-term target is narrower: create a
repo-local, reviewed migration baseline and then build one real runtime-backed
vertical slice.

## External Research Summary

Claude Design's own handoff guidance frames exported prototypes as a bridge to
engineering, not as finished app code. The handoff carries prototype structure,
design decisions, and context into coding work, but implementation still needs
to happen in the production codebase with production components and runtime
contracts. References:

- [Get started with Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
- [Using Claude Design for prototypes and UX](https://claude.com/resources/tutorials/using-claude-design-for-prototypes-and-ux)

Design-system guidance points to the same migration pattern. Stable handoff
works through named tokens, shared component names, documented states, and
production component libraries rather than raw inline styling from a prototype.
References:

- [Figma design tokens](https://www.figma.com/resource-library/design-tokens/)
- [How Figma uses Dev Mode](https://www.figma.com/best-practices/how-figma-uses-dev-mode/)

Public developer and design-system discussions are less authoritative, but they
repeat a practical warning: design-to-code fails when loading, empty, error,
long-content, responsive, and permission states are missing or when design files
do not map to real coded components. Treat that as a process risk, not a source
of product requirements.

## Repo Facts

- `CatCode Web App v3.html` is the primary prototype entry in the handoff. It
  imports `cat-app/data.js`, then `cat-app/Sidebar.jsx`,
  `cat-app/Surfaces.jsx`, `cat-app/Startup.jsx`, `cat-app/Messages.jsx`,
  `cat-app/Welcome.jsx`, `cat-app/Chat.jsx`, `cat-app/Pages.jsx`,
  `cat-app/TabBar.jsx`, `cat-app/WorkspaceLayout.jsx`, and
  `cat-app/AppV2.jsx`.
- `cat-app-v2-snapshot/` is an older snapshot. It is useful for comparison but
  is not the primary target.
- The current production-ish browser surface is `web/`, especially
  `web/src/App.tsx`. It is a small Vite app, not the dedicated app prototype.
- The current backend-facing runtime boundary is `src/app-runtime/`. It exposes
  app session events for messages, goal snapshots, permission requests and
  resolutions, and abort status.
- `src/web/` owns the current WebSocket relay. The present `--web` mode is
  browser-first but intentionally disables browser sending because it still
  depends on terminal REPL wiring.
- No `src/dedicated-app/` shell exists in this checkout.
- The design docs referenced inside the handoff as `docs/design/...` are not
  present in the repo. They exist only inside the ZIP under
  `catcode/project/uploads/`.

## Migration Rules

1. The prototype is design evidence, not implementation source.
2. Runtime semantics win over prototype behavior.
3. No production path may depend on `MOCK_*` handoff data.
4. Keep terminal mode working until the app supports normal chat, streaming,
   tool approvals, session resume, goal state, and worker visibility.
5. Build in vertical slices. Each slice must end in something real and
   testable.
6. Introduce tokens and production components before broad visual porting.
7. Every app-native control must preserve terminal-owned behavior for
   permissions, goals, sessions, tools, accounts, auth, and safety.
8. Large parity surfaces stay out of the first implementation slice.

## Phased Migration

### Phase 0: Handoff Normalization

Goal: convert the ZIP into repo-local requirements and contracts.

Deliverables:

- `docs/design/dedicated-app/handoff-index.md`
- `docs/design/dedicated-app/runtime-contract-map.md`
- `docs/design/dedicated-app/component-inventory.md`
- `docs/design/dedicated-app/migration-scope.md`

This phase does not change runtime code or UI code. It exists to make later
implementation work reviewable.

### Phase 1: Runtime-Backed Single Chat Slice

Goal: prove that the browser app can consume real app-runtime events for one
session.

Included:

- One chat panel.
- Message stream display.
- Composer shell.
- Connection and active-turn state.
- Goal snapshot display.
- Permission request and resolution UI.
- Abort status display.

Phase 1 must settle the app transport boundary, browser transport security,
backend bootstrap/session assembly, SDK-message mapping, QueryEngine assembly
outside the Ink REPL path, permission response protocol, and abort lifecycle
before visual parity work expands.

Excluded:

- Split panels.
- Multiple tabs.
- Session browser.
- Accounts charts.
- Agents and tasks pages.
- Model/provider/effort mutation controls.
- Launcher experiments.

### Phase 2: Production UI System

Goal: translate the prototype's visual language into maintainable production
tokens and reusable web components.

Included:

- Semantic color, radius, spacing, typography, and shadow tokens.
- Shell, sidebar, status chip, composer, message, tool card, permission dialog,
  and goal panel components.
- State fixtures or stories if the web stack adds a component preview tool.

### Phase 3: Session Navigation

Goal: make the app useful across real Cat Code sessions.

Included:

- New session.
- Resume same-project session.
- Cross-project warning.
- Draft persistence.
- Scroll position and transcript position persistence.
- Optimized session list metadata path.

### Phase 4: Tool Work Artifacts

Goal: make tool-heavy agent work inspectable outside the terminal.

Included:

- Tool states: input, running, done, error, denied, cancelled, truncated.
- Bash output.
- Diff output with file path and line context.
- Thinking block display policy.
- Jump-to-latest behavior.

### Phase 5: Work Management And Account Surfaces

Goal: migrate larger parity surfaces after the core work loop is real.

Included later:

- Command palette.
- Agents page.
- Tasks page.
- Accounts page.
- Settings pages.
- Multi-tab and split-panel workflows.
- Model/provider/effort controls.

## First Executable Plan

Start with
`docs/superpowers/plans/2026-06-06-dedicated-app-handoff-normalization.md`.
That plan intentionally stops at documentation and contracts. It should be
completed and reviewed before Phase 1 runtime work starts.

## Non-Goals For The First Plan

- Do not copy `cat-app/*.jsx` into `web/src/`.
- Do not wire mock sessions or mock accounts into production UI.
- Do not add split panel support.
- Do not add a settings redesign.
- Do not replace terminal startup, auth, permission, or session semantics.
- Do not change `DONE.md`.
