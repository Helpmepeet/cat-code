# Dedicated App UX Reinterpretation Rules

**Status:** Design handoff
**Created:** 2026-05-17
**Audience:** Product design, UX design, UI design, prototype reviewers, and
engineering reviewers who validate that the dedicated app behaves correctly.
**Companion docs:**
`docs/design/2026-05-17-dedicated-app-ui-requirements.md`,
`docs/design/2026-05-17-dedicated-app-figma-prototype-brief.md`,
`docs/design/2026-05-17-dedicated-app-figma-screen-inventory.md`,
`docs/design/2026-05-17-dedicated-app-figma-user-flows.md`,
`docs/design/2026-05-03-dedicated-app-prototype-brief.md`

## Purpose

The dedicated app must preserve what Cat Code already does, but redesign how the
user interacts with it. The terminal UI is the source of truth for behavior,
safety, and capability. It is not the source of truth for visual or interaction
design.

This document gives designers a single set of rules for converting terminal
patterns into app-native UX. When the existing requirements, brief, screen
inventory, or user flow documents reference terminal flows for context, read
those references as "preserve the behavior" — not "clone the interaction."

When this document conflicts with older briefs (especially
`docs/design/2026-05-03-dedicated-app-prototype-brief.md`), this document wins
for interaction design, and
`docs/design/2026-05-17-dedicated-app-ui-requirements.md` wins for what must
be supported. The May 3 brief remains a visual reference only.

## How To Use This Doc

- Designers: read this end-to-end once before drawing frames. While drawing,
  use it as a checklist — the per-surface rules below double as acceptance
  criteria.
- Prototype reviewers: use the Review Heuristics and Acceptance Checklists in
  each surface section to evaluate frames.
- Engineering reviewers: use "What Must Be Preserved" to validate that no
  design choice silently changes behavior. Anything in that list is a
  contract, not a suggestion.
- When a rule is unclear, prefer preservation. A boring app-native control
  that respects the source behavior beats a clever one that drifts from it.

## Why This Is Not A Terminal Clone

Cat Code's terminal UI is dense, command-driven, and modal. That works because
the terminal user has built up muscle memory for slash commands, keybindings,
hidden status indicators, and stacked dialog priority. The dedicated app is for
a wider audience that should not need that muscle memory.

If the app simply embeds the same patterns:

- **Discovery suffers.** Slash commands hide functionality behind syntax. New
  users do not learn what `/effort`, `/reasoning`, `/branch`, `/rewind`, or
  `/usage` even do until someone tells them.
- **Safety suffers.** Modal Ink dialogs stack on top of REPL state. Important
  state — pending permissions, paused goals, blocked sends, rate limits —
  hides in scrollback rather than in persistent UI. The user can miss it.
- **Multitasking suffers.** Terminals foreground one thing at a time. App
  users want live visibility into the goal, the running agents, the running
  tasks, and the most recent tool output at the same time.
- **Recovery suffers.** Disconnect/reconnect, blocked sends, paused goals,
  budget-limited goals, denied tools, reconnect-stale permissions, failed
  turns — currently these are text the user must read. The app must promote
  them to explicit, actionable UI states.
- **Onboarding suffers.** A first-launch user faced with a slash-command-only
  interface has no anchors. App-native controls give them anchors.

The reinterpretation rules below address each of these. Preserve behavior
exactly. Redesign the surface.

## What Must Be Preserved

Designers must not redesign these semantics. Engineering owns them and the app
must respect them. Each item below is a behavior contract — the app surface
can change, the rule cannot.

### Permission and safety semantics

- Allow / deny / ask / always-allow / bypass-immune verdicts.
- Classifier behavior: some tools route to classifier before user is asked.
- Sandbox vs network distinction: sandbox/network approvals are not the same
  as ordinary tool approvals and must be visually distinct.
- Dangerous path protections: `.git`, config files, workspace directory rules.
- Worker/coordinator permission routing: a worker's request may surface to
  the coordinator user with worker identity attached.
- Pending permissions must not auto-resolve on reconnect. Reconnect replay
  cannot count as user consent.
- Stale typing, focus traps, default-button selection, and keyboard
  auto-confirm must not accept a permission decision.

### Goal behavior

- Create, replace, pause, resume, clear are the user-facing actions.
- Completion is not a user toggle. It is reported by runtime/model via
  `UpdateGoalTool` and Agent Mode worker checks.
- Budget accounting (tokens used, time used, remaining) is runtime-owned.
- Continuation signals (idle continuation, budget wrap-up, active-goal loop
  behavior) are runtime-owned.
- Agent Mode synchronization: when Agent Mode is active, goal completion can
  be blocked by unresolved workers.
- Goal state must stay in sync between the chip near the composer, the goal
  detail view, transcript persistence, and `goal.snapshot` events.

### Session persistence

- Same JSONL transcript storage as terminal (`src/utils/sessionStorage.ts`).
- Draft input and visible transcript position must survive refresh and
  reconnect for the active session.
- Cross-project resume warning before opening incompatible context.
- Metadata fields: mode, worktree, goals, content replacements, file history,
  attribution, context collapse, subagent metadata.
- Session list uses the optimized enrichment path; full transcript reads are
  not acceptable for list rendering.

### Tool result meaning

- Input / output / error / cancelled / denied / truncated are distinct states.
- Diff semantics: red/green, line numbers, file path, IDE-open affordance.
- Shell tools preserve stdout/stderr boundaries, ANSI color, exit status,
  sandbox/permission annotations.
- Worker, agent, skill, hook, teammate identity is carried on tool results
  and visible to the user.
- Grouped tool-use (collapsed read/search summaries, hook progress, worker
  badges, teammate labels) is preserved as a card-level concept.

### Auth, account, and model behavior

- Provider routing (Anthropic, Codex/OpenAI, other providers).
- Account pool with aliases, health, capped/dead state, lease/rotation.
- Rate-limit and budget state are not the same as auth state.
- Trust gating: project/plugin/LSP execution must not run before trust is
  established.
- Forced login, org mismatch, missing API key, OAuth in progress, third-party
  provider setup are distinct startup states.

### Agent and task lifecycle

- Task kinds registered in `src/tasks.ts`: local shell, local agent, remote
  agent, dream, and feature-gated workflow/monitor tasks. In-process teammate
  tasks are imported directly by REPL/task navigation.
