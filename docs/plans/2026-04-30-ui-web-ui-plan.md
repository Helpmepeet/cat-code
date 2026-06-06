# Web UI Plan: Browser Frontend for Cat Code

**Status:** Draft v3 — 2026-04-10
**Track:** Independent / parallel to docs/vision/2026-04-30-GOAL_PLAN.md milestones
**Architecture:** #2 — Terminal as headless backend, browser as frontend (WebSocket)
**Stack:** Vite + React (frontend), Bun WebSocket server (backend shim)
**End goal:** Full terminal replacement in browser — terminal stays as fallback

---

## How To Use This Plan

Each milestone follows a three-step workflow:

1. **Design** — Use a design skill (frontend-design or grill-me) to interview the user and make UX/design decisions for the milestone. No implementation until decisions are made.
2. **Spec** — Write the design decisions, task breakdown, and dependency graph into this plan under the milestone section. This is the spec that survives across sessions. Conversation is ephemeral — the plan is the source of truth.
3. **Implement** — Agents pick up tasks from the spec. Independent tasks run in parallel. Sequential tasks wait for their dependencies.

### Task breakdown format

Each milestone's spec should include:

- **Design decisions** — UX/layout/behavior choices made during the design step
- **Tasks** — numbered list, each self-contained enough for one agent to execute from the plan alone
- **Dependency graph** — which tasks are independent (can run in parallel) and which block on others

Example:
```
Tasks:
  T1: Scaffold Vite app          (independent)
  T2: WS server skeleton         (independent)
  T3: Message relay protocol     (depends on T2)
  T4: Connect frontend to WS     (depends on T1, T2)

Parallel group A: T1, T2
Sequential: T3 after T2, T4 after T1+T2
```

### Session continuity

Sessions may end at any time (context limits, usage caps, pauses). The next session picks up by reading this plan + checking git state. No pre-planning of session boundaries needed — milestones are the unit of work, not sessions.

---

## Vision

Add a web browser frontend to Cat Code. The terminal stays as a fallback. A WebSocket server runs alongside, and a React web app in a browser tab becomes the primary interaction surface. One user, local machine, no deployment. Mobile support is a far-future goal.

```
  [Core Engine] ──► [Ink UI] ──► Terminal        (fallback, always works)
       │
       └──────► [WS Server] ──► [Web UI] ──► Browser   (primary)
```

---

## Design Principle

**The web UI mirrors the terminal UX — not a redesign.** Every feature should work the same way it does in the terminal today. The web is a better rendering surface, not a different product. Only change UX when explicitly asked.

---

## User Requirements

Gathered from user interview, 2026-04-10:

- **Chat page is the main page** — mirrors what the terminal shows today
- **Multiple pages** — at minimum: chat, accounts & usage, agents. More pages to be designed later.
- **Tool outputs collapsed by default**, expand to see details
- **Running agents should not block the UI** — user can start new conversations, browse sessions, check costs while agents work
- **Normal chat UX** — straightforward, nothing fancy
- **Terminal as fallback** — always keep terminal working, browser is the new primary
- **Desktop-first** — mobile/tablet is far-future
- **The whole point is escaping terminal limitations** — web gives full design freedom, terminal is rigid
- **Same UX, better surface** — don't redesign, just render what the terminal shows in HTML

## User Design Profile

Gathered from design interview, 2026-04-10:

- **Reference UIs**: ChatGPT and Claude.ai — centered column, clean, minimal chrome
- **Terminal pain points**: hard to configure (Ink), keyboard-only (no mouse), hard to rebrand
- **Visual style**: clean/minimal, dark theme with pink accents
- **Work pattern**: starts agents, goes away, comes back to check. Needs a dashboard-on-return feel — "is it done? did anything fail? what's it doing?"
- **Agents**: runs many background agents concurrently — agent status must be prominent
- **Tool outputs**: glance to confirm, but must support deep reading on click
- **Notifications**: visual only, no sound
- **Input**: writes long multi-line prompts — input area must auto-resize
- **Sidebar**: hidden by default, maximize chat space, open when needed

---

## Feature Inventory

Everything the web UI must eventually support, grouped by system. This is the full scope derived from the existing terminal feature set.

