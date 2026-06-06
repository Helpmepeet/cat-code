# Cat Code Terminal UI/UX Inventory

> **Purpose:** A complete reference for rebuilding the Cat Code terminal experience as a web-based interface with full feature parity.
> **Constraint:** This document is for documentation only. No code has been changed.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Screen Map](#2-screen-map)
3. [Layout System](#3-layout-system)
4. [User Input & Composition](#4-user-input--composition)
5. [Message Rendering](#5-message-rendering)
6. [Slash Commands Reference](#6-slash-commands-reference)
7. [Keyboard Shortcuts & Keybindings](#7-keyboard-shortcuts--keybindings)
8. [Dialogs, Overlays & Modals](#8-dialogs-overlays--modals)
9. [Notifications & Status Indicators](#9-notifications--status-indicators)
10. [Permission & Tool Confirmation Flows](#10-permission--tool-confirmation-flows)
11. [Session Management UI](#11-session-management-ui)
12. [Agent Mode UI](#12-agent-mode-ui)
13. [Doctor / Diagnostics Screen](#13-doctor--diagnostics-screen)
14. [Data Sources](#14-data-sources)
15. [Main User Flows](#15-main-user-flows)
16. [Special States & Edge Cases](#16-special-states--edge-cases)
17. [Must-Preserve Checklist for Web UI](#17-must-preserve-checklist-for-web-ui)

---

## 1. Architecture Overview

The UI is built on **React + Ink** (React for terminal). The primary rendering stack is:

```
cli.tsx (entrypoint)
  └─ App.tsx (root providers: FPS, stats, AppState)
       └─ FullscreenLayout.tsx (layout: scroll area + bottom bar)
            └─ REPL.tsx (main interactive session)
                 ├─ VirtualMessageList.tsx (transcript)
                 │    └─ MessageRow.tsx → Message.tsx (individual messages)
                 ├─ PromptInput/ (text composition)
                 ├─ Spinner.tsx (loading state)
                 └─ [many overlays and dialogs]
```

**Key characteristics:**
- `REPL.tsx` is ~6,000 lines and is the operational hub for all session state.
- Feature flags from `bun:bundle` (`feature('FEATURE_NAME')`) gate many UI paths at **build time**. The build variant (`external` vs `ant`) controls which features are always-included.
- The alternate screen buffer (`<AlternateScreen>`) is used in fullscreen mode, giving a bounded viewport with mouse tracking.

**File references:**
- `src/entrypoints/cli.tsx` — CLI bootstrap, early flag checks, routing to screens
- `src/components/App.tsx` — Root provider wrapper
- `src/screens/REPL.tsx` — Main loop, all session state
- `src/components/FullscreenLayout.tsx` — Layout, scroll chrome, pill
- `src/components/VirtualMessageList.tsx` — Virtual scrolling transcript

---

## 2. Screen Map

### 2.1 Bootstrap & Pre-Session Screens

| Screen | When Shown | File |
|--------|-----------|------|
| **Trust Dialog** | First run in a new directory | `src/components/TrustDialog/` |
| **Onboarding** | First-time user setup | `src/components/Onboarding.tsx` |
| **ApproveApiKey** | API key not configured | `src/components/ApproveApiKey.tsx` |
| **ConsoleOAuthFlow** | OAuth login required | `src/components/ConsoleOAuthFlow.tsx` |

### 2.2 Session Picker Screen (ResumeConversation)

Shown when `--resume` flag is passed or user runs the resume flow. Transitions to REPL after selection.

**States:**
1. **Loading** — `<Spinner /> Loading conversations…`
2. **Session List** — `<LogSelector>` with searchable, scrollable list of past sessions
3. **Resuming** — `<Spinner /> Resuming conversation…`
4. **No Conversations** — `"No conversations found to resume. Press Ctrl+C to exit."`
5. **Cross-Project** — `"This conversation is from a different directory. To resume, run: [command]"` + clipboard copy

**Interactions:**
- Arrow keys / type to filter sessions
- Enter to select
- Ctrl+C to cancel (exits with code 1)
- Toggle "All Projects" view

**File:** `src/screens/ResumeConversation.tsx`

### 2.3 Main REPL Screen

The interactive session. Always visible after onboarding. See sections 3–16 for detail.

**File:** `src/screens/REPL.tsx`

### 2.4 Doctor Screen

Triggered by `/doctor` slash command. Shows diagnostic information and is dismissed with Enter, Esc, or Ctrl+C.

**File:** `src/screens/Doctor.tsx` (see §13 for full breakdown)

---

## 3. Layout System

### 3.1 Fullscreen Mode (default for internal/ant builds)

`FullscreenLayout` wraps the REPL in a two-region flex column:

```
┌─────────────────────────────────────┐
│  [StickyPromptHeader]  ← 1 row, may be nil
│  ┌─────────────────────────────────┐ │
│  │  ScrollBox (flexGrow=1)         │ │
│  │    • ScrollChromeContext        │ │
│  │    • [messages / scrollable]    │ │
│  │    • [overlay, e.g. Perms]      │ │
│  │                                 │ │
│  │  [NewMessagesPill]  ← absolute  │ │
│  │  [bottomFloat]      ← abs. BR   │ │
│  └─────────────────────────────────┘ │
│  [SuggestionsOverlay] ← abs. bottom% │
│  [DialogOverlay]      ← abs. bottom% │
│  [bottom slot: spinner/prompt/perms] │
│  [modal]            ← abs. floor     │
└─────────────────────────────────────┘
```

- **Scrollable area**: sticky-scroll (auto-follows bottom unless user scrolls up)
- **Bottom slot**: prompt input, spinner, permission sticky footer — max 50% height
- **Modal slot**: `/` commands, status panels — absolute-positioned, bottom-anchored, grows upward, clips at `terminalRows - 2`
- **Overlay slot**: renders inside ScrollBox after messages (for PermissionRequest so user can scroll context)
- **bottomFloat**: companion speech bubble (absolute, bottom-right, fullscreen only)

**File:** `src/components/FullscreenLayout.tsx`

### 3.2 Non-Fullscreen Mode

All regions render sequentially in a flat `<>` fragment. Uses the terminal's native scrollback.

### 3.3 Sticky Prompt Header

When the user scrolls up away from the bottom, a 1-row header appears above the ScrollBox showing the prompt that Claude was responding to. Clicking it jumps back to that prompt.

States: `null` (pinned) | `{text, scrollTo}` (scrolled up) | `"clicked"` (just clicked, hide header temporarily)

### 3.4 "New Messages" Pill

When scrolled up and new messages arrive, a centered absolute pill floats at the bottom of the ScrollBox:
- `0 new` → "**Jump to bottom ↓**"
- `N new` → "**N new messages ↓**"

Clicking scrolls to bottom. The pill disappears when the user reaches the divider position.

**File:** `src/components/FullscreenLayout.tsx` — `NewMessagesPill`, `useUnseenDivider`, `computeUnseenDivider`

---

## 4. User Input & Composition

### 4.1 Prompt Input

**Location:** `src/components/PromptInput/` (entire directory)

The prompt input is a terminal text editor with Vi-mode, multi-line support, and paste handling. Key behaviors:

- **Multi-line input**: Shift+Enter (configurable), or `/newline` command
- **Vi mode toggle**: `/vim` command; persisted to settings
- **Paste detection**: Large paste triggers a confirmation dialog
- **Idle state**: Shows hint text (configurable shortcut hints)
- **Active state**: Placeholder text hides, full cursor control

### 4.2 Slash Command Autocomplete

While typing `/`, a `SuggestionsOverlay` appears above the input (absolute positioned, `bottom="100%"`) showing matching slash commands:
- Arrow keys navigate the suggestion list
- Tab / Enter selects
- Esc dismisses without selecting

**File:** `src/components/PromptInput/PromptInputFooterSuggestions.tsx`, `src/context/promptOverlayContext.tsx`

### 4.3 @ Mentions / Context Attachments

Type `@` to reference files, URLs, or other context. Autocomplete list appears similar to slash commands.

### 4.4 Input Modes

| Mode | Description |
|------|-------------|
| **Normal** | Default text input |
| **Vi/Vim** | Vi keybindings in input (toggled by `/vim`) |
| **Auto Mode** | Opt-in smarter mode (see `AutoModeOptInDialog.tsx`) |
| **Verbose** | Shows thinking blocks inline (toggled by `/verbose`) |

### 4.5 Deferred Typing Guard

A `PROMPT_SUPPRESSION_MS = 1500` delay prevents permission dialogs from appearing while the user is actively typing (guards against accidental keypress dismissals).

---

## 5. Message Rendering

### 5.1 Message Types

Messages in the transcript are rendered differently by type:

| `msg.type` | Visual Treatment |
|-----------|-----------------|
| `user` | Right-aligned or left with distinct styling; user text |
| `assistant` | Left-aligned; may contain text blocks, tool_use blocks |
| `tool_result` | Tool output, often collapsible |
| `system` | Dimmed system messages |
| `progress` | In-flight progress indicators (filtered from unseen count) |
| `attachment` | File/URL attachments (some are null-rendering) |
| `grouped_tool_use` | Several tool calls collapsed under one display message |
| `collapsed_read_search` | Read/Search tool call groups merged into a single collapsed row |

**Files:** `src/components/MessageRow.tsx`, `src/components/Message.tsx`, `src/components/Messages.tsx`

### 5.2 Streaming States

Each message row tracks whether it is:
- **Streaming** (`isMessageStreaming`) — content still arriving
- **In-progress** (`inProgressToolUseIDs`) — tool execution running
- **Resolved** (`resolvedToolUseIDs`) — tool done, result available
- **Static** (`shouldRenderStatically`) — fully settled, safe to memoize

An `OffscreenFreeze` wrapper prevents re-renders of scrolled-off static messages.

### 5.3 Collapsed Read/Search Groups

When Claude reads or searches many files, the individual tool calls collapse into a single `collapsed_read_search` row:
- **Active state** (grey animated dot, present tense): "Reading files…"
- **Completed state** (fixed dot, past tense): "Read N files"

### 5.4 Streaming Thinking Blocks

Extended thinking is shown inline. Auto-hidden 30 seconds after streaming ends. Toggle with `/verbose`.

**File:** `src/screens/REPL.tsx` (lines 893–907 — `streamingThinking` state and auto-hide effect)

### 5.5 Tool Output Display

Tool results have specialized renderers:
- `FileEditToolDiff.tsx` — Diff view for file edits
- `FileEditToolUpdatedMessage.tsx` — Compact after-edit summary
- `BashModeProgress.tsx` — Running bash command with elapsed timer
- `HighlightedCode.tsx` — Syntax-highlighted code blocks
- `StructuredDiff.tsx` — Structured diff view
- `Markdown.tsx` — Markdown rendering with table support

### 5.6 Progress Dot (⏺)

Each tool-use message shows a dot (`shouldShowDot={true}`) that animates during execution.

### 5.7 Transcript Mode

In transcript mode (read-only), `MessageRow` shows additional metadata below each assistant message:
- `MessageTimestamp` — Human-readable relative time
- `MessageModel` — Which model produced the response

### 5.8 "N New Messages" Divider

When scrolled up and new messages arrive, a divider line is injected into the transcript at the point where the user left off, showing "**N new messages below**".

---

## 6. Slash Commands Reference

Commands are registered via `src/commands.tsx` and merged with plugin/MCP commands. They can be disabled with `--no-slash-commands`.

### Core Commands

| Command | Description | Dialog/JSX |
|---------|-------------|-----------|
| `/help` | Show help screen | Opens `HelpV2` modal |
| `/clear` | Clear conversation history | Immediate |
| `/compact` | Compact memory (context collapse) | Immediate |
| `/exit` | Exit application | Asks for confirmation |
| `/quit` | Exit application | Alias for `/exit` |
| `/cost` | Show current session cost | Inline output |
| `/status` | Show MCP server status, model info | Opens modal panel |
| `/doctor` | Show diagnostics | Opens Doctor screen |
| `/vim` | Toggle Vim mode in input | Immediate |
| `/verbose` | Toggle verbose (thinking block) mode | Immediate |
| `/newline` | Insert a newline in the prompt | Immediate |
| `/model` | Show/change current model | Opens `ModelPicker` modal |
| `/memory` | View/edit saved memory content | Opens memory view |
| `/config` | View/change settings | Opens settings modal |
| `/bug` | Submit a bug report | Opens `Feedback` flow |
| `/btw` | Add a note to the conversation (immediate, persists while Claude processes) | Local JSX command |
| `/review` | Start PR review flow | Inline |
| `/pr` | Filter by PR number | |
| `/resume` | Resume a past session | Opens session picker |
| `/export` | Export conversation | Opens `ExportDialog` |
| `/history` | Search conversation history | Opens `HistorySearchDialog` |
| `/global-search` | Semantic search across all sessions | Opens `GlobalSearchDialog` |
| `/theme` | Change UI theme | Opens `ThemePicker` modal |
| `/keymap` | View keybinding conflicts, configure | |
| `/output` | Change output style | Opens `OutputStylePicker` |
| `/permissions` | Edit tool permission rules | |
| `/allowed-tools` | Manage which tools Claude can use | |
| `/mcp` | MCP server management | |
| `/switch-account` | Switch API account | |
| `/ide` | Manage IDE/editor integration | |
| `/teleport` | Teleport to a remote environment | |
| `/worktrees` | Manage Git worktrees | |
| `/task` | Show/manage task list | |
| `/agent` | Manage agent definitions | |

**File:** `src/commands.tsx`, `src/screens/REPL.tsx` (command merging at ~lines 874–878)

### Immediate Commands (`isLocalJSXCommand`)

Commands marked `immediate: true` (like `/btw`) show a persistent JSX overlay that is not overwritten by tool output. These are cleared only when the user explicitly dismisses them (`clearLocalJSX: true`).

---

## 7. Keyboard Shortcuts & Keybindings

Keybindings use a named action system managed by `src/keybindings/`. They are context-aware (`context: 'Global' | 'Confirmation' | 'REPL' | ...`).

### Global Keybindings

| Action | Default | Description |
|--------|---------|-------------|
| `app:interrupt` | Ctrl+C | Cancel current operation or exit |
| `app:exit` | Ctrl+D | Exit application |

### REPL / Transcript Navigation

| Action | Default | Description |
|--------|---------|-------------|
| Scroll Up | PgUp / ↑ (when not in input) | Scroll transcript up |
| Scroll Down | PgDn / ↓ (when not in input) | Scroll transcript down |
| Jump to Top | `G` (Vim-style) | Jump to beginning of transcript |
| Jump to Bottom | `End` | Jump to end of transcript |
| Ctrl+U | Half-page up | Scroll half a page up |
| Mouse wheel | Native | Scroll transcript |
| Click pill | Jump to bottom | Click "N new messages" pill |
| Click sticky header | Jump to prompt | Click the sticky header to jump to that message |

**File:** `src/components/ScrollKeybindingHandler.tsx` (149KB — comprehensive scroll control)

### Confirmation Dialogs

| Action | Default |
|--------|---------|
| `confirm:yes` | `y` / Enter |
| `confirm:no` | `n` / Esc |

**File:** `src/keybindings/useKeybinding.tsx`

### Input Shortcuts (inside PromptInput)

| Shortcut | Action |
|----------|--------|
| Shift+Enter | New line (configurable) |
| Tab | Select suggestion (in autocomplete) |
| Esc | Dismiss autocomplete / cancel |
| Ctrl+A | Jump to start of line |
| Ctrl+E | Jump to end of line |
| Ctrl+K | Kill to end of line |
| Up/Down | Navigate history (when at top/bottom of input) |
| Vi keys | When `/vim` is active |

---

## 8. Dialogs, Overlays & Modals

The app has three overlay mechanisms:
1. **Modal slot** (`modal` prop in FullscreenLayout) — bottom-anchored pane with `▔` divider. For slash-command dialogs and status panels.
2. **Overlay slot** (`overlay` prop) — inside the ScrollBox, after messages. For PermissionRequest so the user can scroll context.
3. **Tool JSX** (`toolJSX` in REPL state) — for imperative tool-driven UI that hides the prompt input.

### Dialog Catalog

| Component | Trigger | Description |
|-----------|---------|-------------|
| `AutoModeOptInDialog` | Opt-in prompt | Choice to enter Auto mode |
| `AutoUpdater` | On startup | Show update available, trigger install |
| `AwsAuthStatusBox` | AWS config needed | AWS auth flow |
| `BypassPermissionsModeDialog` | User enables bypass | Warning about bypass mode |
| `ChannelDowngradeDialog` | Channel switching | Warn about downgrading release channel |
| `ClaudeInChromeOnboarding` | Chrome extension | Chrome extension setup |
| `ClaudeMdExternalIncludesDialog` | `.claude/CLAUDE.md` has external includes | Confirm external files |
| `ConsoleOAuthFlow` | API key needed | Full OAuth login flow |
| `CostThresholdDialog` | Cost limit exceeded | Warn / abort on cost threshold |
| `DevChannelsDialog` | Dev channel switch | Switch between release channels |
| `ExitFlow` | On exit | Confirm exit / show exit options |
| `ExportDialog` | `/export` | Export full conversation |
| `FeedbackSurvey` | Bug report | Feedback/bug submission form |
| `GlobalSearchDialog` | `/global-search` | Semantic search across all sessions |
| `HelpV2` | `/help` | Full help screen with keybindings |
| `HistorySearchDialog` | `/history` | Full-text search in current session |
| `IdeAutoConnectDialog` | IDE detected | Auto-connect to running IDE |
| `IdeOnboardingDialog` | First IDE connection | IDE integration setup |
| `IdleReturnDialog` | Long background task finished | "You're back!" with summary |
| `InvalidConfigDialog` | Config file errors | Show config validation errors |
| `InvalidSettingsDialog` | Settings validation | Show settings errors |
| `MCPServerApprovalDialog` | New MCP server | Approve connecting to MCP server |
| `MCPServerDesktopImportDialog` | Desktop import | Import MCP servers from Claude Desktop |
| `MCPServerMultiselectDialog` | MCP management | Enable/disable MCP servers |
| `ModelPicker` | `/model` | Browse and switch models |
| `OutputStylePicker` | `/output` | Choose output formatting style |
| `QuickOpenDialog` | Quick file open | Fuzzy-find files to add to context |
| `RemoteEnvironmentDialog` | Remote session | Remote dev environment management |
| `ThemePicker` | `/theme` | Visual theme selection |
| `ThinkingToggle` | Settings | Extended thinking on/off |
| `TokenWarning` | Context near limit | Warn about approaching context limit |
| `UltraplanChoiceDialog` | Ultraplan trigger | Launch ultraplan flow |
| `WorkflowMultiselectDialog` | Workflow selection | Choose workflow |
| `WorktreeExitDialog` | Exiting worktree | Confirm worktree cleanup |

**File references:** `src/components/*.tsx` (named above)

---

## 9. Notifications & Status Indicators

### 9.1 In-line Notification System

REPL maintains a `notifications` queue (`addNotification`) rendered by `StatusNotices.tsx`.

| Priority | Behavior |
|----------|---------|
| `low` | Shown briefly, auto-dismissed |
| `normal` | Standard display |
| `high` | Persistent until dismissed |

### 9.2 Notification Types (from hooks)

| Hook | Trigger | Message |
|------|---------|---------|
| `usePluginAutoupdateNotification` | Plugin has update | Update available for plugin |
| `useSettingsErrors` | Settings validation errors | Show invalid settings |
| `useRateLimitWarningNotification` | Rate limit approaching | Slow down warning |
| `useFastModeNotification` | Fast mode active | Fast mode indicator |
| `useDeprecationWarningNotification` | Deprecated model | Model deprecation warning |
| `useNpmDeprecationNotification` | npm install deprecated | Use native installer |
| `useAntOrgWarningNotification` | Org config issue | Org-level warning |
| `useInstallMessages` | Install/update | Post-install messages |
| `useChromeExtensionNotification` | Chrome extension state | Chrome ext status |
| `useOfficialMarketplaceNotification` | Marketplace | Official marketplace alert |
| `useLspInitializationNotification` | LSP startup | Language server initializing |
| `useTeammateLifecycleNotification` | Swarm teammate events | Teammate joined/left |
| tmux mouse hint | tmux + fullscreen | One-time hint about scroll |
| Auto-updater result | After update check | Update installed messages |

**File:** `src/screens/REPL.tsx` (lines 800–811, hooks section)

### 9.3 Spinner / Loading Indicator

While a query is running, the spinner area shows:
- **Verb** that changes based on `streamMode`:
  - `requesting` — "Thinking…"  
  - `responding` — "Responding…"  
  - `tool-use` — "Using [tool name]…"
- **Elapsed time** — computed from `loadingStartTimeRef` to avoid re-renders per frame

**File:** `src/components/Spinner.tsx`, `src/screens/REPL.tsx`

### 9.4 Status Line

A compact status line below the spinner showing:
- Current model name
- Permission mode indicator (e.g., "bypass permissions")
- IDE connection status
- Token/context usage bar
- Running task count

**File:** `src/components/StatusLine.tsx`

### 9.5 IDE Status Indicator

Shows connection status to an external editor (VS Code, JetBrains, etc.):
- Connected / disconnected / connecting states

**File:** `src/components/IdeStatusIndicator.tsx`

---

## 10. Permission & Tool Confirmation Flows

### 10.1 Tool Permission Queue

Before executing certain tools, the user must approve them. The REPL maintains a `toolUseConfirmQueue` (a queue of `ToolUseConfirm` objects).

The permission UI renders in the **overlay slot** (inside ScrollBox) so the user can scroll up to see context while deciding.

**File:** `src/components/permissions/` (directory), `src/screens/REPL.tsx` (line ~1144)

### 10.2 Permission Modes

| Mode | Behavior |
|------|---------|
| **Default** | Prompt for each sensitive tool |
| **Bypass** | Never prompt (dangerous mode, shown prominently) |
| **Allowed List** | Auto-approve specific tools |

### 10.3 Sandbox Network Permissions

When Claude tries to access a network host that isn't whitelisted, a `sandboxPermissionRequestQueue` entry is created, prompting:
- "Allow connection to [host pattern]?" Yes / No

**File:** `src/screens/REPL.tsx` (line ~1149)

### 10.4 Prompt Queue

The `promptQueue` handles tool-generated prompts requiring user text input — e.g., "Enter your API key for X service". Rendered as a modal overlay with a text field.

**File:** `src/screens/REPL.tsx` (line ~1153)

### 10.5 Sticky Permission Footer

`permissionStickyFooter` — A sticky JSX node registered by permission request components (e.g., exit-plan-mode). Renders in the `bottom` slot so response options stay visible while the user scrolls a long plan.

**File:** `src/screens/REPL.tsx` (line ~1148), `src/components/FullscreenLayout.tsx`

---

## 11. Session Management UI

### 11.1 Session Picker (LogSelector)

The `<LogSelector>` component is a full-screen interactive list:
- **Search bar** at top with real-time filtering
- **Session rows** with: session title / first message, date, token count, model badge, PR number badge (if linked)
- **"Show all projects"** toggle — loads sessions from all repos
- **Agentic search** — semantic search via AI across sessions
- Scrollable with PgUp/PgDn

**File:** `src/components/LogSelector.tsx` (200KB — very large)

### 11.2 Session Entry Data Displayed

| Field | Source |
|-------|--------|
| Title / first message | `sessionStorage.ts` |
| Date / time | File modification timestamp |
| Model used | Session metadata |
| Token count | Session metadata |
| PR number | Git history / session tag |
| Agent color swatch | Agent metadata |
| Is sidechain | Session metadata (hidden from list) |

### 11.3 Cross-Project Resume Warning

If the user selects a session from a different directory:
1. Command is copied to clipboard automatically
2. Screen shows: "This conversation is from a different directory. To resume, run: `cat-code --resume /path/to/dir`"
3. App exits after 100ms

### 11.4 Session Rename

When `isCustomTitleEnabled()`, the session picker shows a rename option via `onLogsChanged` callback.

### 11.5 Session Forking

`--fork-session` flag creates a new session starting from a resumed session's messages, without adopting the session file.

---

## 12. Agent Mode UI

### 12.1 Agent Mode Status Header

When agent mode is running, a header/status area shows:
- Current agent role
- Steps completed / remaining  
- Token usage for the run
- Start time / elapsed time

**File:** `src/components/AgentModeStatusHeader.tsx`

### 12.2 Orphaned Run Dialog

If a previous agent run was interrupted:
### 12.3 Agent Progress Line

Per-tool progress lines for agent execution, showing:
- Tool name
- Input summary
- Animated spinner while running
- Status indicator when done

**File:** `src/components/AgentProgressLine.tsx`

### 12.4 Coordinator / Swarm Mode

When `COORDINATOR_MODE` feature is enabled, multiple sub-agents run in parallel. The UI shows:
- Individual agent statuses
- Teammate lifecycle notifications
- `CoordinatorAgentStatus.tsx` view

---

## 13. Doctor / Diagnostics Screen

Triggered by `/doctor`. Shows a structured diagnostic report.

### 13.1 Sections Displayed

| Section | Data Shown |
|---------|-----------|
| **Diagnostics** | Installation type, version, package manager, path, invoked binary, config install method, search (ripgrep) status |
| **Warnings** | Configuration issues with fix suggestions |
| **Invalid Settings** | Settings validation errors (non-MCP) |
| **Updates** | Auto-updates status, update permissions, channel, stable/latest versions from npm/GCS |
| **Sandbox** | `SandboxDoctorSection` — sandbox mode status |
| **MCP Parsing Warnings** | `McpParsingWarnings` — MCP config errors |
| **Keybinding Warnings** | `KeybindingWarnings` — conflicting bindings |
| **Environment Variables** | `BASH_MAX_OUTPUT_LENGTH`, `TASK_MAX_OUTPUT_LENGTH`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — validation |
| **Version Locks** | PID-based locking info, stale locks cleaned, active locks |
| **Agent Parse Errors** | Failed agent definition files |
| **Plugin Errors** | Plugin load errors with source/plugin name |
| **Unreachable Permission Rules** | Warn about rules that can never match |
| **Context Usage Warnings** | CLAUDE.md file size, agent size, MCP size — warnings if approaching limits |

**Navigation:** Enter, Esc, Ctrl+C all dismiss the screen.

**File:** `src/screens/Doctor.tsx`

---

## 14. Data Sources

### 14.1 Messages / Transcript

| Data | Source |
|------|--------|
| User messages | User input via PromptInput |
| Assistant messages | API streaming response |
| Tool use/result pairs | Tool execution pipeline |
| Progress messages | Tool execution events |
| System messages | Internal state changes, warnings |
| Initial messages | Session restore (`loadConversationForResume`) |

### 14.2 Session Metadata

| Field | Source File |
|-------|-----------|
| Session ID | `bootstrap/state.ts` |
| Session title | `utils/concurrentSessions.ts` |
| Cost state | `cost-tracker.ts` |
| File history snapshots | `utils/fileHistory.ts` |
| Content replacements | `utils/toolResultStorage.ts` |
| Context collapse commits | `services/contextCollapse/persist.ts` |
| Worktree info | `utils/sessionRestore.ts` |
| Agent setting | `utils/sessionRestore.ts` |

### 14.3 App State (AppState context)

| State Key | Description |
|-----------|-------------|
| `agentDefinitions` | Active/all agent definitions, failed files |
| `mcp.tools` | Tools from MCP servers |
| `mcp.clients` | Connected MCP clients |
| `mcp.commands` | Commands from MCP |
| `toolPermissionContext` | Current permission mode and rules |
| `plugins.errors` | Plugin load errors |
| `standaloneAgentContext` | Current agent name and color |
| `agent` | Current agent type |

### 14.4 Configuration

| Config | Location |
|--------|---------|
| User settings | `~/.claude/settings.json` |
| Project settings | `.claude/settings.json` |
| Claude MD instructions | `CLAUDE.md`, `.claude/CLAUDE.md` |
| Agent definitions | `~/.claude/agents/`, `.claude/agents/` |
| MCP server config | Settings files |
| Theme | User settings |
| Vim mode | User settings |
| Auto-update channel | User settings |

### 14.5 Diagnostic Data Sources

| Data | Source |
|------|--------|
| Installation type, version | `utils/doctorDiagnostic.ts` |
| npm dist tags | npm registry API |
| GCS dist tags | Google Cloud API |
| Context warnings | `utils/doctorContextWarnings.ts` |
| Version lock info | `utils/nativeInstaller/pidLock.ts` |

---

## 15. Main User Flows

### 15.1 Fresh Start Flow

```
1. cli.tsx: Parse flags
2. Trust dialog (if new directory)
3. Onboarding (if first run)
4. API Key / OAuth (if no credentials)
5. REPL mounts → startup checks run (performStartupChecks)
6. Notifications populate (plugin updates, settings errors, etc.)
7. User enters prompt → submits
8. Query runs (Spinner shows, `isLoading=true`)
9. Streaming response renders in transcript
10. Tool permissions requested if needed
11. Tool executes, result renders
12. Response completes → Spinner hides, `isLoading=false`
13. Prompt input re-focuses
```

### 15.2 Resume Session Flow

```
1. User runs `--resume` flag or `/resume` command
2. ResumeConversation shows LogSelector
3. User searches / selects a session
4. loadConversationForResume() → messages restored
5. Cost state restored
6. Agent/worktree context restored
7. Context collapse state restored
8. REPL mounts with initialMessages
9. Session continues from restored state
```

### 15.3 Permission Request Flow

```
1. Claude calls a tool requiring permission
2. toolUseConfirmQueue receives entry
3. PermissionRequest renders in overlay slot
4. User can scroll up to see context
5. User approves (y/Enter) or rejects (n/Esc)
6. Resolved promise unblocks tool execution
7. Tool runs, result streams back
```

### 15.4 Agent Mode Flow

```
1. User invokes agent mode (command or flag)
2. Agent executes: AgentModeStatusHeader shows
3. Per-step progress via AgentProgressLine
4. Per-tool permission prompts as needed
5. Run completes or user interrupts
```

### 15.5 Slash Command Flow

```
1. User types "/" in prompt
2. SuggestionsOverlay appears above input
3. User navigates with arrows or continues typing
4. User selects command (Tab/Enter)
5. Non-dialog commands: execute immediately, output appended
6. Dialog commands: modal/overlay renders
7. Dialog dismissed → REPL resumes
```

### 15.6 Scroll / History Navigation

```
1. User scrolls up (wheel, PgUp, Ctrl+U)
2. StickyPromptHeader appears (shows current prompt context)
3. If new messages arrive: NewMessagesPill appears
4. User reads history
5. User clicks pill or scrolls to bottom → repin
6. Divider clears, StickyPromptHeader hides, pill disappears
```

---

## 16. Special States & Edge Cases

### 16.1 Loading / Processing States

| State | Visual |
|-------|--------|
| Query running | Spinner with verb + elapsed time |
| Tool executing | Spinner verb changes to tool name |
| Auto-updating | AutoUpdater overlay |
| Remote session initializing | `isExternalLoading=true`, spinner |
| Background task foregrounding | External loading spinner |

### 16.2 Interrupt Handling

- **Ctrl+C during query**: `abortController.abort()` called → query cancels → message shows "Interrupted by user"
- **Ctrl+C during dialog**: Cancels dialog (context-dependent)
- **Ctrl+C in no-conversations screen**: `process.exit(1)`
- **Ctrl+C on Cross-Project message**: Triggers exit after 100ms

### 16.3 Error States

| Error | Display |
|-------|---------|
| API error | Error message in transcript |
| Tool error | `FallbackToolUseErrorMessage.tsx` |
| Tool rejected | `FallbackToolUseRejectedMessage.tsx` / tool-specific rejected messages |
| Settings invalid | `InvalidSettingsDialog.tsx` or `InvalidConfigDialog.tsx` |
| Plugin error | Shown in Doctor screen + notification |
| Agent parse error | Shown in Doctor screen |
| Rate limit | `TokenWarning.tsx`, notification |
| Cost threshold exceeded | `CostThresholdDialog.tsx` |

### 16.4 Empty States

| Context | Empty State |
|---------|-----------|
| No sessions to resume | "No conversations found to resume. Press Ctrl+C to exit and start a new conversation." |
| No notifications | No notification bar shown |
| Fresh conversation | "How can I help you?" placeholder (or custom) |
| Doctor – no active version locks | "└ No active version locks" |

### 16.5 IDE / Remote Mode States

| State | Visual |
|-------|--------|
| IDE connected | `IdeStatusIndicator` shows connected |
| IDE disconnected | Indicator shows disconnected / reconnecting |
| Remote session | Some features disabled (`isRemoteSession` gates) |
| MCP clients absent | Empty tool/command lists |

### 16.6 Prompt Deferred While Typing

Permission dialogs are held for `1500ms` after the last keystroke (suppression window) to prevent accidental dismissal via rapid typing. `isPromptInputActive` gates dialog display.

### 16.7 tmux Scroll Hint

In fullscreen mode inside tmux with `mouse off`, a one-time notification: "Mouse scrolling is disabled in tmux…" explains why wheel events don't work.

### 16.8 "Undercover" Callout

Internal/ant builds show a special callout when detecting an internal model repo (`shouldShowUndercoverAutoNotice`). External builds never see this.

---

## 17. Must-Preserve Checklist for Web UI

The following are the **non-negotiable behaviors** that must be preserved in a web rebuild:

### Core Interaction Model
- [ ] Multi-turn conversation with persistent transcript
- [ ] Real-time streaming of assistant responses (token-by-token)
- [ ] Interrupt / cancel in-progress response (Escape or button)
- [ ] Sticky scroll: auto-follows bottom, but preserves user scroll position
- [ ] "N new messages" pill when scrolled up and new messages arrive
- [ ] Sticky context header showing the current prompt when scrolled up

### Input & Environment UX
- [ ] Multi-line prompt composition (Shift+Enter support)
- [ ] Slash command autocomplete with real-time dropdown filtering
- [ ] `@` mention / context file autocomplete
- [ ] Prompt history navigation (Up/Down arrow)
- [ ] Dynamic Context Badging (show Fast Mode ↯ or Agent Mode status in footer)
- [ ] Input mode toggling (Vi/Vim keybinding power-user defaults)
- [ ] Large payload guard (paste confirmation dialog)

### Message & Logging Pipeline
- [ ] Distinct visual layout architecture for User vs System vs Assistant messages
- [ ] Frame-driven animated loaders (Spinners / Progress dots for tools)
- [ ] Visual collapsing of repetitive system outputs (e.g. `[Read 4 files]`)
- [ ] Collapsing tree layout for background sub-agent execution logs
- [ ] Streaming `thinking...` indicator block (auto-hide after 30 seconds)
- [ ] Split-pane, syntax-highlighted Diff renderer for code modifications
- [ ] Markdown pipeline (Headers, standard lists, tables)
- [ ] Translucent floating timestamps per message
- [ ] Embedded dynamic payload parsing (Render local `[Image #X]` natively without breaking AST)

### Screen & Dialog Overlays
- [ ] Absolute-pinned Slash Command overlay popup
- [ ] Non-blocking Permission request layouts (queued securely in the background)
- [ ] Sticky permission Footer (remains visible even when scrolling the transcript)
- [ ] Exclusive Tool-overlay hooks (hides the input block entirely during complex setups)
- [ ] API Key capture secure wizard configuration

### Time & Session Restoration
- [ ] Session restore picker layout (`/resume`) with fuzzy search UI
- [ ] PR-branch specific session filtering
- [ ] Hard Cross-project awareness (re-direct when bouncing projects)
- [ ] Restoring partial states on wake: messages, running cost, read-group collapses, and git-worktree caches
- [ ] Historical Forking (Rewind `Ctrl+U`) logic exposing a regret-calculator (What code will be lost if you rewind)

### Integrations (MCP/System)
- [ ] Global Diagnostic check (`/doctor`) rendering static health validations
- [ ] MCP Connection list managing distinct Web/Local server targets (`MCPSettings`)
- [ ] Elicitation Overlay: Parse external JSON schemas into dynamically typed interactive web forms.
- [ ] Elicitation Web behaviors: Y/N typeaheads, Accordion dropdowns, and 2000ms Date-Time parsing spinners

### Feedback & Notifications
- [ ] Z-index floating `Notification` framework (toast popups over input)
- [ ] Rate limit & token limit starvation warnings
- [ ] Version deprecation or auto-update flow configurations
- [ ] Cost threshold override dialog

### Keyboard Native
- [ ] Global interrupt (`Ctrl+C`) breaking any network stream instantly
- [ ] Keybinding conflict context-depth (Dialogs aggressively steal focus)
- [ ] PgUp/PgDn, Ctrl+U reserved specifically for transcript scroll jumps
- [ ] `Y/N` macro listeners on all confirmation dialog forms

### Structural Layout / UX Parity
- [ ] `Ratchet` hook configuration ensuring viewport minimums never jump downward
- [ ] Context-aware elapsed time indicators injected directly beside spinners
- [ ] Verbose vs Brief footprint configurations
- [ ] Auto-managed Color Theming dictionary (`claude` vs `autoAccept` brand colors)

---

## 18. StatusLine — Full Data Schema

`StatusLine` (`src/components/StatusLine.tsx`) is a **hook-driven, debounced** component that calls a user-configurable shell command (`settings.statusLine.command`) and renders its stdout as ANSI text. The data passed to that command (the `StatusLineCommandInput` object) contains:

| Field | Source |
|-------|--------|
| `model.id` / `model.display_name` | `useMainLoopModel()` → AppState |
| `effortLevel` | `getDisplayedEffortLevel()` from model and AppState effort |
| `workspace.current_dir` | `getCwd()` |
| `workspace.project_dir` | `getOriginalCwd()` |
| `workspace.added_dirs` | `toolPermissionContext.additionalWorkingDirectories` |
| `version` | Build macro |
| `output_style.name` | `settings.outputStyle` |
| `cost.total_cost_usd` | `getTotalCost()` |
| `cost.total_duration_ms` | `getTotalDuration()` |
| `cost.total_api_duration_ms` | `getTotalAPIDuration()` |
| `cost.total_lines_added/removed` | `getTotalLinesAdded/Removed()` |
| `context_window.total_input_tokens` | `getTotalInputTokens()` |
| `context_window.total_output_tokens` | `getTotalOutputTokens()` |
| `context_window.context_window_size` | `getContextWindowForModel(model)` |
| `context_window.used_percentage` | Calculated |
| `exceeds_200k_tokens` | `doesMostRecentAssistantMessageExceed200k()` |
| `rate_limits.five_hour` / `seven_day` | `getRawUtilization()` |
| `vim.mode` | Current VimMode |
| `agent.name` | `getMainThreadAgentType()` |
| `remote.session_id` | `getSessionId()` |
| `worktree.*` | `getCurrentWorktreeSession()` |
| `active_profile` | `getCodexLeaseSnapshot()` / `getPoolStatus()` |
| `session_name` | `getCurrentSessionTitle(sessionId)` |

**Trigger conditions for StatusLine refresh:**
- `lastAssistantMessageId` changes (new assistant turn)
- `latestUsageSignature` changes (token counts during streaming)
- `permissionMode` changes
- `vimMode` changes
- `mainLoopModel` changes
- `effortValue` changes
- `statusLineRefreshKey` bumped externally (e.g. `/switch-account`)
- StatusLine command text changes (hot reload via settings)

**Quirks:**
- In fullscreen, the StatusLine must always occupy 1 row (renders a `<Text> </Text>` space-row while loading) to prevent footer height jitter that would steal rows from the ScrollBox.
- Debounced at 300ms; in-flight calls are aborted before re-issuing.
- Suppressed when `settings.statusLine === undefined`.
- Hidden entirely in KAIROS assistant mode.

**File:** `src/components/StatusLine.tsx`

---

## 19. PromptInputFooter — Region Decomposition

The footer region below the prompt input is composed of three distinct sub-regions:

```
┌──────────────────────────────────────────────────┐
│ [StatusLine]   ← appears above footer row if configured   │
│ [PromptInputFooterLeftSide]   [Notifications / BridgeStatus] │
│ [CoordinatorTaskPanel]  ← ant-only, rows of agent tasks   │
└──────────────────────────────────────────────────┘
```

### PromptInputFooterLeftSide Content (`src/components/PromptInput/PromptInputFooterLeftSide.tsx`)

This component renders a single **1-row** left-aligned status bar. It handles several mutually exclusive states in priority order:

1. **Exit confirmation** — `"Press [key] again to exit"`
2. **Pasting** — `"Pasting text…"` (during large paste confirmation)
3. **Ctrl+R searching** — `HistorySearchInput` with live query
4. **Vim INSERT mode** — `"-- INSERT --"` (when cursor is editing)
5. **Standard mode indicator** — composed of:
   - `modePart` — permission mode symbol + title (e.g. `◆ bypass on`)
   - `tasksPart` — `BackgroundTaskStatus` pill (running tasks)
   - `parts[]` — optional array of status items including:
     - Remote session URL (linkable)
     - Tmux session pill (ant-only)
     - Teams status
     - PR badge (if linked PR)
     - Proactive countdown timer
     - Spinner hint (`esc to interrupt`, `ctrl+t show tasks`, `ctrl+x ctrl+k stop agents`)
     - Selection copy / native-select hints (fullscreen + xterm.js)
     - Voice warmup hint (VOICE_MODE)
     - `"? for shortcuts"` fallback hint

**Navigation items in the footer** (keyboard-selectable with Tab):
- `tasksSelected` — tasks pill highlighted; Enter opens task dialog
- `teamsSelected` — teams status highlighted
- `bridgeSelected` — bridge status highlighted; Entry → bridge view
- `tmuxSelected` — tmux pill selected

**Width responsiveness:** When terminal `columns < 80`, layout switches to `column` direction (stacks left and right sections).

### Notifications Column (`src/components/PromptInput/Notifications.tsx`)

Right-aligned column (or left-start in narrow mode). Renders in priority order:
1. **VoiceIndicator** — replaces all notifications during `recording`/`processing` voice state
2. **IdeStatusIndicator** — IDE connection badge
3. **Current notification** — from `notifications.current` (queue, one at a time, with text or JSX variants)
4. **Overage mode banner** — `"Now using extra usage"` (non-team/enterprise accounts)
5. **apiKeyHelper slow** — `"apiKeyHelper is taking a while (Xs)"` (10s threshold)
6. **Auth error** — `"Not logged in · Run /login"` or `"Authentication error"` in remote
7. **Debug mode** — `"Debug mode"` warning
8. **Verbose token count** — `"N tokens"` (when `--verbose`)
9. **TokenWarning** — compact context fill warning bar
10. **AutoUpdaterWrapper** — update available / update success
11. **Voice error** — voice system error text
12. **MemoryUsageIndicator** — memory usage gauge
13. **SandboxPromptFooterHint** — sandbox status hint

### BridgeStatusIndicator (`src/components/PromptInput/PromptInputFooter.tsx`)

Shows remote control status:
- Hidden if bridge not enabled or `!enabled`
- For implicit (config-driven) remote: shows only `"Remote Control reconnecting"` state
- For explicit remote: shows label from `getBridgeStatus()`
- When `bridgeSelected`: highlights with inverse color + `"· Enter to view"` hint

**File:** `src/components/PromptInput/PromptInputFooter.tsx`, `PromptInputFooterLeftSide.tsx`, `Notifications.tsx`

---

## 20. Dialog Priority Queue (Full List)

`getFocusedInputDialog()` in `REPL.tsx` returns the single dialog to display (highest priority wins). The full ranked priority list is:

| Priority | Dialog Key | Condition |
|----------|------------|-----------|
| 1 | `tool-permission` | `toolUseConfirmQueue[0]` exists |
| 2 | `prompt` | `promptQueue[0]` exists |
| 3 | `worker-sandbox-permission` | `workerSandboxPermissions.queue[0]` exists |
| 4 | `elicitation` | `elicitation.queue[0]` exists |
| 5 | `cost` | `showingCostDialog` |
| 6 | `idle-return` | `idleReturnPending` |
| 7 | `ultraplan-choice` | `ultraplanPendingChoice` (ULTRAPLAN feature) |
| 8 | `ultraplan-launch` | `ultraplanLaunchPending` (ULTRAPLAN feature) |
| 9 | `ide-onboarding` | `showIdeOnboarding` |
| 11 | `model-switch` | `showModelSwitchCallout` (ant-only) |
| 12 | `undercover-callout` | `showUndercoverCallout` (ant-only) |
| 13 | `effort-callout` | `showEffortCallout` |
| 14 | `remote-callout` | `showRemoteCallout` |
| 15 | `lsp-recommendation` | `lspRecommendation` |
| 16 | `plugin-hint` | `hintRecommendation` |
| 17 | `desktop-upsell` | `showDesktopUpsellStartup` |
| — | `undefined` | No dialog showing |

**Key gate:** All dialogs are suppressed (`allowDialogsWithAnimation=false`) while `toolJSX` is shown AND `toolJSX.shouldContinueAnimation` is false. This prevents background dialogs from popping up during fullscreen tool UI.

**Suppressed dialogs during typing:** `hasSuppressedDialogs` is true when the user is actively typing (`isPromptInputActive`) and there are pending permission/cost dialogs. They appear only after the `PROMPT_SUPPRESSION_MS=1500` typing debounce timer expires.

**File:** `src/screens/REPL.tsx` lines 2395–2437

---

## 21. Escape / Cancel Flow

The `onCancel()` function in `REPL.tsx` handles all cancel/interrupt scenarios:

```
User presses Esc / Ctrl+C
  ↓
hasSuppressedDialogs? → show dialog (don't cancel query)
  ↓
No dialog active? → abort query (abortController.abort('user-cancel'))
  ↓
Dialog = 'elicitation' → no-op (dialog manages its own close)
  ↓
agentModeAbortPending? → clear pending (Esc twice = hard cancel)
  ↓
activeAgentModeRun (not waiting for input)? → set agentModeAbortPending=true
    • Shows abort confirmation: press 'a' to confirm, Esc to cancel
  ↓
Dialog = 'tool-permission' → toolUseConfirmQueue[0].onAbort() → clear queue
  ↓
Dialog = 'prompt' → reject all prompt queue entries; abort controller
  ↓
Remote mode? → activeRemote.cancelRequest()
  ↓
Default → abortController.abort('user-cancel')
```

**Auto-restore on cancel:** After abort, if the user cancelled before meaningful response arrived, the system automatically rewinds the conversation to the last user message (pops from history, calls `restoreMessageSyncRef`). Guards:
- `abortController.signal.reason === 'user-cancel'` (not `background`/programmatic)
- `!queryGuard.isActive` (no newer query started)
- `inputValueRef.current === ''` (nothing typed during loading)
- `getCommandQueueLength() === 0` (no queued commands)
- `!store.getState().viewingAgentTaskId` (not viewing teammate)

**Streaming text preservation:** If text was partially streamed before cancel, it is preserved as an immutable assistant message before the `[Request interrupted by user]` system message.

**File:** `src/screens/REPL.tsx` lines 2479–2559

---

## 22. Session Backgrounding (Ctrl+B)

The `handleBackgroundQuery()` function transfers a running session to the background:

```
User presses Ctrl+B
  ↓
Abort current foreground query ('background' reason)
  ↓
Remove task-notification commands from queue
  ↓
Build full tool context for background session
  ↓
Generate system prompt, user context, system context
  ↓
startBackgroundSession({
  messages: [...current messages, ...notifications],
  queryParams: { systemPrompt, userContext, ... },
  description: terminalTitle,
})
  ↓
Background session runs independently
  ↓
Foreground returns to idle prompt
```

**Key nuance:** Notifications queued between the abort and the background handoff are deduplicated against messages already in the transcript (via `promptText` comparison) to prevent double-showing.

**File:** `src/screens/REPL.tsx` lines 3076–3136

---

## 23. Full Query Lifecycle (`onQuery` → `onQueryImpl`)

### Phase 1: `onQuery` — concurrency guard + setup
```
1. swarm: mark teammate as active
2. queryGuard.tryStart() → null if already running → enqueue user message, return
3. resetTimingRefs()
4. setAgentModeApprovalPending(null)
5. setMessages([...older, ...newMessages])  ← append user message
6. responseLengthRef.current = 0
7. parse token budget from input (TOKEN_BUDGET feature)
8. clearStreamingToolUses(), clearStreamingText()
9. await mrOnBeforeQuery()  ← UserPromptSubmit hooks, pre-query hooks
10. await onBeforeQueryCallback? ← caller-supplied gate
11. call onQueryImpl(...)
```

### Phase 2: `onQueryImpl` — system prompt + query loop
```
1. handleQueryStart() ← IDE/MCP integration notification
2. closeOpenDiffs() ← IDE cleanup
3. maybeMarkProjectOnboardingComplete()
4. generateSessionTitle() ← Haiku call (first message only, once per session)
5. update toolPermissionContext.alwaysAllowRules.command ← skill tools
6. getToolUseContext() ← fresh tools, clients, models from store.getState()
7. [Agent Mode branch]: launch orchestrator → await runOrchestrator() → return
8. [Normal branch]:
   a. checkAndDisableBypassPermissionsIfNeeded()
   b. checkAndDisableAutoModeIfNeeded() (TRANSCRIPT_CLASSIFIER)
   c. getSystemPrompt() ← full system prompt assembly
   d. getAgentModeSystemPromptSections() ← if agent mode
   e. getUserContext()
   f. getSystemContext()
   g. buildEffectiveSystemPrompt()
9. for await (event of query({...})) → onQueryEvent(event)
10. fireCompanionObserver() (BUDDY feature)
11. record API metrics (ant-only)
12. resetLoadingState()
13. await onTurnComplete?.(messages)
```

### Phase 3: `onQuery` finally — cleanup
```
1. queryGuard.end(generation) → if generation still current:
   a. setLastQueryCompletionTime()
   b. resetLoadingState()
   c. await mrOnTurnComplete() ← PostToolExecution, PostResponse hooks
   d. sendBridgeResultRef() ← notify bridge clients
   e. auto-hide tungsten panel (ant-only, non-abort)
   f. record token budget info (TOKEN_BUDGET)
   g. add turn duration message if >30s
   h. setAbortController(null)
2. auto-restore on user-cancel (if conditions met, see §21)
```

**Streaming event relay:** Each streaming delta is also emitted to `webUIBus` (`emitToWeb({ type: 'delta', delta: text })`), and complete messages emit `{ type: 'message', ... }`. This is the live web UI bus bridge.

**File:** `src/screens/REPL.tsx` lines 3237–3789

---

## 24. Immediate / `local-jsx` Commands

Commands with `type: 'local-jsx'` and `immediate: true` (like `/btw`) intercept the submit path before the regular query loop:

```
User submits "/btw [text]" while Claude is responding
  ↓
onSubmit sees: trimmed input starts with "/" AND queryGuard.isActive
  ↓
matchingCommand.type === 'local-jsx' AND shouldTreatAsImmediate
  ↓
clearBuffer if input matches current prompt value
  ↓
Log tengu_immediate_command_executed with fromKeybinding flag
  ↓
executeImmediateCommand() runs:
  • setToolJSX({ jsx: <CommandUI />, shouldHidePromptInput: false, ... })
  • Command UI shown as overlay while Claude continues streaming
  ↓
onDone(result?, options?) called by command:
  • If result & display !== 'skip': addNotification({ priority: 'immediate' })
  • In fullscreen: skip message transcript entry (notification only)
  • setToolJSX({ jsx: null, clearLocalJSX: true })
  • If not isLoading: append message + trigger query
```

**Queued commands while loading:** Non-immediate slash commands and regular prompts typed while Claude is loading are stored via `enqueue()` and processed after the current turn completes via the `useCommandQueue` hook.

**File:** `src/screens/REPL.tsx` lines 3908–3999, `src/components/PromptInput/PromptInput.tsx`

---

## 25. VirtualMessageList — Scroll & Search Engine

### 25.1 Key Architecture Decisions

- Two-mode rendering: fullscreen → `VirtualMessageList` (virtualised); non-fullscreen → plain `.map()` in `Messages.tsx`
- Two-phase jump: `jump(i)` → `scrollToIndex(i)` (mounts item) → `seekGen` bump → passive effect fires post-paint → `scanElement(el)` → `highlight(ord)`
- `SCROLL_QUANTUM=40` coarse re-render budget for the list proper; **`StickyTracker` subscribes at fine (unquantised) granularity** in a separate component so the sticky header can update every tick without Yoga relayout
- **Incremental key array**: streaming appends one message at a time; rebuilding the full string array each commit would be O(n). The component delta-pushes new keys unless compaction/clear happens (prefix mismatch or length decrease)

### 25.2 JumpHandle API (imperative ref)

| Method | Description |
|--------|-------------|
| `jumpToIndex(i)` | Non-search jump (sticky header click). No scan, no highlight positions |
| `setSearchQuery(q)` | Incsearch: builds match list, jumps to nearest match to anchor. Anchor = last stored `setAnchor()` position, or current `scrollTop` |
| `nextMatch()` / `prevMatch()` | Step forward/back through matches; wraps with wrap-guard |
| `setAnchor()` | Capture current `scrollTop` as incsearch anchor (called on `/` press) |
| `disarmSearch()` | Manual scroll exits search context; clears position overlays |
| `warmSearchIndex()` | Async: pre-lowers all message text in 500-item chunks with `sleep(0)` yields; returns elapsed ms |

### 25.3 MessageActionsNav API (cursor navigation)

| Method | Description |
|--------|-------------|
| `enterCursor()` | Enter message-action cursor from outside (Shift+↑) → selects last user message |
| `navigatePrev()` / `navigateNext()` | Move cursor up/down through navigable messages |
| `navigatePrevUser()` / `navigateNextUser()` | Jump only between user messages (skips tool/assistant) |
| `navigateTop()` / `navigateBottom()` | Jump to first/last navigable message |
| `getSelected()` | Returns current cursor message |

### 25.4 StickyTracker Algorithm

```
Per scroll tick (unquantised):
  1. Walk mounted range backward from end to find firstVisible 
     (first item whose top >= scrollTop)
  2. Walk backward from firstVisible-1 to find last user prompt above viewport
  3. Skip if prompt's ❯ is still visible (top+1 >= scrollTop) — would duplicate
  4. setStickyPrompt({ text: firstParagraph(prompt, 500 chars), scrollTo })
  
On scrollTo() (header click):
  1. setStickyPrompt('clicked') → hides header, collapses padding to 0
  2. scrollToElement(el) if mounted; else scrollTo(estimate) and set pending
  3. Correction effect re-anchors by element once it mounts (max 5 retries)
```

**Sticky text rules:** First paragraph only (split on blank line); max 500 chars; whitespace collapsed; strips `<system-reminder>` prefixes; excludes meta/transcript-only messages.

**File:** `src/components/VirtualMessageList.tsx`

---

## 26. Per-Tool Permission UI Catalog

All permission UIs receive the `PermissionRequestProps` interface and optionally call `setStickyFooter(jsx)` to pin response controls while the user scrolls context.

**Shared behavior (all UIs):**
- `useNotifyAfterTimeout(message, 'permission_prompt')` — if the dialog is still open after a timeout, adds a system notification (for backgrounded terminals)
- `useKeybinding('app:interrupt', onReject, { context: 'Confirmation' })` — Ctrl+C always rejects
- `classifierCheckInProgress` prop → disables auto-dismissal while async bash classifier runs
- `classifierAutoApproved` prop → shows a ✓ checkmark auto-approval animation before dismissing

| Component | Tool(s) | Key UI Elements |
|-----------|---------|-----------------|
| `BashPermissionRequest` | `BashTool` | Command preview, risk level, "Allow once / Always allow / Reject" options, rule editor |
| `PowerShellPermissionRequest` | `PowerShellTool` | Same as Bash, PowerShell-labelled |
| `FileEditPermissionRequest` | `FileEditTool` | Diff preview, file path, rule options |
| `FileWritePermissionRequest` | `FileWriteTool` | File path, content preview (truncated), rule options |
| `FilesystemPermissionRequest` | `FileReadTool`, `GlobTool`, `GrepTool` | Path pattern, whitelisting options |
| `WebFetchPermissionRequest` | `WebFetchTool` | URL display, domain-level or exact allow options |
| `NotebookEditPermissionRequest` | `NotebookEditTool` | Cell index, code preview |
| `AskUserQuestionPermissionRequest` | `AskUserQuestionTool` | Freeform text input field (prompt queue variant) |
| `EnterPlanModePermissionRequest` | `EnterPlanModeTool` | Confirmation only — "Claude wants to enter plan mode" |
| `ExitPlanModePermissionRequest` | `ExitPlanModeV2Tool` | Full plan text (scrollable), sticky footer with Yes/No, cost estimate |
| `SkillPermissionRequest` | `SkillTool` | Skill name, description of what it runs |
| `WorkflowPermissionRequest` | `WorkflowTool` (feature-gated) | Workflow name, step summary |
| `MonitorPermissionRequest` | `MonitorTool` (feature-gated) | Monitor description |
| `ReviewArtifactPermissionRequest` | `ReviewArtifactTool` (feature-gated) | Artifact content view |
| `SandboxPermissionRequest` | Network sandbox | Host pattern, allow/deny for this session or always |
| `FallbackPermissionRequest` | All other MCP/unknown tools | Generic tool name + description, allow/reject |
| `WorkerPendingPermission` | Agent swarm | Shows which teammate is waiting, with `WorkerBadge` |

**PermissionDecision fields passed to each UI:**
- `permissionResult` — the computed decision (`allow` / `deny` / `ask`) with rule match info
- `permissionPromptStartTimeMs` — for analytics (time-to-decision)
- `classifierMatchedRule` — which auto-allow rule (if any) matched

**File:** `src/components/permissions/` (directory)

---

## 27. Bridge / Remote Control Protocol

The `replBridge.ts` module implements the **Web Remote Control** architecture — the path by which `claude.ai` communicates with a running terminal session.

### 27.1 Architecture Overview

```
claude.ai (browser)
    ↕  HTTPS/WSS
Anthropic Bridge Server  (environments API)
    ↕  poll + ingress WebSocket
replBridge.ts (in-process)
    ↕  in-process callbacks
REPL.tsx (UI state)
```

### 27.2 Bridge Lifecycle

```
1. REPL mounts → initReplBridge() called
2. registerBridgeEnvironment() → environment_id + environment_secret
3. writeBridgePointer(dir, { sessionId, environmentId }) → crash-recovery file
4. createSession({ environmentId, title, gitRepoUrl, branch }) → sessionId
5. Poll loop starts: GET /v1/environments/{env_id}/work/poll (10s long-poll)
6. Work arrives → WorkResponse with sessionToken
7. acknowledgeWork() → POST .../work/{workId}/ack
8. heartbeat loop starts: POST .../work/{workId}/heartbeat every N seconds
9. Transport connects (v1: HybridTransport/WebSocket, v2: SSETransport+CCRClient)
10. Initial messages flushed via ingress WebSocket (FlushGate serialises with live writes)
11. Session active — bidirectional message flow
12. On teardown: stopWork() → deregisterEnvironment() → clearBridgePointer()
```

### 27.3 Transport Message Types

**Inbound (from claude.ai → REPL):**
| Event Type | Triggers |
|-----------|---------|
| User message (prompt) | `onInboundMessage(sdkMsg)` → REPL submits query |
| `control_request: set_model` | `onSetModel(model)` |
| `control_request: set_max_thinking_tokens` | `onSetMaxThinkingTokens(tokens)` |
| `control_request: set_permission_mode` | `onSetPermissionMode(mode)` |
| `control_request: permission_request` | Queued to `toolUseConfirmQueue` via REPL |
| `control_request: interrupt` | `onInterrupt()` → abort current query |

**Outbound (REPL → claude.ai):**
| Method | Description |
|--------|-------------|
| `handle.writeMessages(messages)` | Send transcript delta (internal `Message[]` → `SDKMessage[]`) |
| `handle.writeSdkMessages(sdkMessages)` | Send SDK messages directly (daemon path) |
| `handle.sendControlResponse(response)` | Send permission decision or other control ACK |
| `handle.sendControlRequest(request)` | Send control request to web client |
| `handle.sendResult()` | Signal turn completion |

### 27.4 `ReplBridgeHandle` Interface

```typescript
type ReplBridgeHandle = {
  bridgeSessionId: string        // currentSessionId (may change on reconnect)
  environmentId: string
  sessionIngressUrl: string
  writeMessages(messages: Message[]): void
  writeSdkMessages(messages: SDKMessage[]): void
  sendControlRequest(request: SDKControlRequest): void
  sendControlResponse(response: SDKControlResponse): void
  sendControlCancelRequest(requestId: string): void
  sendResult(): void
  teardown(): Promise<void>
}
```

### 27.5 Permission Response Path

When REPL resolves a permission dialog, it calls:
```
toolUseConfirm.onAllow(updatedInput, permissionUpdates) 
  → bridge.sendPermissionResponseEvent(sessionId, {
      type: 'control_response',
      response: { subtype: 'success', request_id, response: { behavior: 'allow' } }
    })
  → POST /v1/sessions/{sessionId}/events
```

### 27.6 Reconnection Strategy

On poll 404 (environment reaped):
1. **Strategy 1 — Reconnect in place**: re-register with `reuseEnvironmentId`, call `reconnectSession()` if same env returned. Session URL unchanged, no history re-flush.
2. **Strategy 2 — Fresh session**: archive old session, `createSession()` on new env. `previouslyFlushedUUIDs` reset; SSE sequence-num reset to 0.

Max 3 environment re-creations before giving up and calling `onStateChange('failed')`.

**Perpetual mode** (daemon/background): bridge pointer NOT cleared on teardown; next start reads it and calls `tryReconnectInPlace()` before `createSession()`.

### 27.7 Impact on Web UI Rebuild

The bridge is a **separate integration point** from rebuilding the terminal UI. Two paths:

| Option | Description |
|--------|-------------|
| **Standalone web UI** | Implement the API calls directly; bridge gives you the `SDKMessage` wire format |
| **Bridge to existing process** | Connect to a running terminal session via `replBridgeTransport.ts`; inbound/outbound messages already defined |

The bridge handles: permission decisions over the network, model switching, permission mode changes, and interrupt — all via `SDKControlRequest`/`SDKControlResponse`.

**File:** `src/bridge/replBridge.ts`, `src/bridge/bridgeApi.ts`, `src/bridge/types.ts`, `src/bridge/bridgeMessaging.ts`

---

## 28. Full Slash-Command Registry

Commands are loaded from multiple sources at startup and filtered per user/session. The command pipeline is:

```
loadAllCommands(cwd)
  → bundledSkills + builtinPluginSkills + skillDirCommands
  + workflowCommands + pluginCommands + pluginSkills
  + COMMANDS() (builtin registry below)
  → meetsAvailabilityRequirement() filter
  → isCommandEnabled() filter
  → getDynamicSkills() dedup-inserted
```

### 28.1 Core Built-in Commands

| Command | Type | Description |
|---------|------|-------------|
| `/help` | local-jsx | Show help overlay |
| `/clear` | local | Clear transcript |
| `/compact` | local | Compact context window |
| `/config` | local-jsx | Settings panel |
| `/model` | local-jsx | Model picker |
| `/exit` | local | Exit the process |
| `/cost` | local | Show session cost |
| `/usage` | local | Show usage info |
| `/doctor` | local-jsx | Diagnostic screen |
| `/memory` | local-jsx | Edit CLAUDE.md memory files |
| `/context` | local-jsx | Show context window content |
| `/copy` | local | Copy last response |
| `/resume` | local-jsx | Resume a past conversation |
| `/rename` | local | Rename current session |
| `/diff` | local-jsx | Show file diffs |
| `/files` | local | List tracked files |
| `/mcp` | local-jsx | MCP server management |
| `/ide` | local-jsx | IDE toggle |
| `/keybindings` | local-jsx | Keybinding management UI |
| `/permissions` | local-jsx | Permission rules manager |
| `/plan` | local | Toggle plan mode |
| `/status` | local | Show session status |
| `/session` | local-jsx | Show QR code / remote URL |
| `/mobile` | local-jsx | QR code for mobile |
| `/vim` | local | Toggle vim mode |
| `/theme` | local-jsx | Theme picker |
| `/color` | local | Change agent color |
| `/skills` | local-jsx | List/manage skills |
| `/agents` | local-jsx | List/manage agents |
| `/agent` | local-jsx | Configure specific agent |
| `/plugin` | local-jsx | Plugin manager |
| `/reload-plugins` | local | Reload plugin registry |
| `/hooks` | local-jsx | Hooks configuration |
| `/review` | prompt | Review changes |
| `/rewind` | local-jsx | Rewind to a past message |
| `/export` | local | Export conversation |
| `/init` | local | Initialize project (CLAUDE.md) |
| `/feedback` | local-jsx | Send feedback |
| `/upgrade` | local | Check for upgrades |
| `/login` / `/logout` | local | Auth management (1P only) |
| `/release-notes` | local | Show changelog |
| `/tasks` | local-jsx | Task list manager |
| `/runs` | local-jsx | Agent run history |
| `/stats` | local | Performance stats |
| `/effort` | local-jsx | Effort/thinking toggle |
| `/output-style` | local-jsx | Output style picker |
| `/privacy-settings` | local-jsx | Privacy config |
| `/passes` | local-jsx | Claude.ai passes management |
| `/sandbox-toggle` | local | Toggle network sandbox |
| `/btw` | local-jsx | Inline note (immediate command) |
| `/add-dir` | local | Add directory to context |
| `/branch` | local-jsx | Branch operations |
| `/pr-comments` | local-jsx | View PR comments |
| `/rate-limit-options` | local-jsx | Rate limit options |
| `/thinkback` | local-jsx | Thinking mode config |
| `/fast` | local | Toggle fast mode |
| `/summary` | local | Summarize conversation |
| `/stickers` | local-jsx | Fun stickers |
| `/desktop` | local-jsx | Desktop integration |
| `/install-github-app` | local-jsx | GitHub App installer |
| `/install-slack-app` | local-jsx | Slack App installer |
| `/statusline` | local | Toggle status line |
| `/heapdump` | local | Heap dump (debug) |
| `/chrome` | local-jsx | Chrome integration |
| `/install-agents` | local-jsx | Agent installer |
| `/insights` | prompt | Usage analytics report (lazy-loaded) |

### 28.2 Feature-gated Commands

| Command | Feature Flag |
|---------|-------------|
| `/voice` | `VOICE_MODE` |
| `/bridge` | `BRIDGE_MODE` |
| `/remote-control-server` | `DAEMON + BRIDGE_MODE` |
| `/workflows` | `WORKFLOW_SCRIPTS` |
| `/web` / remote-setup | `CCR_REMOTE_SETUP` |
| `/peers` | `UDS_INBOX` |
| `/fork` | `FORK_SUBAGENT` |
| `/buddy` | `BUDDY` |
| `/brief` | `KAIROS` or `KAIROS_BRIEF` |
| `/assistant` | `KAIROS` |
| `/ultraplan` | `ULTRAPLAN` |
| `/torch` | `TORCH` |
| `/force-snip` | `HISTORY_SNIP` |

### 28.3 Command Types

| Type | Behavior |
|------|---------|
| `local` | Runs in-process, returns text to transcript |
| `local-jsx` | Renders an Ink JSX overlay (dialog/picker) |
| `prompt` | Expands to text sent to the model as a user message |

### 28.4 Remote Filtering

- **`REMOTE_SAFE_COMMANDS`**: Allowed when `--remote` is active (e.g. `session`, `exit`, `vim`, `theme`, `stickers`, `btw`, `feedback`, `plan`, `keybindings`, `mobile`)
- **`BRIDGE_SAFE_COMMANDS`**: `local` commands safe over the bridge (`compact`, `clear`, `cost`, `summary`, `files`)
- `prompt` commands are always bridge-safe; `local-jsx` commands are always bridge-blocked

### 28.5 Command Source Annotations (shown in autocomplete)

| Source | Display suffix |
|--------|---------------|
| `plugin` | `(pluginName) description` or `(plugin)` |
| `bundled` | `description (bundled)` |
| `skills` | `description (local settings)` |
| `mcp` | no suffix |
| `workflow` | `description (workflow)` |

**File:** `src/commands.ts`

---

## 29. Keybinding System

### 29.1 Architecture

```
defaultBindings.ts → KeybindingBlock[]
  ↓ (overridden by)
~/.claude/keybindings.json → user overrides
  ↓ validate.ts → conflict detection
KeybindingContext.tsx → context stack (push/pop)
  ↓
useKeybinding(action, handler, { context }) → registers listener
  ↓
useInput (Ink) → raw key event → resolver.ts → match() → handler
```

Context stack: each dialog/mode pushes a context. Only the topmost context's bindings are active — prevents scroll keys firing inside permission dialogs.

### 29.2 Full Keybinding Table by Context

**Global** (always active):
| Key | Action |
|-----|--------|
| `Ctrl+C` | `app:interrupt` (double-press = exit) |
| `Ctrl+D` | `app:exit` (double-press guard) |
| `Ctrl+L` | `app:redraw` |
| `Ctrl+T` | `app:toggleTodos` |
| `Ctrl+O` | `app:toggleTranscript` |
| `Ctrl+R` | `history:search` |
| `Ctrl+Shift+O` | `app:toggleTeammatePreview` |
| `Ctrl+Shift+F` / `Cmd+Shift+F` | `app:globalSearch` (QUICK_SEARCH) |
| `Ctrl+Shift+P` / `Cmd+Shift+P` | `app:quickOpen` (QUICK_SEARCH) |
| `Meta+J` | `app:toggleTerminal` (TERMINAL_PANEL) |
| `Ctrl+Shift+B` | `app:toggleBrief` (KAIROS) |

**Chat** (prompt input focused):
| Key | Action |
|-----|--------|
| `Enter` | `chat:submit` |
| `Escape` | `chat:cancel` |
| `Shift+Tab` / `Meta+M` (Win) | `chat:cycleMode` |
| `Meta+P` | `chat:modelPicker` |
| `Meta+O` | `chat:fastMode` |
| `Meta+T` | `chat:thinkingToggle` |
| `Up` / `Down` | `history:previous` / `history:next` |
| `Ctrl+_` / `Ctrl+Shift+-` | `chat:undo` |
| `Ctrl+X Ctrl+E` / `Ctrl+G` | `chat:externalEditor` |
| `Ctrl+S` | `chat:stash` |
| `Ctrl+V` / `Alt+V` (Win) | `chat:imagePaste` |
| `Shift+Up` | `chat:messageActions` (MESSAGE_ACTIONS) |
| `Ctrl+X Ctrl+K` | `chat:killAgents` |
| `Space` (hold) | `voice:pushToTalk` (VOICE_MODE) |

**Autocomplete**:
| Key | Action |
|-----|--------|
| `Tab` | `autocomplete:accept` |
| `Escape` | `autocomplete:dismiss` |
| `Up` / `Down` | `autocomplete:previous` / `autocomplete:next` |

**Confirmation** (permission dialogs):
| Key | Action |
|-----|--------|
| `Y` / `Enter` | `confirm:yes` |
| `N` / `Escape` | `confirm:no` |
| `Up` / `Down` | `confirm:previous` / `confirm:next` |
| `Tab` | `confirm:nextField` |
| `Space` | `confirm:toggle` |
| `Shift+Tab` | `confirm:cycleMode` |
| `Ctrl+E` | `confirm:toggleExplanation` |
| `Ctrl+D` | `permission:toggleDebug` |

**Scroll**:
| Key | Action |
|-----|--------|
| `PageUp` / `PageDown` | `scroll:pageUp` / `scroll:pageDown` |
| `WheelUp` / `WheelDown` | `scroll:lineUp` / `scroll:lineDown` |
| `Ctrl+Home` / `Ctrl+End` | `scroll:top` / `scroll:bottom` |
| `Ctrl+Shift+C` / `Cmd+C` | `selection:copy` |

**Transcript** (Ctrl+O view):
| Key | Action |
|-----|--------|
| `Ctrl+E` | `transcript:toggleShowAll` |
| `Q` / `Ctrl+C` / `Escape` | `transcript:exit` |

**HistorySearch** (Ctrl+R):
| Key | Action |
|-----|--------|
| `Ctrl+R` | `historySearch:next` |
| `Escape` / `Tab` | `historySearch:accept` |
| `Enter` | `historySearch:execute` |
| `Ctrl+C` | `historySearch:cancel` |

**MessageSelector** (/rewind):
| Key | Action |
|-----|--------|
| `Up/Down` / `J/K` / `Ctrl+P/N` | Navigate messages |
| `Ctrl+Up` / `Shift+Up` / `Shift+K` | `messageSelector:top` |
| `Ctrl+Down` / `Shift+Down` / `Shift+J` | `messageSelector:bottom` |
| `Enter` | `messageSelector:select` |

**MessageActions** (MESSAGE_ACTIONS feature, Shift+Up from chat):
| Key | Action |
|-----|--------|
| `Up/Down` / `J/K` | Navigate messages |
| `Shift+Up/Down` | Jump to prev/next user message |
| `Meta+Up/Down` / `Super+Up/Down` | Jump to top/bottom |
| `Escape` | `messageActions:escape` |
| `Ctrl+C` | `messageActions:ctrlc` |
| `Enter` | `messageActions:enter` |
| `C` | `messageActions:c` (copy) |
| `P` | `messageActions:p` |

**Task** (running agent/bash): `Ctrl+B` → `task:background`

**Other contexts**: `Settings`, `Tabs`, `Select`, `Footer`, `DiffDialog`, `ModelPicker`, `Plugin`, `ThemePicker`, `Help`, `Attachments` — each with context-local bindings.

### 29.3 User Customization

Users create `~/.claude/keybindings.json` with `KeybindingBlock[]` schema. Constraints:
- `ctrl+c` (`app:interrupt`) and `ctrl+d` (`app:exit`) are **reserved** — overriding them shows an error
- Conflicts within the same context show a warning
- `/keybindings` command opens a live conflict-detection UI

**Platform differences:** `Shift+Tab` for mode-cycle may not work on older Windows terminals without VT mode; falls back to `Meta+M`. Image paste is `Ctrl+V` everywhere except Windows where it's `Alt+V`.

**File:** `src/keybindings/defaultBindings.ts`, `src/keybindings/validate.ts`, `src/keybindings/reservedShortcuts.ts`

---

## 30. Messages.tsx Rendering Pipeline

`Messages.tsx` is the transformation layer between raw `Message[]` and the final `RenderableMessage[]` passed to `VirtualMessageList` or flat-mapped. Six sequential passes:

```
messages: Message[]
  ↓ normalizeMessages() → NormalizedMessage[]         (flatten multi-content blocks)
  ↓ isNotEmptyMessage() filter
  ↓ getMessagesAfterCompactBoundary()                  (fullscreen: skip, else: drop pre-compact)
  ↓ filter(isNullRenderingAttachment)                  (drop hook_success, hook_cancelled etc.)
  ↓ filter(shouldShowUserMessage)                      (drop meta user turns in main screen)
  ↓ reorderMessagesInUI() + syntheticStreamingToolUses
  ↓ brief/KAIROS filter (filterForBriefTool or dropTextInBriefTurns)
  ↓ slice(-30) if transcript mode AND !showAll AND !virtual
  ↓ applyGrouping()                                    (parallel tool uses → grouped_tool_use)
  ↓ collapseReadSearchGroups()
  ↓ collapseHookSummaries()
  ↓ collapseTeammateShutdowns()
  ↓ collapseBackgroundBashNotifications()
  ↓ buildMessageLookups()                              (Maps for cross-reference)
  ↓ computeSliceStart() → renderableMessages           (non-virtual: UUID-anchored 200-msg window)
  ↓ VirtualMessageList (fullscreen) OR flatMap (non-fullscreen)
```

### 30.1 Null-rendering Attachment Types (dropped before cap)

`hook_success`, `hook_additional_context`, `hook_cancelled`, `hook_error`, `task_notification`

### 30.2 Brief/KAIROS Filter Modes

| Mode | Behavior |
|------|---------|
| `isBriefOnly` | Only `BriefTool` calls + results + real user input. All assistant text dropped. |
| Default (BriefTool present) | Drop assistant text only in turns where `BriefTool` was called |
| Transcript mode (`Ctrl+O`) | No filtering — everything shown |

### 30.3 Streaming Text Preview

`streamingText` prop renders as an extra item **after** all `renderableMessages`. Positionally seamless — when the backend commits the message, the final `MessageRow` appears at the same Y. The `collapsed_read_search` group's past-tense flip triggers as soon as `streamingText` begins.

### 30.4 Messages Component Memo Comparator

Custom `React.memo` comparator skips re-renders for:
- Stable callback refs: `onOpenRateLimitOptions`, `scrollRef`, `trackStickyPrompt`, `setCursor`, `cursorNavRef`, `jumpRef`, `onSearchMatchesChange`, `scanElement`, `setPositions`
- `streamingToolUses` if length and `contentBlock` refs are unchanged
- `inProgressToolUseIDs` Set if content equal
- `unseenDivider` if `firstUnseenUuid` and `count` unchanged
- `tools` if length and `tool.name` entries unchanged

`streamingThinking` always triggers a re-render.

### 30.5 Click-to-Expand

| Message type | Expandable when |
|-------------|----------------|
| `collapsed_read_search` | Always |
| `advisor_tool_result` | Block type is `advisor_result` |
| Tool result | `tool.isResultTruncated(toolUseResult)` returns `true` |

Expansion key: `tool_use_id` (tool_use + result expand together) or `uuid` for groups/thinking.

**File:** `src/components/Messages.tsx`

---

## 31. Collapsed Read/Search Group Logic

`collapseReadSearchGroups()` produces `collapsed_read_search` nodes that render as single summary rows, hiding the individual tool calls.

### 31.1 What Gets Collapsed

| Category | Trigger |
|---------|---------|
| Search tools | `tool.isSearchOrReadCommand()` returns `isSearch: true` (Grep, Glob, ripgrep) |
| Read tools | `isRead: true` (FileRead, cat via bash) |
| Memory writes | `FileWrite`/`FileEdit` targeting `isAutoManagedMemoryFile()` path |
| Bash commands (fullscreen only) | All `BashTool` calls when `isFullscreenEnvEnabled()` |
| Absorbed silently | `SnipTool`, `ToolSearchTool`, `REPLTool` wrapper — no count increment, no group break |

**Group breakers:** Non-empty assistant text, non-collapsible tool use, real (non-meta) user message.

### 31.2 GroupAccumulator Tracked Fields

| Field | Tracks |
|-------|--------|
| `searchCount` | Grep/ripgrep-style searches |
| `readFilePaths` | Unique file paths read |
| `readOperationCount` | Bash cat etc. (no path) |
| `listCount` | ls/tree/du ops |
| `memorySearchCount` / `memoryReadFilePaths` / `memoryWriteCount` | Memory-file ops |
| `teamMemory*` | Team memory ops (TEAMMEM feature) |
| `nonMemSearchArgs` | Pattern strings for hint display |
| `latestDisplayHint` | Last `$ command` preview (≤300 chars) |
| `mcpCallCount` / `mcpServerNames` | MCP tool calls |
| `bashCount` / `bashCommands` | Non-search bash (fullscreen) |
| `commits` / `pushes` / `branches` / `prs` | Git ops from bash output |
| `hookTotalMs` / `hookCount` / `hookInfos` | Absorbed PreToolUse hook timing |
| `relevantMemories` | Auto-injected memory attachments |

### 31.3 Summary Text Components

```
Read N files, searched M times, listed K dirs[, ran B bash commands]
[committed sha1, created PR #42]
[recalled P memories, updated Q memories]
[Queried slack (N calls)]

⎿ $ last-command-preview
```

Git ops detected by `detectGitOperation()` scanning bash stdout/stderr for commit SHAs, PR URLs, branch refs.

### 31.4 Other Collapse Passes

| Pass | Collapses |
|------|----------|
| `collapseHookSummaries()` | Consecutive `stop_hook_summary` system messages |
| `collapseTeammateShutdowns()` | Multiple teammate shutdown notices → `"3 workers stopped"` |
| `collapseBackgroundBashNotifications()` | Background `!cmd` run notifications by command |

### 31.5 Verbose Expansion

When `verbose=true` or a group is click-expanded, the group unfolds to show all `messages[]` individually.

**File:** `src/utils/collapseReadSearch.ts`, `src/utils/collapseHookSummaries.ts`

---

## 32. Pre-REPL Setup Dialogs

Before the main REPL renders, `main.tsx` may show blocking setup dialogs. All use `showSetupDialog(root, doneCallback)` — a Promise that resolves when `done()` is called.

| Launcher | Trigger | Resolves To |
|----------|---------|-------------|
| `launchInvalidSettingsDialog` | `settings.json` has validation errors | `void` (continue or exit) |
| `launchSnapshotUpdateDialog` | Agent memory snapshot is stale | `'merge' \| 'keep' \| 'replace'` |
| `launchAssistantSessionChooser` | `claude assistant` finds multiple bridge sessions | `string \| null` (sessionId) |
| `launchAssistantInstallWizard` | `claude assistant` finds zero sessions | `string \| null` (install dir) |
| `launchTeleportResumeWrapper` | `--continue` flag with teleport sessions | `TeleportRemoteResponse \| null` |
| `launchTeleportRepoMismatchDialog` | Teleport target repo not found locally | `string \| null` (checkout path) |
| `launchResumeChooser` | `-r`/`--resume` flag | `void` (full App re-render) |

`launchResumeChooser` is unique — uses `renderAndRun()` (not `showSetupDialog`), wraps in `<App><KeybindingSetup>`. Resolves after user picks a session and REPL takes over.

**File:** `src/dialogLaunchers.tsx`, `src/interactiveHelpers.tsx`

---

## 33. Markdown & AST Rendering Pipeline

Rather than dumping raw text to the terminal, `cat-code` parses markdown to a custom AST via the `marked` library, and then renders those tokens to React/Ink nodes.

### 33.1 The Custom marked Pipeline
- **Parsing**: `marked.lexer()` is used. A fast-path regex (`/[#*`\|[>\-_~]\|\n\n\|^\d+\. \|\n\d+\. /`) prevents the expensive lexer from running on plain text.
- **LRU Caching**: Output tokens are heavily cached using a `tokenCache` with `TOKEN_CACHE_MAX = 500`. Keyed by `hashContent`. 
- **Formatting**: The `formatToken` mapping converts header depth to ANSI boldness, converts codespans to `permission` colors, and syntax highlights block code.
- **Linkification**: `linkifyIssueReferences` uses `/([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g` to find `owner/repo#42` structures and wrap them in OSC-8 links.

### 33.2 Out-of-Band XML (Thinking Blocks)
Standard Markdown cannot represent the streaming "thinking" process cleanly if it contains unclosed tags. The terminal separates this from normal content:
1. `stripPromptXMLTags(content)` runs *before* `marked.lexer()`. It strips specific agent scaffolding tags from the stream.
2. In `Messages.tsx`, `<thinking>` tags are structurally lifted into their own `MessageRow` state (a `streamingThinking` block or `redacted_thinking` block) independent of the markdown AST.
3. This is why thinking animation works structurally above the markdown layer.

**Files:** `src/components/Markdown.tsx`, `src/utils/markdown.ts`, `src/utils/messages.ts`

---

## 34. The Autocomplete Layout Engine

The suggestions drop-up (`PromptInputFooterSuggestions`) handles visual selection for typeahead commands, files, MCP resources, and agents.

### 34.1 Unified vs Non-Unified Suggestions
- **Unified Items**: Prefixed with `file-`, `mcp-resource-`, or `agent-`.
  - Files use a `+` icon, truncate path in the middle (`truncatePathMiddle`), and reserve 20 chars max for the description.
  - MCP resources use a `◇` icon, truncate path to 30 chars at the end.
  - Agents use a `*` icon.
  - They are combined into a single line format: `[icon] [ItemName] - [Description]` spanning the exact column width of the terminal.
- **Non-Unified Items**: Slash commands, custom titles, etc.
  - Rendered in two columns.
  - Name is capped at `columns * 0.4` width, padded with trailing spaces.
  - Description takes up the remainder. 

### 34.2 Overlay Placement
- When triggered via inline slash (`/`) or mention (`@`), suggestions render within the `PromptInput` absolute bounds, using an `OVERLAY_MAX_ITEMS` of 5.
- Visually, the currently highlighted item flips its foreground and background colors (`dimColor=!isSelected`, `color="suggestion"`) to act as the cursor.

**Files:** `src/components/PromptInput/PromptInputFooterSuggestions.tsx`

---

## 35. Design System & Topology (Theme Engine)

To achieve the exact visual "feel" of `cat-code`, the UI relies on strict CSS-equivalent variable palettes and specific Unicode geometries.

### 35.1 The Theme Palette (`src/utils/theme.ts`)
The application defines standard RGB palettes across six variations (`light`, `dark`, `light-ansi`, `dark-ansi`, `light-daltonized`, `dark-daltonized`). Key color roles to map to CSS variables:

- **Brand/Agent**: `claude` (Brand orange), `autoAccept` (Violet), `blue_FOR_SUBAGENTS_ONLY` (Sub-agent coloring), `fastMode` (Electric Orange).
- **Surface/Backgrounds (TUI V2)**: 
  - `userMessageBackground`: (e.g. rgb(55,55,55) in dark)
  - `messageActionsBackground`: Distinct container bg for shift-up mode
  - `selectionBg`: Used instead of ANSI inverse. E.g. rgb(38,79,120) for macOS styling
  - `bashMessageBackgroundColor`: Used for tool run blocks
- **Shimmer States**: Every primary color has a `*Shimmer` equivalent (e.g., `permission` vs `permissionShimmer`) used by the animated block renderer.
- **Diff Colors**: Both line-level (`diffAdded`, `diffRemoved`, `diffAddedDimmed`) and word-level (`diffAddedWord`, `diffRemovedWord`) shades.

### 35.2 UI Figures & Indicators (`src/constants/figures.ts`)
These exact Unicode replacements make the app look like an engineered interface rather than raw text:

| Purpose | Variable | Character |
|---------|----------|-----------|
| Effort levels | `EFFORT_LOW`, `MEDIUM`, `HIGH`, `MAX` | `○`, `◐`, `●`, `◉` |
| Fast mode | `LIGHTNING_BOLT` | `↯` (or `\u21af`) |
| Issue flags | `FLAG_ICON` | `⚑` (or `\u2691`) |
| Blockquotes | `BLOCKQUOTE_BAR` | `▎` (left quarter block prefix) |
| Running states | `DIAMOND_OPEN`, `DIAMOND_FILLED`| `◇`, `◆` (ultrareview states) |
| Bridge States | `BRIDGE_READY`, `BRIDGE_FAILED` | `·✔︎·`, `×` |
| Git Ops | `BLOCKQUOTE_BAR` | Used heavily in diff tables |

### 35.3 Output Styles
Aside from colors, "Themes" also control the model instructions via `/output-style`. 
- **Explanatory**: Injects `EXPLANATORY_FEATURE_PROMPT` into the system instructions.
- **Learning**: Modifies system prompt to ask the user to contribute 2-10 line code blocks, appending a `TODO(human)` logic.

**Files:** `src/utils/theme.ts`, `src/constants/figures.ts`, `src/constants/outputStyles.ts`

---

### 36. Code Diff Rendering Pipeline (`StructuredDiff.tsx`)

The UI does not rely on simple string-matching for diffs; it implements a highly optimized, syntax-aware rendering engine.

**Architecture:**
- **Rust NAPI Binding**: Relies on a native binary (`expectColorDiff()`) to perform the heavy lifting of diff parsing and syntax highlighting off the main thread.
- **Memory/Render Caching**: Uses a `WeakMap<StructuredPatchHunk, Map<string, CachedRender>>` to memoize the render output. The cache key includes `theme|width|dim|gutterWidth|firstLine|filePath`, meaning window resizes trigger automatic re-renders.

**Visual Layout & UX:**
- **Split Layout**: Renders diffs in two distinct columns. The `gutterWidth` (containing line numbers and `+/-` markers) is strictly computed.
- **Copy-Paste Protection**: The gutter is wrapped in an Ink `<NoSelect fromLeftEdge>` component. This prevents the user from accidentally highlighting and copying line numbers when selecting code snippets from the terminal.

### 37. Loading & Spinner Engine (`Spinner.tsx`)

The app features a unified, highly polished animation engine for system statuses.

**Engine Mechanics:**
- **High Refresh Rate**: Driven by a `useAnimationFrame(120)` hook, pushing terminal frames every 120ms.
- **Character Set**: The default animation uses standard Braille dots `['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']`. The system concatenates this array with its own reverse sequence to create a smooth, pulsing "breathing" effect rather than a harsh reset.
- **Accessibility**: Automatically falls back to a static bullet (`●`) if `prefersReducedMotion` is enabled in the user's settings.

**Thinking & Idle States:**
- **Anti-Jank Timer**: When the model enters the `thinking...` state, the UI enforces a minimum 2-second display duration. This prevents brief, sub-second thinking bursts from creating visual strobe effects before switching to the final duration display (e.g., `(thought for 4.2s)`).
- **Floating Idle**: In "Brief Mode", the `BriefIdleStatus` uses negative margin compensations against the prompt input so the spinner/idle text floats above the input container without shifting the terminal scroll bounds.

### 38. The Rewind / History UI (`MessageSelector.tsx`)

The history rewinding UI (accessible via `Ctrl+U` or `Ctrl+O -> Restore`) provides a safety net for destructive or looping agent behavior.

**Core Interactions:**
- **Virtual Window**: Only displays `MAX_VISIBLE_MESSAGES = 7` at a time to prevent terminal overflow.
- **Pre-computed Regrets**: Before the user confirms a rewind, the system asynchronously calculates the file system delta (`fileHistoryGetDiffStats`). If rewinding will undo code, it displays the exact impact (e.g., `+45 -22` and the filenames).

**Resolution Options:**
1. **`both` (Restore code and conversation)**: Forks the session and actively reverts local file system changes.
2. **`conversation` (Restore conversation)**: Drops the agent's memory from that point forward but leaves the current file system intact.
3. **`summarize` (Summarize from here)**: Condenses the transcript from the selected point to save context window tokens.

### 39. Image References & OSC 8 (`ClickableImageRef.tsx`)

When the user uploads an image, the terminal cannot natively render pixels. The system manages this via local indexing and hyperlink protocols.

**Mechanism:**
- **Visual Token**: Images are rendered securely in the layout as `[Image #1]`.
- **OSC 8 Hyperlinks**: Uses the terminal standard OSC 8 hyperlink sequence (`\x1b]8;;file:///absolute/path/to/image.png\x07`) wrapping the token.
- **Click Action**: When the user clicks the token (usually by holding `Cmd` or `Ctrl`), the OS opens the image directly in the default system viewer (e.g., Preview on macOS).

---

### 40. MCP Integration & Elicitation Form UI (`src/components/mcp/`)

The terminal implements a sophisticated subsystem to handle the Model Context Protocol (MCP), particularly its ability to prompt the user directly via dynamic forms ("Elicitation"). This subsystem represents some of the most advanced interactive layouts in the application.

**MCP Settings (`MCPSettings.tsx`, `MCPListPanel.tsx`)**
- A full-screen management UI layout designed to list and configure connections to external MCP servers.
- Manages connections to SSE, HTTP, Stdio, and ClaudeAI Proxy servers.
- Dynamically validates OAuth tokens and session ingress authentication to reflect the connection state.

**The Elicitation Form Engine (`ElicitationDialog.tsx`)**
When an MCP tool requests input (elicitation) based on a JSON schema, this component generates a dynamic terminal-native interactive form.
- **Dynamic Field Rendering**: Capable of rendering booleans (y/n typeahead), enums (single-select accordion structure), multi-select enums, and standard text inputs.
- **Debounced Asynchronous Validation**: Validation runs in a debounced wrapper. Specifically for Date/Time inputs, `setTimeout` waits for 2000ms of inactivity before firing an async NL parsing request (`validateElicitationInputAsync`).
- **Targeted Loading Indicators**: Instead of blocking the whole UI during async validation, the system uses a localized `ResolvingSpinner` component tightly coupled to the specific field being verified via a local 80ms `setInterval`.
- **Advanced Virtualized Windowing**: Because forms might contain more fields than fit vertically in the terminal viewport, the UI uses `LINES_PER_FIELD` calculations to only render fields within a strict, computed window size (`rows - DIALOG_OVERHEAD`). Off-screen fields remain in state but are unmounted.

---

### Appendix: Minor UI & Registry Files

While all critical rendering loops and state managers are documented above, here are a few minor files and registries that operate in the background. You can refer to these when you need exact strings, exact icons, or the full dictionary of supported features:

1. **Anti-Jiggle Layout Locks:** `src/components/design-system/Ratchet.tsx`
   - Forces a container's minimum height to ratchet upward, preventing the terminal layout from bouncing during dynamic text changes.
2. **Status Icons Dictionary:** `src/components/design-system/StatusIcon.tsx`
   - Formalizes generic `success`, `error`, `warning`, `info`, and `loading` states to their specific Unicode icons with trailing spaces.
3. **Full Slash Command Dictionary:** `src/commands.ts`
   - The absolute master list of all `import` targets for system slash commands (e.g., `/cost`, `/memory`, `/good-claude`, etc.).
4. **Onboarding Flow:** `src/commands/onboarding/index.js`
   - Handles the new-user configuration steps outside of the standard React UI tree.

---

### Appendix: Master Source File Index

For quick reference, here is the complete, alphabetical list of all exact `cat-code` codebase files used to compile this blueprint:

- **`src/bridge/bridgeApi.ts`** - Exposes API endpoints for the external Web UI bridge.
- **`src/bridge/bridgeMessaging.ts`** - Handles WebSockets/SSE messaging protocols for bridging state payloads.
- **`src/bridge/replBridge.ts`** - Wires the terminal REPL event loop up to the web bridge.
- **`src/bridge/types.ts`** - Master TypeScript type definitions for the bridge payload schemas.
- **`src/commands.ts`** - The central registry mapping internal behaviors to slash commands.
- **`src/commands.tsx`** - JSX-based entrypoints that launch complex terminal React overlays.
- **`src/commands/onboarding/index.js`** - Manages the first-time initial terminal setup and API key entry.
- **`src/components/AgentModeStatusHeader.tsx`** - The "Agent Mode Active" banner floating above the prompt bar.
- **`src/components/AgentProgressLine.tsx`** - Renders the pulsing single-line real-time step identifiers.
- **`src/components/App.tsx`** - The absolute root component of the entire mapped Ink React tree.
- **`src/components/ApproveApiKey.tsx`** - Inline dialog triggering when the system detects missing or revoked keys.
- **`src/components/ClickableImageRef.tsx`** - Renders securely terminal-clickable OSC 8 hyperlinks for image payloads (`[Image #1]`).
- **`src/components/ConsoleOAuthFlow.tsx`** - The graphical flow handler for terminal-to-browser OAuth login sequences.
- **`src/components/FullscreenLayout.tsx`** - The core layout wrapper; pins header/footer and centralizes scroll zones.
- **`src/components/IdeStatusIndicator.tsx`** - Tiny floating indicator determining if the VSCode/JetBrains extensions run.
- **`src/components/LogSelector.tsx`** - Specialized list picker component for browsing the internal system log directory.
- **`src/components/Markdown.tsx`** - The primary rendering engine converting standard AST blocks into styled Ink text.
- **`src/components/Message.tsx`** - The parent boundary container wrapping an individual Chat exchange unit.
- **`src/components/MessageRow.tsx`** - Specifically memoized wrapper representing absolute visual rows in the `VirtualMessageList`.
- **`src/components/MessageSelector.tsx`** - The "Rewind UI" (`Ctrl+U`) allowing users to fork or restore file histories.
- **`src/components/Messages.tsx`** - Triggers the rendering iterations mapping application memory into `Message` nodes.
- **`src/components/Onboarding.tsx`** - Contains the graphical wizard segments executed during the terminal tutorial block.
- **`src/components/PromptInput/Notifications.tsx`** - Floating toast notification engine popping messages over the input area.
- **`src/components/PromptInput/PromptInput.tsx`** - The monolithic text entry container boasting Vi-bindings and dynamic multiline growth.
- **`src/components/PromptInput/PromptInputFooter.tsx`** - Wraps suggestions and tool confirm queue constraints underneath the prompt.
- **`src/components/PromptInput/PromptInputFooterLeftSide.tsx`** - Displays context badges (like "Fast Mode" `↯`) pinned left.
- **`src/components/PromptInput/PromptInputFooterSuggestions.tsx`** - Drives autocomplete UX for file-paths, system commands, and mentions.
- **`src/components/ScrollKeybindingHandler.tsx`** - Globally intercepts pg-up/pg-down keys translating them into virtual window jumps.
- **`src/components/Spinner.tsx`** - The highly optimized frame-driven 120ms engine driving terminal loaders and async statuses.
- **`src/components/StatusLine.tsx`** - Analyzes executing background shell outputs and collapses them to the right-aligned visual indicator.
- **`src/components/StructuredDiff.tsx`** - Renders colorized `+`/`-` line patches optimized by a Rust backend binary and weak-map cache.
- **`src/components/VirtualMessageList.tsx`** - Crucial engine container running 2-phase non-quantized height measurements for chat scrolling.
- **`src/components/design-system/Ratchet.tsx`** - A component that mechanically maps the maximum-rendered layout height into a locked `minHeight`.
- **`src/components/design-system/StatusIcon.tsx`** - Re-maps fundamental system signals (`success/warning/error`) to validated Unicode figures.
- **`src/components/mcp/ElicitationDialog.tsx`** - Virtualized form generation engine mapping external JSON schemas into React form segments.
- **`src/components/mcp/MCPListPanel.tsx`** - Configuration tab rendering active Tool Providers/Servers hooked into Model Context Protocol.
- **`src/components/mcp/MCPSettings.tsx`** - The master modal wrapping all MCP OAuth, Server, and Configuration states.
- **`src/constants/figures.ts`** - A static constants dictionary guaranteeing stable rendering of complex visual ticks and progress dots.
- **`src/constants/outputStyles.ts`** - Governs logic switching formatting (like Explanatory or Interactive prompting behaviors).
- **`src/context/promptOverlayContext.tsx`** - The `Provider` managing complex state priorities of conflicting tool overlays over the screen boundaries.
- **`src/dialogLaunchers.tsx`** - Pure helper hooks taking complex dialog component signatures and converting them into simpler imperative API methods.
- **`src/entrypoints/cli.tsx`** - The primary mount point; takes over standard POSIX out pipes mapping React DOM render streams to standard CLI output.
- **`src/interactiveHelpers.tsx`** - Tiny non-react wrappers enabling isolated CLI logic flows like "confirm boolean" without launching `App`.
- **`src/keybindings/defaultBindings.ts`** - The absolute lookup table mapping physical key chords to global application trigger payloads.
- **`src/keybindings/reservedShortcuts.ts`** - A protection layer ensuring critical triggers (`SIGINT`) cannot be broken by custom configurations.
- **`src/keybindings/useKeybinding.tsx`** - Global interceptor hook enforcing layered focus, ensuring dialog keystrokes aren't leaked to Chat Input.
- **`src/keybindings/validate.ts`** - The conflict detection logic that tests user's JSON mappings against the core configurations.
- **`src/screens/Doctor.tsx`** - An independent `/doctor` screen presenting static blocks of system validations checking paths/keys/configs.
- **`src/screens/REPL.tsx`** - The foundational Chat interface; manages the pipeline moving user prompts into the state context payload layer.
- **`src/screens/ResumeConversation.tsx`** - Operates the logic loading `fuzzySearch` match histories via the `/resume` picker layout.
- **`src/utils/collapseHookSummaries.ts`** - Visual summarizer intercepting terminal hook outputs replacing long stdout with brief collapsed elements.
- **`src/utils/collapseReadSearch.ts`** - Post-processor logic dynamically bundling multi-file-read actions into standard `[Read 4 files]` blocks.
- **`src/utils/markdown.ts`** - Pre-renders Marked AST trees against a specific Custom LRU cache wrapper ensuring rapid terminal throughputs.
- **`src/utils/messages.ts`** - Sanitization methods taking system message payloads filtering and tagging `[Image #X]` formatting structures.
- **`src/utils/theme.ts`** - Master definitions map binding CSS-style RGB tokens like `bg-blue` over into terminal hex color interpretations.