- Agent Mode roster, durable Agent Mode state file (the on-disk
  `.agent-mode-state.json` written by the runtime), friendly worker names,
  resumable/stale states, synthesis status.
- Retain/resume/kill flows, sidechain transcript bootstrap, output
  symlink/tail display, completion notifications.
- Teammate view, teammate input routing, current-work abort versus full kill,
  team context, color identity.
- Foreground/background transitions for supported types.
- Child cleanup signals when an agent exits.

### MCP, plugin, and skill behavior

- Dynamic command sources: built-in, bundled skills, filesystem skills,
  plugin commands, plugin skills, workflow commands, MCP skills, dynamic
  skills.
- Hot reload: commands, agents, hooks, MCP, LSP, and plugin components can
  refresh during an active session.
- MCP form and URL elicitation are runtime-initiated; the app does not start
  them on its own.
- Marketplace install / enable / disable / update flows respect plugin state.

### Runtime, reconnect, and blocking states

- Send disabling: the user cannot send while disconnected, awaiting permission,
  or while a blocking modal is open.
- Draft preservation across reconnect and refresh.
- Reconnect status is explicit; the user must know whether work is still
  running.
- Stale-permission rejection: any user-pending decision (permission,
  ask-user, plan approval) cannot be replayed as already-accepted.
- Blocked-by-modal semantics: only one decision dialog can take focus at a
  time; the rest queue.
- Paused-goal return choice: next time the session is opened, the user is
  offered Resume or Keep paused.
- Budget-limited goal state: distinct from active and from completed.
- Failed turn handling: distinct from cancelled.

If a design choice changes any of these, that is a behavior change and must go
back to engineering, not into the prototype.

## App-Native UX Principles

These are the seven rules that resolve most design judgment calls. When a
design choice feels arbitrary, walk through these in order.

### 1. Visible over hidden

Persistent state — goal, model, account, context, tasks, agents, connection,
permission mode, IDE — lives in chips, panels, and pages. It does not live
in scrollback or slash command output.

- The user should never have to type a command to find out the current state.
- The user should never have to scroll the transcript to find out what
  happened.
- If a piece of state can change without the user's action, it gets a
  persistent surface (chip, banner, panel, or page indicator).

### 2. Direct over command

Common actions are buttons, menus, drawers, and pages. The command palette is
an accelerator, not the only entry point.

- Every MVP capability has at least one visible path that is not the palette.
- The palette exists for speed, not for hiding capabilities.
- Slash command syntax in the composer is preserved for power users, but is
  never the only way to reach a capability.

### 3. Inspectable over collapsed-only

Tool calls, permissions, sessions, tasks, and agents have detail views that
can be opened without losing chat context.

- Inspect is a first-class affordance. It opens a drawer or page, not an
  overlay that takes the user out of the conversation.
- The user must be able to return from inspect to the exact transcript
  position they came from.
- Tool grouping does not prevent inspection of individual entries.

### 4. Concurrent over modal-stacked

Background work, goals, and permissions are concurrent surfaces. Only true
blocking decisions interrupt the user.

- Modal dialogs are reserved for decisions the user must make right now to
  proceed (permission requests, trust prompts, sandbox approvals).
- Non-blocking state (running tasks, paused goals, budget warnings) uses
  chips, banners, drawers, or pages.
- Sequential pending permissions form a queue with explicit navigation, not
  a modal stack.

### 5. Recoverable over silent

Every failure or constraint — disconnect, reconnect, blocked send, paused
goal, denied tool, rate-limit, budget-limit, reconnect-stale permission,
failed turn — has an explicit UI state with action affordances.

- "Silent" failures are a design defect.
- Every error state names the cause, what is blocked, and at least one next
  action (retry, fall back, manage settings, view details).

### 6. Discoverable over memorized

The user should be able to reach any MVP capability without remembering slash
syntax, keybinding chords, or which terminal screen owns which feature.

- Navigation labels are short and literal: Chat, Sessions, Goals, Tasks,
  Agents, Accounts, Settings.
- Keyboard shortcuts are accelerators, never gates.
- Icon-only buttons must have tooltips and accessible labels.

### 7. Compact, not sparse

This is a dense operational workspace. App-native does not mean
marketing-style hero layouts.

- Information density is favored over white space.
- Status chips are small but readable.
- Avoid oversized hero cards, decorative gradients, and brand-first
  treatments.
- Density does not mean tiny touch targets — controls remain easy to hit.

## Terminal Pattern → Dedicated App Pattern

Use this mapping as the default rewrite for any terminal idiom encountered while
reviewing requirements or older briefs. Anti-patterns are common designs that
look reasonable but violate the principles above.