### Chat & Conversation
- Streamed assistant responses with markdown rendering (headings, bold, lists, code blocks, tables)
- User / assistant / system message distinction
- Thinking summaries (collapsible, shown when `showThinkingSummaries` is on)
- Context compaction indicator (when conversation is auto-compacted)
- Session rename (`/rename`)
- Session tags (`/tag`)
- Conversation branching (`/branch`)
- Conversation rewind (`/rewind`)
- Export conversation (`/export`)
- Copy last message (`/copy`)
- Context visualization (`/context` — colored grid of context usage)
- Diff view (`/diff` — uncommitted changes and per-turn diffs)

### Tools (collapsed cards, expand on click)
Each tool call shows as a card: tool icon, name, status (running/done/error), collapsed by default.

| Tool | Expanded view shows |
|------|-------------------|
| **Bash** | Command, exit code, stdout/stderr with ANSI colors |
| **Read** | File path, line range, file contents with syntax highlighting and line numbers |
| **Edit** | File path, old_string → new_string as a green/red diff |
| **Write** | File path, full file contents with syntax highlighting |
| **Glob** | Pattern, list of matching file paths |
| **Grep** | Pattern, matching lines with file paths and line numbers, or file list, or counts |
| **Agent** | Agent description, type badge, model, status, duration, tool count, token count. Expand to see the agent's nested conversation and tool calls |
| **WebFetch** | URL, extracted content |
| **WebSearch** | Query, results |
| **NotebookEdit** | Cell changes |
| **TodoWrite** | Task list state |
| **Skill** | Skill name, args |
| **MCP tools** | Tool name, server name, input params, output |

### Permission System
- Modal dialog: "Allow [tool name]?" with tool parameters shown
- Three buttons: Allow, Deny, Always Allow
- Permission rules display (current allow/deny rules)
- Permission mode indicator (default mode: allow/deny/ask)
- Bypass permissions mode toggle

### Agents
- **Built-in types**: General-Purpose, Explore, Plan, Verification, Claude Code Guide, Statusline Setup, Fork
- **Agent states**: pending → running → completed / failed / killed
- **Per-agent data**: description, type, model, status, elapsed time, tool use count, token count, last activity
- **Progress tracking**: real-time tool count, token count, recent tool activities
- **Background agents**: launched with `run_in_background`, run async, notify on completion
- **Foreground agents**: block the current conversation, show inline
- **Agent nesting**: agents can spawn sub-agents — show as tree with parent-child connectors
- **Isolation badges**: "worktree" badge on agents using git worktree isolation
- **Kill button**: abort a running agent
- **Output file**: each background agent writes to an output file for streaming progress
- **Agent memory**: some agents have persistent memory (user/project/local scope)
- **Teammate agents**: named agents with team context, tmux pane info, color coding

### Accounts & Usage
Two provider pools, each with multiple accounts:

**Anthropic (Claude) accounts:**
- Fields: email, alias, subscription type (free/pro/max/team), status (healthy/dead), display name, organization, billing type, extra usage enabled
- Rate limits: 5-hour window % and reset time, 7-day window % and reset time
- Active account highlighted
- Manual switching only (round-robin or by alias/email/UUID prefix)

**Codex (OpenAI/GPT) accounts:**
- Fields: alias, account ID, status (healthy/dead/capped), turns used, last error
- Usage: 5-hour window % and reset time, weekly window % and reset time, credit balance
- Active account highlighted
- Auto-rotation: LRU scoring with configurable turn threshold
- Failover: instant rotation on 429 cap errors
- Rotation scoring: `(5h_usage% × 3) + weekly_usage%`

**Session costs:**
- Input tokens, output tokens, cache creation tokens, cache read tokens
- Cost in USD (model-specific pricing)
- Per-session and cumulative display

**Account actions:**
- Switch account (`/switch-account`)
- Rename account alias (`/rename-account`)
- Refresh tokens (`/touch-all`)

### Model & Inference Controls
- Model selector: switch between Claude and GPT models
- Effort level: low / medium / high (maps to `reasoning.effort` for GPT)
- Fast mode toggle
- Thinking toggle (enable/disable extended thinking)
- Advisor model configuration

