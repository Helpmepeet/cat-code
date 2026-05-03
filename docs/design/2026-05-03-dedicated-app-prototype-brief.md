# Dedicated App Prototype Brief

**Status:** Design reference
**Created:** 2026-05-03
**Source prototype:** `/Users/pt/Downloads/catcode_prototype.zip`

This brief captures the product and visual direction from the existing
HTML/React prototype for the Cat Code dedicated app. The prototype is incomplete
and uses mock data, so this document should guide UI direction without implying
runtime support already exists.

## Source Files Reviewed

- `CatCode Web App v2.html`
- `CatCode Web App.html`
- `cat-app/AppV2.jsx`
- `cat-app/WorkspaceLayout.jsx`
- `cat-app/Sidebar.jsx`
- `cat-app/TabBar.jsx`
- `cat-app/Chat.jsx`
- `cat-app/Messages.jsx`
- `cat-app/Pages.jsx`
- `cat-app/data.js`
- `screenshots/accounts.png`
- `screenshots/chat2.png`
- `screenshots/tokens.png`
- `screenshots/workspace*.png`
- `screenshots/widget*.png`

## Product Intent

The dedicated app should be a dense local agent workspace, not a terminal
transcript in a web view. The prototype centers on managing multiple live or
recent sessions, inspecting tool activity, and keeping account/context/runtime
status visible while work is happening.

The first app shell should preserve this direction even if it starts with fewer
working features.

## Core Surfaces

- Sidebar: fixed left navigation with Cat Code identity, session search,
  workspace-grouped sessions, and navigation for Chat, Agents, Accounts, and
  Settings.
- Tabs: top tab bar for multiple open chats, with add/close controls.
- Workspace: one to three resizable chat panels, with active-panel state and
  session switching per panel.
- Chat: scrollable messages, sticky bottom input, top session title, empty
  state suggestions, stop/send controls, and jump-to-latest behavior.
- Messages: user/assistant bubbles, thinking blocks, tool cards, command
  output, diffs, and status badges.
- Command palette: `Cmd/Ctrl+K` overlay for sessions and slash commands.
- Permission modal: explicit allow, deny, and always-allow actions.
- Context gauge: compact context usage indicator near the input with expanded
  model/profile/session details.
- Agents page: running/completed agent visibility and control actions.
- Accounts page: token usage charts, profile/account breakdown, cache usage,
  and rate-limit status.
- Settings page: app preferences and runtime/account configuration.

## Visual Direction

- Base: very dark zinc/black surfaces such as `#09090b`, `#0a0a0c`,
  `#0d0d10`, and `#111113`.
- Borders: low-contrast white alpha borders around `rgba(255,255,255,0.05)` to
  `rgba(255,255,255,0.1)`.
- Primary accent: pink `#f472b6`.
- Accent variants: blue `#60a5fa`, green `#4ade80`, purple `#c084fc`.
- Status colors: green for success, yellow `#fbbf24` for warning/permission,
  red `#f87171` for error/destructive state.
- Density: compact app layout, small labels, tight rows, subtle hover states,
  and restrained radius.
- Overlays: translucent dark modal surfaces with backdrop blur and strong
  shadows.
- Motion: minimal and functional, such as spinner, pulse dot, hover states,
  chevron rotation, resize highlight, and drag/drop overlay.
- Code/tool output: mono font treatment, compact badges, preformatted output,
  and colored diff rows.

## Implementation Notes

- Preserve the prototype's workspace concept even if Phase 4 only implements one
  panel at first.
- Keep split-panel support in the app architecture early so it is not difficult
  to add later.
- Treat slash commands as both text commands and discoverable command-palette
  actions.
- Permission UI must map to real existing permission semantics. The prototype's
  modal is visual guidance only.
- Accounts and token charts should wait for real provider/account data instead
  of hardcoding the mock prototype data.
- `/goal` is required product state even though the prototype does not fully
  represent it. It should be visible near session/runtime status and controllable
  from the app.

## Caveats

- Mock sessions, messages, agents, accounts, token usage, and generation flows
  are not implementation evidence.
- The prototype does not decide the app shell technology.
- The prototype does not replace the runtime-boundary plan.
- The prototype is not a complete feature list; missing runtime requirements in
  the prototype still remain required by the ground-truth roadmap.