| Terminal pattern | Dedicated app pattern | Source anchor (preserve) | Anti-pattern (do not do this) |
|---|---|---|---|
| Slash command typed into prompt | Visible control, menu item, page action, or command palette entry | `src/commands.ts`, `src/commands/` | Hide all actions behind a single text input that expects slash syntax. |
| Modal Ink dialog stacked over REPL | App dialog, side drawer, or full page depending on weight | `src/components/permissions/`, `src/components/Settings/` | Reproduce stacked modals where each new dialog hides the previous one. |
| Hidden status in scrollback or footer | Persistent status chip, banner, or status panel | `src/components/StatusNotices.tsx`, `src/components/PromptInput/Notifications.tsx` | Put state as a transcript line that scrolls away. |
| Tool output in transcript lines | Structured tool card with collapsed summary and inspectable detail view | `src/tools/*/UI.tsx`, `src/components/messages/AssistantToolUseMessage.tsx`, `src/components/messages/UserToolResultMessage/` | Dump raw JSON or shell output as a wrapped text block. |
| `/resume` and `/branch` command flow | Session sidebar/browser with new/resume/fork/rewind actions | `src/screens/ResumeConversation.tsx`, `src/components/LogSelector.tsx`, `src/utils/sessionStorage.ts` | Require typing `/resume` to switch sessions. |
| `/goal` create/pause/resume/clear typed in prompt | Goal status chip near composer plus full goal detail panel/page | `src/utils/threadGoal.ts`, `src/commands/goal/`, `src/tools/CreateGoalTool/`, `src/tools/UpdateGoalTool/` | Show goal state only as transcript lines from tool output. |
| `/agents`, `/tasks` typed in prompt | Live Agents and Tasks pages with inspect/stop and in-chat indicators | `src/agent-mode/`, `src/tasks.ts`, `src/components/tasks/` | Make background work invisible unless the user types a command. |
| `/permissions`, `/sandbox` typed in prompt | Settings page sections with rule management and visible permission mode | `src/utils/permissions/`, `src/commands/permissions/` | Edit rules only through a transient terminal dialog. |
| `/model`, `/effort`, `/fast`, `/reasoning`, `/vim` | Composer-adjacent controls and menus | `src/components/ModelPicker.tsx`, `src/commands/model/`, `src/commands/effort/`, `src/commands/fast/`, `src/utils/effort.ts`, `src/utils/fastMode.ts` | Bury model and effort selection inside Settings. |
| `/mcp`, `/plugin`, `/skills`, `/hooks` typed in prompt | Settings pages with status, list, install/manage actions | `src/services/mcp/`, `src/commands/mcp/`, `src/commands/plugin/`, `src/commands/skills/`, `src/commands/hooks/` | Treat MCP/plugins/skills as opaque slash-command output. |
| `/doctor`, `/status`, `/stats`, `/cost`, `/usage` | Diagnostics page and inline status chips | `src/screens/Doctor.tsx`, `src/commands/doctor/`, `src/commands/status/`, `src/commands/stats/`, `src/commands/cost/`, `src/commands/usage/` | Spawn one modal per diagnostic command. |
| Keyboard-only navigation between dialogs | App navigation with sidebar, tabs, palette, and keyboard accelerators | `src/keybindings/`, `src/screens/REPL.tsx` | Require chorded keybindings to reach a screen with no visible entry. |
| Terminal disconnect implied via inactivity | Explicit connection chip, banner, and send-disabled state | `src/hooks/useRemoteSession.ts`, `src/hooks/useDirectConnect.ts`, `src/bridge/` | Let the composer look normal while the runtime is gone. |
| MCP form/URL elicitation as terminal prompt | App dialog tied to the requesting session, not buried in settings | `src/services/mcp/`, `src/components/mcp/` | Treat an elicitation as a settings row that the user must discover. |
| Ask-user tool as inline terminal question | App dialog or in-thread action card tied to the requesting tool | `src/tools/AskUserQuestionTool/` | Print the question as a transcript line and rely on the next user prompt as the answer. |
| Slash command output as transcript noise | Result rendered as a result card, page, or inline confirmation toast | `src/commands.ts` local/local-jsx return types | Replay raw command output as plain text in the chat. |
| Hidden idle-return / cost / token / channel dialogs | Explicit non-blocking banners with action affordances | `src/services/tips/`, `src/services/PromptSuggestion/`, `src/components/StatusNotices.tsx` | Block the user with a modal for non-urgent notifications. |
| Active turn indicated only by a spinner glyph | Streaming chat state with stop button, elapsed timer, and current tool surface | `src/screens/REPL.tsx`, `src/components/Spinner.tsx` (terminal owner) | Show only an opaque spinner with no way to stop. |
| Brief/transcript copy commands | Per-message copy/share affordances plus a session-level export action | `src/commands/copy/`, `src/commands/export/` | Force the user to use a slash command to copy a single message. |
| Vim mode and mode cycling | App keybinding profile selection with a visible mode indicator | `src/hooks/useVimInput.ts`, `src/commands/vim/` | Hide Vim mode behind an undiscoverable keybinding. |
| IDE auto-connect / status indicator in footer | IDE status chip with open/diagnose/disconnect menu | `src/hooks/useIDEIntegration.tsx`, `src/components/IdeStatusIndicator.tsx` | Show IDE state only as a tiny glyph the user cannot click. |

When a Figma frame needs to represent a feature that the terminal handles via a
slash command or dialog stack, designers should pick the corresponding
right-column pattern, cite the source anchor in the annotation, and avoid the
anti-pattern.

## Navigation Model

This is the canonical navigation structure. Designers should not introduce new
tiers (e.g., a separate "Projects" tier) without engineering review.

### Sidebar (primary navigation)

Always visible on desktop MVP. Contents from top to bottom:

1. Workspace identity (project name, workspace switcher if multiple).
2. Session search input.
3. Section navigation: **Chat** (default), **Sessions**, **Goals**, **Tasks**,
   **Agents**, **Accounts**, **Settings**.
4. Sessions list, grouped by workspace, with active session highlighted.
5. Footer with account/auth summary and connection status.

States the sidebar must show:

- Active section indicator.
- Session count or unread/active indicator per section where relevant.
- Connection state at the footer (Connected / Reconnecting / Disconnected).
- Auth state at the footer (Logged in as X / Login required).

### Top tab bar (per-workspace)

Multiple open chats within the workspace. Add and close controls. Tabs show
indicators for:

- Active turn (subtle spinner or pulse).
- Permission pending (warning glyph).
- Running background work (count badge or dot).
- Goal state (paused / budget-limited / completed evidence ready).

### Main panel (chat default)

The largest surface. By default it shows the active chat. When the user opens
another section (Sessions, Goals, Tasks, Agents, Accounts, Settings,
Diagnostics), it replaces the main panel — the sidebar and tab bar persist.

One to three resizable chat panels are supported, with one active panel.
Split-panel is a parity affordance; MVP can ship with one panel as long as the
architecture leaves room for split-panel later.

### Right inspector (contextual drawer)

A side drawer that can show:

- Goal detail.
- Tool card detail.
- Task/agent detail.
- Permission rule preview.
- Diff inspector.
- File reference preview.

The inspector is contextual to the main panel. Closing it returns the user to
the same scroll position in the main panel.

### Command palette (accelerator)

`Cmd/Ctrl+K` or equivalent. Searches commands, sessions, and quick actions.
Not the only way to perform anything in the MVP. See Command Palette Rules.

### Keyboard model

- `Cmd/Ctrl+K`: open command palette.
- `Cmd/Ctrl+N`: new session.
- `Cmd/Ctrl+,`: open Settings.
- `Cmd/Ctrl+/`: open keybindings help.
- `Esc`: close top-most dialog/drawer; if none open, return focus to composer.
- `Enter`: send (when composer focused and not in newline mode).
- `Shift+Enter` or configured chord: insert newline.
- Up/Down in empty composer: prompt history navigation.
- Tab inside composer with `/`: complete slash command.
- `@`: open mention picker (files, IDE, channels).

Every keyboard shortcut must have a visible analog (button, menu, or palette
entry). Keyboard shortcuts must be customizable through Settings →
Keybindings without assuming terminal key semantics.