### Session Management
- Session list: all past sessions, searchable by name/tag
- Resume session (`/resume`)
- New session
- Session rename
- Session tags
- Active session indicator
- Cost per session in list view

### Slash Commands (107+)
The web UI needs a command palette (Ctrl+K or `/`) that exposes all commands. Key user-facing commands:

**Must have in command palette:**
- `/clear`, `/compact`, `/cost`, `/diff`, `/context`, `/export`, `/copy`
- `/model`, `/effort`, `/fast`
- `/resume`, `/rename`, `/tag`, `/branch`, `/rewind`
- `/switch-account`, `/rename-account`, `/accounts`
- `/commit`, `/review`, `/pr-comments`
- `/mcp`, `/skills`, `/agents`, `/tasks`
- `/doctor`, `/status`, `/usage`, `/stats`
- `/permissions`, `/config`, `/keybindings`
- `/login`, `/logout`
- `/vim` (if vim mode is ported)
- `/voice` (if voice mode is ported)

**Can remain terminal-only for now:**
- `/terminal-setup`, `/install-agents`, `/install-github-app`, `/install-slack-app`
- `/desktop`, `/mobile`, `/session`, `/remote-control`
- `/heapdump`, `/break-cache`, `/backfill-sessions`
- Internal/debug commands

### Settings
The settings page should expose key settings grouped by section:

- **Model & Inference**: model, effortLevel, fastMode, alwaysThinkingEnabled, advisorModel, language
- **Permissions**: permissions.defaultMode, permission rules list, classifierPermissionsEnabled
- **Git**: attribution, includeCoAuthoredBy, includeGitInstructions
- **Display**: theme, syntaxHighlightingDisabled, outputStyle, showThinkingSummaries, prefersReducedMotion
- **Accounts**: codexAccountRotationThreshold, codexTokenRefreshIntervalHours
- **Session**: cleanupPeriodDays, defaultView
- **MCP Servers**: list of connected servers with status, tool count. Add/remove.
- **Hooks**: view configured hooks (read-only initially)
- **Plugins**: enabled plugins list

### MCP Servers
- List of connected MCP servers with status indicator
- Per-server: name, status (connected/disconnected/error), tool count, resource count
- View tools provided by each server
- Add/remove servers

### Skills
- List of available skills with descriptions
- Invoke skills from the UI
- Skill output rendered in conversation

### Background Tasks
- List of running background tasks (`/tasks`)
- Task type, status, progress
- View output, kill task

---

## Milestones

### Milestone 0: Proof of Life

The absolute minimum to see something in a browser. No design needed — just plumbing.

**Tech decisions:**
- Browser debug UI directory: root-level `web/` — keeps this historical browser
  surface separate from terminal Ink code.
- WS server: opt-in `--web` flag — no risk to terminal, add always-on later
- Port: fixed `3456`
- CSS framework: Tailwind — decided here so scaffold includes it

**Tasks:**
- [x] **T0.1: Vite + React scaffold** — `web/` directory, Tailwind configured, dark theme base
- [x] **T0.2: WS server skeleton** — Bun WebSocket server, starts on `--web` flag, port 3456
- [x] **T0.3: Message relay** — forward assistant messages from core engine to WS clients as JSON
- [x] **T0.4: Connect frontend to WS** — web app connects, displays incoming messages as plain text
- [x] **T0.5: User input round-trip** — text input in browser → WS → core engine → response streams back
- [x] **T0.6: Auto-open browser** — CLI opens `localhost:5173` in default browser on `--web`

**Dependencies:**
```
Parallel: T0.1, T0.2
Sequential: T0.3 after T0.2
Sequential: T0.4 after T0.1 + T0.3
Sequential: T0.5 after T0.4
Sequential: T0.6 after T0.5
```

**Done when:** You can type a message in the browser, get a streamed response, and see it rendered.

### Milestone 1: Usable Chat

Make the web chat page match what the terminal shows today.

