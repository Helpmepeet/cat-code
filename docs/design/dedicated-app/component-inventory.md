# Dedicated App Component Inventory

Created: 2026-06-06

## Purpose

This document translates the prototype into production component candidates and
design tokens. It does not prescribe copying prototype JSX.

## Prototype Files To Preserve As References

- `catcode/project/cat-app/Sidebar.jsx`
- `catcode/project/cat-app/Surfaces.jsx`
- `catcode/project/cat-app/Startup.jsx`
- `catcode/project/cat-app/Messages.jsx`
- `catcode/project/cat-app/Welcome.jsx`
- `catcode/project/cat-app/Chat.jsx`
- `catcode/project/cat-app/Pages.jsx`
- `catcode/project/cat-app/TabBar.jsx`
- `catcode/project/cat-app/WorkspaceLayout.jsx`
- `catcode/project/cat-app/AppV2.jsx`

## Visual Tokens

Primitive values seen repeatedly in the primary prototype:

| Token candidate | Prototype value | Use |
|---|---:|---|
| `color.bg.base` | `#09090b` | App background. |
| `color.bg.panel` | `#0a0a0c`, `#0d0d10`, `#111113` | Panels, modals, elevated surfaces. |
| `color.border.subtle` | `rgba(255,255,255,0.05)` | Low-contrast separators. |
| `color.border.default` | `rgba(255,255,255,0.1)` | Controls, dialogs, cards. |
| `color.text.primary` | `#f4f4f5` | Main text. |
| `color.text.secondary` | `#a1a1aa`, `#71717a` | Secondary text. |
| `color.text.muted` | `#52525b`, `#3f3f46` | Labels and disabled copy. |
| `color.accent.primary` | `#f472b6` | Primary Cat Code accent. |
| `color.accent.blue` | `#60a5fa` | Alternate status/accent. |
| `color.accent.green` | `#4ade80` | Success. |
| `color.accent.purple` | `#c084fc` | Alternate status/accent. |
| `color.status.warning` | `#fbbf24` | Permission and warning state. |
| `color.status.danger` | `#f87171` | Error/destructive state. |

Typography:

- UI sans: `DM Sans` in prototype, with native system fallback acceptable if the
  production web app keeps its current font stack intentionally.
- Mono: `DM Mono` for commands, code, tool output, and compact technical labels.
- Display novelty: `Press Start 2P` appears in the prototype but should not be a
  default production UI font.

Shape and density:

- Compact rows.
- Radius generally between 8px and 16px depending on surface elevation.
- Thin borders.
- Subtle hover states.
- Backdrop blur for modal overlays.

## Production Component Candidates

| Component | First phase | Responsibility |
|---|---|---|
| `DedicatedAppShell` | Phase 1 | Overall browser app frame for one live session. |
| `StatusChip` | Phase 1 | Read-only runtime, connection, goal, and permission status. |
| `MessageList` | Phase 1 | Ordered SDK/app message display. |
| `Composer` | Phase 1 | Single-session prompt input and send/blocked state. |
| `PermissionDialog` | Phase 1 | Real permission request decision UI. |
| `GoalStatus` | Phase 1 | Read-only goal snapshot display. |
| `AppBannerStack` | Phase 2 | Persistent recoverable state and warning banners. |
| `ToolCard` | Phase 4 | Tool input/output/error/diff display. |
| `SessionSidebar` | Phase 3 | Real session search, new, resume, and active session navigation. |
| `CommandPalette` | Phase 5 | Accelerator only; visible controls must exist elsewhere. |
| `AccountsView` | Phase 5 | Account and usage state after real account contract exists. |
| `SettingsView` | Phase 5 | Settings grouped by user intent. |

## Prototype-Only Behaviors Not To Copy

- `window.MOCK_SESSIONS`
- `window.MOCK_MESSAGES`
- `window.MOCK_AGENTS`
- `window.MOCK_ACCOUNTS`
- `window.MOCK_STATUS`
- `window.MOCK_GOAL`
- `window.MOCK_PERM_QUEUE`
- `window.toast` as a browser global API
- `localStorage` startup trust/auth state as production trust or auth source
- Browser-global component registration through `window.*`
- Timed fake OAuth completion in `Startup.jsx`
- Timed fake streaming in `Chat.jsx`
- Stub attachment, IDE, account, model, effort, connection, task, permission,
  and goal actions that only show toasts
- Prototype command list as command availability source
- Babel/unpkg loading and edit-mode host protocol
- Static charts and static settings controls in `Pages.jsx`

## Required States Before A Component Is Production-Ready

Each production component must document and test the states it owns.

Minimum state coverage:

- Empty.
- Loading or streaming.
- Success.
- Warning.
- Error.
- Disabled or blocked.
- Long text.
- Narrow viewport.
- Reconnect or stale data where relevant.
- Permission pending where relevant.

## First Component Slice

Phase 1 should introduce only the components needed for a real single-session
chat loop:

- `DedicatedAppShell`
- `MessageList`
- `Composer`
- `StatusChip`
- `PermissionDialog`
- `GoalStatus`

Do not introduce split panels, accounts charts, task pages, or settings pages
in the first component slice.