## Command Palette Rules

The palette is an accelerator, not the primary surface for MVP capabilities.

### Reach rule

Every MVP action listed in
`docs/design/2026-05-17-dedicated-app-ui-requirements.md` must also be
reachable from a visible control, menu, or page. If a capability can only be
found via the palette, that is a design defect.

### Row contents

Each palette row shows:

- Name and primary alias (e.g., "Resume session" / `/resume`).
- Description (short, one sentence).
- Source badge: built-in, skill, workflow, plugin, MCP, dynamic.
- Argument hint when the action takes arguments.
- Availability state (enabled, disabled with reason, requires permission,
  requires login, feature-gated off).
- Optional keyboard shortcut if assigned.

### Search behavior

- Substring match on name, alias, and description.
- Fuzzy match acceptable for name and alias only.
- Recent actions shown when search is empty.
- Recent actions exclude any action with sensitive arguments.
- Results grouped by category when search is empty; flattened when searching.

### Routing rules

The palette routes commands according to their type:

- Prompt-type commands → injected into the model prompt for the current
  session.
- Local commands → execute and produce an inline result card or toast.
- Local-JSX commands → open an app dialog, drawer, or page. Never a terminal
  JSX surface.

### History and sensitivity

- Sensitive arguments (tokens, passwords, account IDs that should not be
  surfaced) must not appear in palette history or recent rows.
- The palette should not echo arguments back to the user once submitted if
  the underlying command treats them as sensitive.

### Disabled state