**Design decisions:**
- **Layout**: Claude.ai style — centered column, max-width ~768px, dark background with pink accents. Minimal or no header so the chat gets the space
- **Messages**: flat blocks (no bubbles), subtle role labels (no avatars). User messages on the right, assistant messages on the left, system messages muted. Render markdown for both user and assistant messages; do not trust raw HTML from messages
- **Status bar**: thin bottom bar — model name, effort level, context token usage, active profile, plus text connection state. Do not show cost in Phase 1
- **Input area**: fixed bottom, auto-resize as you type (up to ~40% viewport), Shift+Enter for newline, Enter to send. Focus the input on load and after send
- **Scrolling**: auto-scroll to bottom on new content only while already at the bottom. If the user scrolls up, do not yank them back down; show a jump-to-latest affordance instead
- **Syntax highlighting**: Shiki — better theme support, matches VS Code highlighting. Code block copy buttons appear on hover
- **Markdown rendering**: support headings, bold, lists, blockquotes, inline code, code blocks, and tables. Render tables as real HTML tables
- **Session behavior**: opening the web UI in a new browser tab starts a brand new chat. Refresh returns to the same chat for that tab, and if Cat Code was replying, the page should reconnect and continue showing that reply. The backend is the source of truth for the active chat on refresh
- **Disconnect behavior**: keep the chat visible, disable sending, preserve unsent draft text during reconnect and full refresh for the current tab/session, and show clear reconnecting/disconnected state. Do not queue sends while disconnected
- **Thinking summaries**: show them only when the backend emits them, collapsed by default
- **Scope limits**: no session browser, multi-page shell, tool cards, timestamps, retry button, rename, search, attachments, or copy-full-message action in Phase 1

**Tasks:**
- [ ] **T1.1: Chat layout shell** — centered column, dark/pink theme, minimal empty state, message list + input area
- [ ] **T1.2: Markdown rendering** — render user and assistant responses as sanitized HTML markdown with Shiki code blocks, hover copy button, and real HTML tables
- [ ] **T1.3: Streaming display** — tokens appear as they arrive, follow output at bottom, and show jump-to-latest when new content arrives off-screen
- [ ] **T1.4: Message roles styled** — user/assistant/system visual distinction with user right and assistant left
- [ ] **T1.5: Input area** — fixed bottom, auto-resize, Enter to send, Shift+Enter for newline, preserve focus after send, and retain unsent draft through reconnect/refresh
- [ ] **T1.6: Thinking summaries** — render backend-provided thinking summaries as collapsible blocks, collapsed by default
- [ ] **T1.7: Status bar** — bottom bar with model, effort, context token usage, active profile, and text connection state
- [ ] **T1.8: Session persistence** — a new browser tab starts a new chat; refresh reconnects that tab to the same backend-backed session and restores any in-progress reply

**Dependencies:**
```
Parallel: T1.1, T1.2, T1.5
Sequential: T1.3 after T1.2
Sequential: T1.4 after T1.1
Sequential: T1.6 after T1.2
Parallel: T1.7, T1.8 (independent of above)
```

**Done when:** You prefer the browser over terminal for basic chat.

### Milestone 2: Tool Output

Tool calls as collapsed cards, expand on click.

**Design decisions:**
- **Collapsed card**: single line — tool icon, tool name, brief summary (e.g., file path or command), status badge (spinner/checkmark/X). Inline in conversation flow
- **Expanded card**: expands in-place within conversation (not a slide-out panel). Full output with syntax highlighting
- **Nested agents**: indented with subtle left-border connector lines. Expand to see agent's full conversation recursively
- **ANSI rendering**: ansi-to-html library — lightweight, no need for full terminal emulator
- **Diff rendering**: react-diff-viewer — purpose-built, good for green/red inline diffs

**Tasks:**
- [ ] **T2.1: Tool card component** — generic collapsed/expanded card with icon, name, status badge, click to toggle
- [ ] **T2.2: Bash output renderer** — command, exit code, stdout/stderr with ANSI color via ansi-to-html
- [ ] **T2.3: Read output renderer** — file path, line numbers, Shiki syntax-highlighted contents
- [ ] **T2.4: Edit output renderer** — file path, old→new diff via react-diff-viewer
- [ ] **T2.5: Write/Glob/Grep renderers** — file contents, file lists, search results
- [ ] **T2.6: Agent output renderer** — recursive nested conversation with indented tree connectors
- [ ] **T2.7: Generic tool renderer** — fallback for WebFetch, WebSearch, MCP tools, etc.
- [ ] **T2.8: Progress & error states** — spinner on running, error display with context

**Dependencies:**
```
First: T2.1 (all renderers use it)
Parallel: T2.2, T2.3, T2.4, T2.5, T2.7 (all independent, depend on T2.1)
Sequential: T2.6 after T2.1 (recursive, more complex)
Parallel: T2.8 (independent)
```

**Done when:** You can follow what Cat Code is doing without needing the terminal.

### Milestone 3: Permission & Control

Interactive permission flow and session controls.

**Design decisions:**
- **Permission prompt**: centered modal with backdrop dim — must be impossible to miss. Shows tool name, params, three buttons: Allow (pink/primary), Deny (muted), Always Allow (secondary)
- **Tab closed behavior**: queue permission requests until browser reconnects — agent blocks waiting, no auto-deny (prevents accidental work loss)
- **Controls**: thin control strip above the input area — model dropdown, effort toggle, fast mode toggle, cancel button. Always visible but compact

**Tasks:**
- [ ] **T3.1: Permission modal** — centered modal, tool name + params, Allow/Deny/Always Allow
- [ ] **T3.2: Permission queue** — queue requests when tab disconnected, replay on reconnect
- [ ] **T3.3: Cancel generation** — stop button in control strip (Ctrl+C equivalent)
- [ ] **T3.4: Control strip** — model dropdown, effort toggle, fast mode, clear, compact — above input area
- [ ] **T3.5: WS reconnect** — auto-reconnect on tab reopen, restore session + pending permissions

**Dependencies:**
```
Parallel: T3.1, T3.3, T3.4
Sequential: T3.2 after T3.1
Sequential: T3.5 after T3.2
```

**Done when:** You don't need to touch the terminal to control Cat Code during a session.

### Milestone 4: Multi-Page App

Add pages beyond chat. Navigation between them.

**Design decisions:**
- **Sidebar**: hidden by default — hamburger icon or keyboard shortcut to toggle. Narrow (icon-only collapsed, ~250px expanded). Dark, sits over content (overlay), doesn't push chat
- **Navigation**: sidebar icons for Chat, Agents, Accounts & Usage, Settings. Session list below nav icons when sidebar is expanded
- **Accounts page**: dashboard-style with usage bars — card per account, colored status indicator (green/yellow/red), horizontal progress bars for rate limits, active account highlighted with pink border
- **Agents page**: live dashboard feel — running agents as pulsing cards at the top, completed agents as a table below. Click a card to drill into transcript. Agent status is the "come back and check" screen
- **Session list**: in sidebar when expanded, not its own page

**Tasks:**
- [ ] **T4.1: Client-side routing** — react-router or equivalent, page shell
- [ ] **T4.2: Sidebar** — overlay sidebar, hamburger toggle, icon nav, session list
- [ ] **T4.3: Accounts & Usage page** — provider sections, account cards, usage bars, switch button
- [ ] **T4.4: Agents page** — running agent cards (live), completed agents table, drill-into transcript
- [ ] **T4.5: Session management** — search, resume, rename, new session, tags in sidebar
- [ ] **T4.6: Non-blocking navigation** — navigate freely while agents/generation runs

**Dependencies:**
```
First: T4.1 (routing shell)
Parallel: T4.2, T4.3, T4.4, T4.5 (all depend on T4.1)
Sequential: T4.6 after T4.2 (needs nav to exist)
```

**Done when:** Cat Code feels like a multi-page app, not just a chat box.

### Milestone 5: Slash Commands & Settings

Port remaining terminal features.

**Design decisions:**
- **Command palette**: VS Code style — centered overlay, fuzzy search, keyboard navigable. Opens with Ctrl+K or typing `/` in empty input
- **Settings page**: single scrolling page with section anchors (not tabs) — sections visually separated, jump-to-section links at top