- Disabled commands are visibly disabled with a tooltip explaining why
  (e.g., "Requires login," "Disabled by feature flag," "MCP server is
  disconnected").
- Disabled commands are not hidden silently. Hiding makes the palette feel
  unreliable.

### MVP action coverage

The palette must include at minimum:

- Chat/session: clear, compact, resume, rename, branch, rewind, tag, copy,
  export, search current session, search global.
- Model/control: model, effort, reasoning, fast, vim.
- Safety: permissions, sandbox, allowed tools where available.
- Goal/task: goal, active task status, common task inspect/stop.
- Runtime: status, doctor, cost, usage, stats, context, diff.
- Account: login, logout, accounts, switch account.
- Extension: MCP, plugin, skills, hooks, IDE, Chrome.

Parity adds:

- Agent Mode launch and worker management.
- Full task management.
- Feature-gated and plugin-provided commands.
- Workflow, remote, proactive, and native integration commands.

## Status And Notification Rules

There are four notification kinds. Use the right one for the right purpose.

### Persistent chips

For state that is always relevant while the user is in chat:

- Active model.
- Provider.
- Account.
- Permission mode.
- IDE status.
- Goal status.
- Context usage.
- Running task count.
- Connection state.
- Fast / thinking / vim mode where active.

Chips are clickable. Clicking opens the relevant menu, page, or detail view.

### Banners

For transient but blocking state. Anchored to the top of the chat or the
session:

- Disconnected.
- Reconnecting.
- Rate-limited.
- Invalid settings.
- Managed-settings warning.
- Update available.
- Budget-limited goal.
- Paused goal on return.
- Reconnect failed.
- MCP server elicitation pending (for the active session).

Banners include at least one primary action (Retry, Manage, Resume, Dismiss
where safe).

### Toasts

For confirmation of user-initiated actions. Auto-dismiss after a few seconds:

- Command completed.
- Account switched.
- Tool denied.
- Task stopped.
- Draft saved.
- Setting saved.

Toasts must never carry blocking information.

### In-chat indicators

For runtime activity tied to the current turn:

- Spinner with elapsed time.
- Streaming reasoning block.
- Currently running tool.
- Permission pending placeholder in the transcript pointing to the dialog.

### Inspector entries

For state the user may want to expand without leaving chat:

- Full goal detail.
- Permission rule list.
- Task detail.
- Agent detail.
- Diff detail.

### Non-negotiable rules

- No notification surface may quietly carry blocking information. If the user
  must act, use a banner or dialog.
- No notification surface may auto-dismiss state that affects safety
  (e.g., a pending permission cannot vanish from view because the user did
  not click within N seconds).
- Reconnect must not replay any user-pending decision (permission, ask-user,
  plan approval) as already-accepted.
- Notifications must be screen-reader announced according to severity (alert
  for blocking, status for informational).

## Permission Dialog Rules

Permissions are the strictest safety surface. The app must keep these rules.

### Dialog content

Every permission dialog shows:

- Tool/action name.
- Parameters or command preview, with sensitive values masked when the
  underlying tool marks them sensitive.
- File path / working directory / target URL where applicable.
- Agent/worker identity when the request comes from a worker.
- Current permission mode (e.g., "Default," "Plan," "Accept edits").
- Rule implications: what an "Always allow" decision would create as a rule.
- Updated input where the source tool exposes one (e.g., a Bash command
  edited by a hook).

### Action buttons

- Allow once.
- Deny.
- Always allow (only when the underlying permission variant supports it).
- Cancel-equivalent (Esc) routes to the safe default: deny without saving a
  rule.

Sandbox and network approvals are visually distinct from ordinary tool
approvals (different accent color, different icon, clear label).

### Anti-stale rules

- The dialog must require an explicit click on Allow once, Deny, or Always
  allow. No keyboard auto-confirm on focus.
- Reconnect must not replay a pending dialog as already-accepted.
- Stale typing in the composer or focus traps cannot trigger a permission
  decision.
- If the same tool re-requests permission after a denial, the new request is
  a fresh dialog, not a continuation.

### Queueing

- Sequential pending permissions form a queue with explicit navigation
  ("1 of 3, Next") — not a modal stack.
- The user can cancel out of the queue and return to chat, leaving the
  remaining decisions visibly pending.

### Manage rules shortcut

- The dialog may offer a "Manage rules" shortcut that opens Settings →
  Permissions in a new pane or drawer.
- Opening Manage rules must not auto-accept the pending decision.

### Permission variants to cover

The dialog system must support all current variants: Bash, PowerShell, file
edit, file write, filesystem (broader path), notebook edit, web fetch, skill,
ask-user, computer-use, worker pending, plan-mode enter/exit, sandbox, sed
edit, and fallback.

## Tool Card And Detail Rules

Tool calls are first-class work artifacts. They are not transcript noise.

### Collapsed card

Shows:

- Tool name and icon/label.
- Status: queued, running, needs permission, succeeded, failed, cancelled,
  denied, output truncated.
- Summary line: target (file path, URL, command preview).
- Elapsed time or progress where available.
- Source identity (agent name, worker name, skill name, teammate name) when
  relevant.

### Expanded detail

Shows:

- Structured input.
- Structured output, with the right renderer for the tool type.
- Error or rejection reason when relevant.
- Metadata (model, tool ID, timestamps).

### Specialized renderers (preserve terminal meaning)

- File read / write / edit with diff: red/green, line numbers, file path,
  open-in-IDE affordance when IDE is connected.
- Bash / PowerShell: stdout/stderr boundaries, ANSI color, exit status,
  sandbox/permission annotations.
- Web fetch / search: URL, status code, content type, content preview.
- MCP calls: server identity, tool identity, structured arguments and
  results.
- Images: inline preview with click-to-enlarge in inspector.
- Notebook edits: cell-level diff.
- Goal tools (`GetGoal`, `CreateGoal`, `UpdateGoal`): map to goal chip/page
  state, not transcript-only.
- Task tools, worker tools, agent tools: link to the corresponding entry on
  the Tasks/Agents page.

### Long output handling

- Long outputs use collapse, virtualization, lazy load, or tail behavior.
- Truncation is visible. The user knows when output was truncated and can
  request the tail or full output where the runtime supports it.
- Long outputs remain responsive — no UI freeze, no scrollback eating memory.

### Error, cancel, deny, reject states

- Each renders distinctly. The user can tell at a glance whether a tool
  failed because of an error, was cancelled by the user, was denied by
  permission, or was rejected by the user reviewing a plan.

### Grouping

- Collapsed read/search summaries, hook progress, worker badges, teammate
  labels are preserved as card-level concepts.
- A group can be expanded to inspect individual entries.

### Inspect affordance

- Every tool card has an Inspect action that opens the right inspector with
  full detail.
- The main panel scroll position is preserved when inspecting.
- The inspector can be closed and re-opened on the same tool card by clicking
  it again.

## Session Redesign Rules

Sessions are a sidebar/browser surface, not a command result.

### List rendering

The session list shows, per row:

- Title (auto-generated or user-set).
- Project / workspace label.
- Last activity timestamp.
- Model used.
- Token / cost hints when available.
- Tags.
- Agent metadata (e.g., "Agent Mode," teammate identity).
- Cross-project indicator when the user is viewing all-project results.

The list must use the optimized enrichment path. Full transcript reads are
not acceptable.

### Primary actions

- New session: primary action in the sidebar and tab bar.
- Resume: primary action on each session row.
- Switch active panel: when split-panel is enabled, the user can choose which
  panel to load the session into.

### Cross-project resume

A cross-project resume must show an explicit warning dialog before opening
incompatible context. The dialog explains:

- Which project the session belongs to.
- Which project the user is currently in.
- What context will be different (working directory, plugins, MCP servers,
  permission rules).
- An explicit Confirm and Cancel.

### Parity actions

- Rename.
- Tag.
- Branch / fork.
- Rewind with file history.
- Export.
- Copy.
- Current-session history search.
- Global semantic search.
- All-project browsing.

### Persistence across reconnect

- Draft input and visible transcript position survive refresh and reconnect
  for the active session.
- Pending permissions are preserved (not auto-accepted).
- In-flight tool runs continue to surface their state when the connection
  comes back.

## Goal Redesign Rules

### Goal status chip

Near the composer. Always visible when a goal is active.

- Objective short-form (truncated to a reasonable width with tooltip
  showing the full objective).
- Status: active / paused / budget-limited / completion reported.
- One-glance budget indicator (e.g., "14% used" or "12 min elapsed").

Clicking the chip opens the goal detail panel.

### Goal detail panel/page

Shows:

- Objective in full.
- Status.
- Tokens used, time used.
- Remaining budget (when set).
- Continuation status.
- Paused / budget-limited / completion reported state.
- Linked completion evidence from `UpdateGoalTool` and Agent Mode worker
  checks.
- Linked Agent Mode workers (when relevant) that block completion.

### User-facing controls

- Create.
- Replace.
- Pause.
- Resume.
- Clear.

### Completion semantics

- Completion is not a user toggle. It is reported by runtime/model.
- The detail panel shows the evidence (worker checks, tool output) that the
  runtime/model used to declare completion.
- If completion is blocked by active workers, the panel shows which workers
  and links to them in the Agents page.

### Paused return

Next time the session is opened with a paused goal, the user is offered:

- Resume the goal.
- Keep paused.

This is a non-blocking banner or inline action card, not a modal.

### Budget-limited state

When the runtime reports budget-limited, the panel shows the final evidence,
the budget that was consumed, and a clear option to extend (where the
underlying tool supports it) or clear the goal.

### Sync rules

Goal state must stay in sync between the chip, the detail panel, transcript
persistence, and `goal.snapshot` events from the app runtime. The chip and
panel must never disagree.

## Task And Agent Redesign Rules

Tasks and Agents are live pages reached from the sidebar, with in-chat
indicators when work is active.

### List structure

- Active list and Completed list are distinct sections.
- Filters by type and status.
- Sort by most recent activity by default.

### Row contents

- Type (shell, local agent, remote agent, dream, workflow, monitor,
  teammate).
- Status (running, waiting, needs permission, completed, failed, stopped,
  stale/resumable).
- Description or prompt (truncated, tooltip for full).
- Elapsed time.
- Progress summary (e.g., "3 tools, 2 files," "step 4 of 7").
- Tool count or activity hint.
- Token / cost when available.
- Last event (e.g., "wrote a file," "awaiting permission," "ran a shell
  command").

### Row actions

- Inspect (opens detail).
- Stop (with confirmation where current behavior requires it).
- Foreground (for supported types).
- Resume (for stale/resumable workers).

### Detail view

Opens in a drawer or page. Contains:

- Worker / task transcript or output (live-updating).
- Tool cards as in the main chat.
- Permission decisions made by or for this worker.
- For Agent Mode: friendly worker name, role, synthesis status.
- For remote agents: CCR URL open, archive, kill controls.
- For shell tasks: stdout/stderr tail.

### In-chat indicator

- Shown near the composer or in the tab bar when work is active.
- Clicking the indicator opens the Tasks or Agents page filtered to running
  work.

### Agent Mode parity additions

- Roster view with all workers.
- Durable Agent Mode state (the runtime's on-disk
  `.agent-mode-state.json`) reflected in the page (workers persist across
  restart).
- Worker control: launch, foreground, stop, resume.
- Synthesis status.
- Teammate view, teammate input routing.
- Current-work abort vs full kill semantics preserved as distinct actions.
- Color identity for teammates.

### Worker-blocked goal completion

Visible from the goal detail and cross-linked to the blocking workers. The
user can navigate from goal → blocking worker → worker detail.

### Lifecycle rules

- Foreground/background transitions are explicit user actions.
- Child cleanup: when an agent exits, its child tasks are cleaned up; the UI
  reflects this.
- Output symlinks and tails are preserved for shell tasks.
- Completion notifications surface as toasts and as indicator chip changes.

## Settings Redesign Rules

Settings is a structured page organized by user intent, not by terminal
command names.

### Categories

Suggested top-level categories (designers can refine ordering with engineering
input):

- **General.** Default model, default provider, default permission mode,
  language.
- **Model & Inference.** Model picker, effort/reasoning, fast mode, thinking
  toggle, output style, brief mode.
- **Permissions.** Rule list, recent denials, workspace directories,
  classifier permission controls, debug/explanation toggles.
- **Workspace.** Trust state, working directory, additional directories,
  detected repository info.
- **Privacy.** Privacy settings, telemetry toggles.
- **Keybindings.** Configurable shortcuts. App-native, not terminal-mode.
- **Theme & Output.** Theme picker, output style picker.
- **MCP.** Server list, status, tools, resources, add/remove/import/reconnect,
  approval state.
- **Plugins.** Marketplace, installed plugins, install/enable/disable/update,
  plugin settings/options.
- **Skills.** Skill browser, skill sources, skill enable/disable.
- **Hooks.** Hook list, status, result state.
- **IDE & LSP.** Connection, manual connect/disconnect, LSP status,
  diagnostics.
- **Native Integrations.** Chrome, computer-use, desktop handoff, mobile QR,
  voice.
- **Diagnostics.** Doctor, Status, Stats, Cost, Usage, cache stats,
  validation errors, sandbox doctor, environment warnings, native install
  locks, debug/error log access.
- **Managed.** Read-only managed settings with explanations.

### Per-setting metadata

Each setting shows:

- Source distinction: user / project / local / flag / policy.
- Validation error if the current value is invalid.
- Read-only managed indicator with explanation when applicable.
- Reset to default action.

### MCP behavior

- Server list with status (connected / disconnected / authenticating /
  error).
- Tools and resources per server.
- Add via JSON / URL / command.
- Approval flow for newly added servers.
- Reconnect action with explicit status.
- Form and URL elicitations are app dialogs anchored to the requesting
  session — they live in the active chat surface, not as settings rows.

### Plugin behavior

- Marketplace browse, search, install.
- Installed list with enable/disable/update.
- Per-plugin settings/options.
- Hot-reload state is visible (e.g., "Reloading commands…").

### Skills behavior

- Skill browser by source (bundled, filesystem, plugin, MCP, dynamic).
- Each skill shows its invocation surface and a preview of its description.
- Enable/disable per skill source where applicable.

### Hooks behavior

- Hook list grouped by event.
- Per-hook status (last run, last result).
- Error visibility when a hook fails.

### Diagnostics

Doctor, Status, Stats, Cost, Usage, cache stats, validation errors, sandbox
doctor, environment warnings, native install locks, and debug/error log
access live as pages or panels — not modal command output.

## Accounts Redesign Rules

The Accounts page (and the composer-adjacent account menu) is the primary
surface for auth, account pool, and rate-limit state.

### Composer-adjacent account menu

Shows:

- Active account name and alias.
- Provider.
- Quick switch to other accounts in the pool.
- Login, Logout, Manage accounts.
- Rate-limit / capped / dead state indicator.

### Accounts page contents

- Account list grouped by provider.
- Per-account state: health, alias, account ID where applicable, usage hints,
  credit balance.
- Active account indicator.
- Main lease and subagent leases (for Codex).
- Failover / rotation history.
- Per-account actions: rename, delete, touch-all, set active.

### Usage and cost

- Session cost and token usage near the composer (chip).
- Detailed usage and cost as a Diagnostics page or Accounts sub-page.
- Cache usage display.
- Per-model usage when available.
- Rate-limit options where the underlying surface supports them.

### Auth states

- Logged out: explicit login CTA.
- Logged in: account chip and menu.
- Multiple accounts: pool-aware menu.
- Switch pending: loading state, no silent failures.
- Rate-limited: banner plus chip state.
- Capped / dead: distinct from rate-limited; explicit treatment.
- Forced login, org mismatch, missing API key, OAuth in progress,
  third-party provider setup: distinct startup states with their own UI.

## Prompt Composer Rules

The composer is the most-used surface. Treat it carefully.

### Primary controls

- Multiline text area with Enter-to-send and a configured newline chord.
- Send button (icon plus label or just label, with tooltip).
- Stop button when a turn is active.
- Slash command autocomplete as the user types `/`.
- File / context mention picker as the user types `@`.
- Attachment chips for pasted images and large text.
- Prompt history navigation.

### Composer-adjacent indicators

These chips/menus live right around the composer (above, below, or to the
side):

- Model.
- Provider.
- Effort.
- Reasoning.
- Fast mode.
- Thinking toggle.
- Permission mode.
- Context usage.
- Goal status.
- IDE status.
- Task / agent count.
- Connection state.
- Account.

Each chip is clickable to open the relevant menu, page, or detail view.

### Send-disabled rules

The Send button is disabled when:

- Disconnected.
- Awaiting permission (and the pending dialog is on this session).
- Blocking modal is open.
- Required auth is missing.
- Required trust is not established.

When disabled, the Send button shows the reason in a tooltip, and a banner
explains the state.

### Draft preservation

- Draft text and attachments survive refresh and reconnect for the active
  session.
- Pasted images and pasted large text are stored as attachments, not inlined
  into the visible text where they would bloat the field.

### Parity composer behavior

- Vim mode and mode cycling, with visible mode indicator.
- External editor handoff.
- Prompt stash.
- Side-question handling.
- Prompt suggestions / speculation.
- Voice push-to-talk where enabled.
- Teammate / agent input routing where enabled.
- Configurable keybindings.

## Chat And Transcript Rules

### Message types to support

User, assistant, system, attachment, progress, compact-boundary,
snip-boundary, rate-limit, shutdown, hook-progress, task-assignment.

### Streaming

- Streaming text renders incrementally.
- Streaming reasoning/thinking summary renders incrementally, collapsed by
  default (governed by existing verbose/thinking settings).
- Streaming tool activity surfaces as a tool card with status updates.

### Scroll behavior

- Preserve scroll position when the user is reading earlier messages.
- Jump-to-latest control appears when the user is scrolled away from the
  bottom.
- New-message count shows on the jump-to-latest control.
- Scrolling all the way down dismisses the jump-to-latest control.

### Message actions

- Per-message copy.
- Per-message timestamp / model metadata (parity).
- Per-message expand/collapse when applicable.

### Markdown and content

- Markdown with code blocks, tables, inline code, safe HTML handling.
- Images render inline with click-to-enlarge.
- File attachments render as inspectable chips.

### Boundaries

- Compact boundary and snip boundary render as small dividers with an
  explanatory tooltip — preserving the existing context-change semantics.

### Sidechain / local-agent transcript

- A toggle or sub-tab lets the user switch into a sidechain/local-agent
  transcript without leaving the session.

## Per-Surface State Specs

For every MVP surface, the Figma file should cover the relevant subset of
these states. The acceptance bar is: every state can be reached in the
prototype, and every state has explicit treatment.

### Chat workspace states

- Empty session.
- Streaming text.
- Streaming tool activity.
- Waiting for permission.
- User scrolled away from latest.
- Error in turn.
- Turn cancelled.
- Disconnected during turn.

### Composer states

- Empty.
- Draft with text.
- Long prompt.
- Command autocomplete open.
- Mention picker open.
- Attachment pending.
- Disabled while disconnected.
- Disabled while awaiting permission on this session.
- Blocked by modal/permission.

### Permission dialog states

- Tool approval.
- File / path approval.
- Shell approval.
- Sandbox / network approval.
- Worker / agent approval.
- Denied.
- Always-allow saved.
- Stale request after reconnect (re-presented, not auto-accepted).
- Queue: 1 of N pending.

### Tool card states

- Queued.
- Running.
- Needs permission.
- Succeeded.
- Failed.
- Cancelled.
- Denied.
- Output truncated.
- Expanded vs collapsed.

### Session list states

- Empty list.
- Loading list.
- Active session.
- Archived / older session.
- Cross-project session.
- Resume failed.

### Goal states

- No goal.
- Active goal.
- Paused.
- Budget-limited.
- Completion reported by runtime/model.
- Cleared.
- Completion blocked by active workers (parity).

### Tasks / agents states

- No background work.
- Running.
- Waiting.
- Needs permission.
- Completed.
- Failed.
- Stopped.
- Stale / resumable.

### Account states

- Logged out.
- Logged in.
- Multiple accounts.
- Switch pending.
- Rate limited.
- Capped / dead.
- Usage unavailable.
- Model unavailable.

### Connection states

- Connected.
- Reconnecting.
- Disconnected.
- Reconnect failed.

## Empty State Guidelines

Empty states are working states, not marketing copy.

- The empty state offers a direct next action (e.g., "Start a new chat,"
  "Resume a session," "Create a goal").
- The empty state does not include product education or onboarding hero
  content.
- The empty state has the same chrome (sidebar, tab bar, status chips) as
  the populated state, so the user is not jarred.
- An empty list (sessions, tasks, agents, accounts) explains what would
  appear here and how to create the first item.

Examples:

- Chat empty session: composer prominent, a small list of suggested first
  prompts (optional), no full-page hero.
- Sessions empty: "No sessions yet in this workspace. Start a new chat or
  resume one from another workspace."
- Tasks empty: "No background work right now. Tasks and agents will appear
  here when they start."
- Permissions empty: "No saved permission rules. Allow once decisions appear
  here when you save them as Always allow."

## Error Taxonomy

Errors fall into one of these categories. Each has a required UI treatment.

| Category | Examples | UI treatment | Required next actions |
|---|---|---|---|
| Auth | Missing API key, OAuth failed, forced login, org mismatch | Startup-blocking screen or banner with login CTA | Start login, Switch account, Open Accounts |
| Permission | User denied, classifier denied, sandbox denied | Tool card denied state, no global banner | Retry tool, Manage rules |
| Rate / budget | Rate limited, capped, budget-limited goal | Banner plus chip; goal page shows evidence | Switch account, Wait, Clear goal, Extend |
| Connection | Disconnected, reconnecting, reconnect failed | Banner plus connection chip; send disabled | Retry connection, Fallback to terminal |
| Runtime | Failed turn, tool internal error, MCP server error | Tool card failed state or in-chat system message | Retry, Inspect error, Report |
| Settings | Invalid config, validation error, managed conflict | Settings page row with inline error | Edit value, View source, Open managed view |
| External | IDE disconnected, MCP elicitation pending, plugin install failed | Inline status or dialog tied to source | Reconnect, Resolve elicitation, Retry install |

Every error UI must include:

- What happened (one sentence).
- What is blocked or affected.
- At least one next action.
- A path to more detail (Inspect, View logs, Open Diagnostics).

Error UIs must not auto-dismiss. The user dismisses or resolves them.

## Density And Layout Rules

This app is dense. Aim for screens that respect the operator's time.

- Avoid hero composition: oversized rounded cards, marketing-scale headings,
  vertical breathing room beyond what readability requires.
- Status chips are small but readable. Treat them like cockpit indicators.
- Tool cards are compact when collapsed; rich when expanded.
- Lists (sessions, tasks, agents, accounts) use compact rows with one
  primary line and one secondary line.
- Settings categories use a left rail navigation with a denser right pane.
- Resize behavior is preserved across panels.
- Dark base by default with restrained contrast and clear hierarchy. Light
  mode can come later; it is not MVP.

Density does not mean tiny touch targets. Minimum hit area is preserved per
accessibility rules below.

## Copy Guidelines

App copy is literal and operational. It is not marketing.

- Use literal nouns and verbs. Not "Begin your journey." Just "Start a new
  chat."
- Permission copy explains the action, target, and consequence before the
  user chooses.
- Empty states offer direct actions.
- Error states say what happened, what is blocked, and what is available.
- Goal language distinguishes user controls (Create, Pause, Resume, Clear)
  from runtime completion (Completion reported / Completion evidence).
- Background work labels make task type and current state obvious.
- Toasts are 4–8 words. Banners are one or two sentences. Dialog bodies are
  one short paragraph plus details.
- Avoid jargon that the terminal uses without exposition. "REPL," "Ink,"
  "JSX surface" do not belong in user-visible app copy.
- Slash command names can appear in tooltips and palette aliases, but never
  in primary UI labels.

## Accessibility Rules

- Every icon-only button has an accessible label and tooltip.
- Color is not the only signal. Status uses color plus a glyph or label.
- Keyboard navigation reaches every action. Focus order is logical.
- Modal dialogs trap focus, but Esc always escapes safely (deny default for
  permissions; cancel for non-safety dialogs).
- Screen-reader announcements:
  - Streaming text uses a polite live region.
  - Permission dialogs use an assertive live region on open.
  - Toasts use a polite live region.
  - Banners with blocking severity use assertive.
- Minimum hit area: 32px square or larger for primary controls. 24px is
  acceptable for chips and dense indicators with tooltip.
- Color contrast meets WCAG AA. AAA is preferred for body text on dark
  surfaces.
- Reduced motion preference disables non-essential animation. Spinner and
  pulse can remain in a reduced form.

## Performance And Latency Expectations

Design for these latency budgets. If a design choice would violate them,
flag it for engineering before drawing it.

| Surface | Budget | Notes |
|---|---|---|
| Composer keypress | < 16 ms | Must feel native. No layout shift on keypress. |
| Send → first streaming token | < 1 s typical | UI shows streaming state immediately; first token arrives soon after. |
| Streaming render | 60 fps | No frame drops while text streams. |
| Tool card status update | < 100 ms after event | Cards reflect runtime state quickly. |
| Session list open | < 200 ms | Use the optimized enrichment path. Do not block on full transcript reads. |
| Palette open | < 100 ms | Should feel like a keyboard accelerator, not a navigation. |
| Permission dialog open | < 100 ms after request | Cannot lag, or the user types past it. |
| Drawer open | < 150 ms | Inspector should feel instant. |
| Settings navigation | < 200 ms between categories | Categories should not re-fetch unless data is missing. |

For long-running operations (loading transcripts, installing plugins,
running diagnostics), use determinate progress when the runtime can provide
it, otherwise a stable indeterminate state. Never show a frozen UI.

## Anti-Patterns Quick Reference

These are mistakes that look reasonable until you read the source behavior:

- Putting goal state only in transcript lines.
- Letting a permission dialog auto-confirm on Enter or Esc.
- Hiding feature-gated commands silently in the palette.
- Stacking modal dialogs so the user must dismiss one to see the next.
- Treating MCP elicitation as a settings row instead of an active dialog
  tied to the requesting session.
- Letting the composer look normal while the runtime is disconnected.
- Spawning a separate modal for each diagnostic command (`/doctor`,
  `/status`, `/stats`, `/cost`, `/usage`) instead of a Diagnostics page.
- Requiring keybinding chords to reach a screen with no visible entry.
- Using "Complete goal" as a user button.
- Dropping pending permissions on reconnect.
- Embedding the terminal transcript directly in a panel.

## MVP vs Parity Guidance For Designers

When a requirement appears in
`docs/design/2026-05-17-dedicated-app-ui-requirements.md` under "MVP" or
"Parity," use that as the priority signal. When a Figma frame is in the MVP
clickable scope, apply these guardrails.

### MVP frames

- Fully designed.
- Cover all required states from the relevant per-surface state spec.
- Have an empty state, a loading state, an active state, an error state,
  and at least one blocked state where applicable.
- Are reachable from a visible control, not only via the palette.

### Parity frames

- Can be lower fidelity.
- Must still show navigation ownership and a known destination so reviewers
  understand where the capability lives.
- Must not look broken — disabled and "coming later" states are explicit,
  not silent gaps.

### Future enhancements

- Rich charts, drag-and-drop, OS notifications, mobile/tablet, persistent
  agent tree, app-native lightbox: do not belong in MVP frames at all.
- They appear in the prototype only when explicitly scoped.

### Defect heuristic

- If an MVP frame can only be reached via the command palette, that is a
  defect. Promote the action to a visible control.
- If an MVP frame requires terminal knowledge to interpret (parses slash
  output, references Ink components, assumes keybinding chords), that is a
  defect. Rewrite for app-native interaction.
- If an MVP frame relies on a future enhancement to make sense, that is a
  defect. Replace it with a working MVP-scope design.

## Review Heuristics

Use these quick checks during prototype review. If any heuristic fails on an
MVP frame, flag it.

- Could a user reach the action without typing a slash command? If no, fix
  it.
- Could a user understand the current safety state at a glance? If no, fix
  it.
- Could a user inspect a tool result without losing chat scroll? If no, fix
  it.
- Could a user recover from disconnect, denial, pause, budget limit, or
  failure with an explicit UI affordance? If no, fix it.
- Could a user find background work and stop or inspect it? If no, fix it.
- Could a user reach Settings without remembering a slash command? If no,
  fix it.
- Could a user understand which provider, model, and account are active
  before sending a prompt? If no, fix it.
- Does the design preserve every "must preserve" semantic above? If no,
  escalate to engineering before the design lands.

## Acceptance Checklist

A Figma prototype is ready for MVP review when all of the following are
true:

- All MVP surfaces above are designed with their full state coverage.
- Every MVP action is reachable from a visible control, not only via the
  palette.
- Permission dialogs follow the Permission Dialog Rules exactly.
- Tool cards have collapsed and expanded states with the right renderer per
  tool type.
- Sessions use a sidebar/browser flow with cross-project warning.
- Goal uses a chip + detail panel with runtime/model completion evidence.
- Tasks and Agents are live pages with in-chat indicators.
- Settings is organized by user intent with source distinction per setting.
- Accounts surfaces auth, pool, and rate-limit state without requiring a
  settings dive.
- Reconnect, disconnect, blocked send, paused goal, budget-limited goal,
  denied tool, and stale permission states are all explicitly designed.
- The Annotation Checklist from
  `docs/design/2026-05-17-dedicated-app-figma-user-flows.md` is followed,
  including a preserved-semantics citation when relevant.
- No anti-pattern from the Anti-Patterns Quick Reference appears in any MVP
  frame.

When all items pass, the prototype is ready for engineering review.