**Tasks:**
- [ ] **T5.1: Command palette** — centered overlay, fuzzy search, keyboard nav, Ctrl+K or `/`
- [ ] **T5.2: Settings page** — scrolling sections with toggles, dropdowns, text inputs
- [ ] **T5.3: Memory viewer** — browse and edit memory files
- [ ] **T5.4: MCP server management** — list, status, tools, add/remove
- [ ] **T5.5: Skill browser** — list skills, invoke from UI
- [ ] **T5.6: Background tasks** — list, status, output, kill
- [ ] **T5.7: Git commands** — commit, diff, review via command palette
- [ ] **T5.8: Doctor/Status** — diagnostic output as modal

**Dependencies:**
```
Parallel: T5.1, T5.2, T5.3, T5.4, T5.5, T5.6 (all independent)
Sequential: T5.7 after T5.1 (needs palette)
Parallel: T5.8 (independent)
```

**Done when:** Every user-facing slash command has a web equivalent or UI.

### Milestone 6: Web-Native Features

Things the terminal cannot do.

**Design decisions:**
- **Images**: inline in conversation, click to open lightbox for full-size
- **Notifications**: in-app visual toast (top-right, auto-dismiss) — not browser native (avoids permission prompts)
- **Theme**: dark/pink is default. Light mode as toggle (far future)

**Tasks:**
- [ ] **T6.1: Inline images** — render images in chat, click for lightbox
- [ ] **T6.2: Clickable file paths** — `file:line` links open in editor
- [ ] **T6.3: Drag-and-drop** — drop files into chat to attach
- [ ] **T6.4: HTML tables** — render markdown tables as real HTML tables
- [ ] **T6.5: Mermaid diagrams** — render mermaid blocks as SVG diagrams
- [ ] **T6.6: Conversation search** — search within message content
- [ ] **T6.7: Toast notifications** — visual toasts for agent completion, permission needed, errors

**Dependencies:**
```
All independent — fully parallel
```

**Done when:** You wouldn't go back to the terminal.

### Milestone 7: Workspace Layout

Multi-pane workspace.

**Design decisions:**
- **Sidebar**: becomes persistent (always visible) at this milestone — user has graduated from chat-only to workspace
- **Split panes**: user-resizable with drag handle. Max 2 panes (chat + one side panel). Side panel can show: file viewer, agent transcript, terminal output
- **Agent tree**: lives in side panel, real-time parent/child hierarchy

**Tasks:**
- [ ] **T7.1: Persistent sidebar** — sidebar always visible, collapsible to icon-only
- [ ] **T7.2: Split pane layout** — resizable chat + side panel, drag handle
- [ ] **T7.3: Agent tree view** — real-time parent/child visualization in side panel
- [ ] **T7.4: Persistent panels** — pin tool outputs to stay visible while chatting

**Dependencies:**
```
First: T7.1, T7.2 (parallel — layout foundation)
Sequential: T7.3, T7.4 after T7.2 (need side panel)
```

**Done when:** The web UI feels like a workspace, not just a chat app.

---

## Future: Mobile

Far-future. Desktop-first for now.

- [ ] Responsive layout for phone/tablet
- [ ] Touch-friendly interactions
- [ ] Depends on Milestone 4 (Server Mac in docs/vision/2026-04-30-GOAL_PLAN.md) for network access

---

## Resolved Decisions

- [x] Port number — **fixed 3456**
- [x] CSS framework — **Tailwind**
- [x] Browser debug UI directory — **root-level `web/`**
- [x] WS server startup — **opt-in `--web` flag**
- [x] Syntax highlighting — **Shiki**
- [x] ANSI rendering — **ansi-to-html**
- [x] Diff rendering — **react-diff-viewer**
- [x] Permissions when tab closed — **queue until reconnect**
- [x] Pane layout — **user-resizable, max 2 panes**

## Open Questions

- [ ] Multiple browser tabs — same session or separate?
- [ ] Survey existing open-source chat UIs for inspiration?

---

## Dependencies on docs/vision/2026-04-30-GOAL_PLAN.md

- **Milestone 4 (Server Mac)** — web UI becomes the primary remote control surface over network
- **Milestone 3 (Persistent Memory)** — memory viewer in Milestone 5 depends on this
- No hard blockers — web UI work can proceed in parallel
