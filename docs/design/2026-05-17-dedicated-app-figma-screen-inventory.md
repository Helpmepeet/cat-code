# Dedicated App Figma Screen Inventory

**Status:** Design handoff
**Created:** 2026-05-17
**Companion docs:**
`docs/design/2026-05-17-dedicated-app-figma-prototype-brief.md`,
`docs/design/2026-05-17-dedicated-app-figma-user-flows.md`,
`docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md`

## Purpose

This document defines the screens and states the design team should cover in
Figma. It is organized by user-facing surface, not source-code ownership.

Behavior preservation rules and the terminal-to-app pattern mapping live in
`docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md`. When a
screen below references a slash command or terminal flow, read that as a
behavior anchor — the app surface must redesign the interaction (visible
control, menu, page, palette accelerator, drawer, or dialog) while preserving
the underlying semantics.

Priority labels:

- MVP: required for the first clickable prototype.
- Parity: required to show full terminal feature coverage later.
- Future: useful app-native enhancement after MVP/parity are stable.

## Global App Shell

Priority: MVP

Purpose: Give users a stable workspace for sessions, chat, status, and runtime
controls.

Must include:

- Left navigation with active section state.
- Workspace/session switcher.
- Active session title and project context.
- Connection/runtime status.
- Account/model summary.
- Goal/task status affordances.
- Main content area with chat as the default surface.
- Global command palette entry point.

States:

- First launch.
- Trusted and authenticated.
- Untrusted workspace.
- Missing auth.
- Active turn.
- Disconnected.
- Reconnecting.
- Runtime error.

Key interactions:

- Open command palette.
- Switch session.
- Start new session.
- Open settings.
- Open goal/task detail.
- Stop active turn.

## First Launch, Trust, And Auth

Priority: MVP

Purpose: Preserve safe startup before the app can execute project/runtime work.

Must include:

- Workspace trust prompt.
- Auth provider choice or missing credential state.
- OAuth/API key setup state.
- Account/org mismatch or forced login warning.
- Third-party provider setup state.

States:

- Untrusted.
- Trust accepted.
- Login required.
- OAuth in progress.
- Login failed.
- Ready to enter app.

Key interactions:

- Trust workspace.
- Decline trust.
- Start login.
- Retry login.
- Continue to workspace.

## Chat Workspace

Priority: MVP

Purpose: Replace the terminal REPL as the main place where work happens.

Must include:

- Ordered transcript with user, assistant, system, and status messages.
- Streaming assistant response state.
- Reasoning/thinking summary state.
- Tool-use preview and tool-result placement.
- Jump-to-latest control.
- New-message count while scrolled away.
- Stop/abort active turn control.
- Empty state with direct prompt actions.

States:

- Empty session.
- Streaming text.
- Streaming tool activity.
- Waiting for permission.
- User scrolled away from latest.
- Error in turn.
- Turn cancelled.
- Disconnected during turn.

Key interactions:

- Send prompt.
- Stop turn.
- Scroll history.
- Jump to latest.
- Expand message details.
- Copy message.
- Open tool card.

## Prompt Composer

Priority: MVP

Purpose: Provide the main input surface for prompts, commands, mentions, and
attachments.

Must include:

- Multiline text area.
- Send and stop states.
- Slash command autocomplete.
- File/context mention entry.
- Attachment chips for pasted images and large text.
- Prompt history affordance.
- Model, provider, effort, fast mode, thinking, context, goal, IDE, and task
  indicators near the composer.

States:

- Empty.
- Draft with text.
- Long prompt.
- Command autocomplete open.
- Mention picker open.
- Attachment pending.
- Disabled while disconnected.
- Blocked by modal/permission.
- Awaiting permission.

Key interactions:

- Type prompt.
- Submit prompt.
- Insert slash command.
- Add attachment.
- Remove attachment.
- Change model/effort.
- Open goal/task/status detail from indicator.

## Command Palette

Priority: MVP with parity expansion

Purpose: Provide an accelerator for actions, sessions, and commands. The
palette is not the primary entry point for any MVP capability — every MVP
action below must also be reachable from a visible control, menu, or page (see
the Command Palette Rules section in
`docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md`).

Must include:

- Search input.
- Rows with title, slash alias, category/source (built-in, skill, workflow,
  plugin, MCP, dynamic), description, argument hint, and availability state.
- Recent actions.
- Session switching alongside commands.
- Critical MVP actions.
- Visible-disabled state with reason for unavailable feature-gated commands;
  do not hide them silently.

MVP action groups to represent in search results (these are also reachable
from visible controls, menus, or pages — the palette is an accelerator):

- Chat/session: clear, compact, resume, rename, branch, rewind, tag, copy,
  export.
- Model/control: model, effort, reasoning, fast, vim.
- Safety: permissions, sandbox, allowed tools where available.
- Goal/task: goal, active task status, common task inspect/stop.
- Runtime: status, doctor, cost, usage, stats, context, diff.
- Account: login, logout, accounts, switch account.
- Extension: MCP, plugin, skills, hooks, IDE, Chrome.

For the clickable MVP prototype, provide working interactions for representative
critical actions and clear disabled/static states for rows whose full behavior
belongs to parity. Prompt-type commands route into the model prompt; local
commands produce inline result cards; local-JSX commands open app dialogs or
pages — never a terminal JSX surface.

Parity additions:

- Agent Mode launch and worker management.
- Full task management.
- Feature-gated and plugin-provided commands.
- Workflow, remote, proactive, and native integration commands.

States:

- Empty search.
- Results.
- No results.
- Disabled command.
- Command requires permission.
- Command runs inline.
- Command opens modal/page.

## Tool Cards And Output Detail

Priority: MVP

Purpose: Make tool use understandable, inspectable, and recoverable.

Must include:

- Collapsed card with tool name, icon/label, status, summary, and elapsed time.
- Expanded detail with input, output, error, and metadata.
- File read/write/edit renderer.
- Bash/PowerShell output renderer.
- Diff renderer with line numbers.
- Web/MCP/tool identity renderer.
- Worker/agent/goal tool renderer.
- Long-output truncation and expand/tail behavior.

States:

- Queued.
- Running.
- Needs permission.
- Succeeded.
- Failed.
- Cancelled.
- Denied.
- Output truncated.
- Expand/collapse.

## Permission Dialogs

Priority: MVP

Purpose: Preserve safety decisions with enough context for confident approval
or denial. Permission dialogs are app dialogs anchored to the requesting
session — they are not transcript lines or stacked Ink modals.

Must include:

- Tool/action name.
- Parameters or command preview.
- File/path/working-directory context.
- Agent/worker identity when relevant.
- Permission mode and rule implications.
- Allow once, deny, and always allow actions where supported.
- Distinct sandbox/network approval treatment.
- Queue for sequential pending permissions with explicit navigation, not a
  modal stack.
- Stale-after-reconnect treatment: the dialog must not be auto-accepted by
  reconnect replay, keyboard auto-confirm, focus traps, or background typing.

States:

- Tool approval.
- File edit/write approval.
- Shell approval.
- Sandbox/network approval.
- Worker/agent approval.
- Denied.
- Always-allow saved.
- Stale request after reconnect.

## Sessions

Priority: MVP with parity expansion

Purpose: Let users create, resume, identify, and manage work across sessions
through a sidebar/browser surface — not through `/resume` typed into a prompt.

MVP must include:

- Same-project session list visible in the sidebar/browser.
- New session as a primary action in the sidebar and tab bar.
- Resume session as a primary action on each session row.
- Cross-project warning shown before opening incompatible context, not after
  the fact in transcript.
- Current session metadata: title, project, last activity, model, token/cost
  hints when available, tags, and agent metadata.

Parity additions:

- Search.
- Global search.
- Rename.
- Tags.
- Branch/fork.
- Rewind.
- Export/copy.
- All-project browsing.

States:

- Empty list.
- Loading list.
- Active session.
- Archived/older session.
- Cross-project session.
- Resume failed.

## Goal Panel

Priority: MVP with parity expansion

Purpose: Show durable objective state as a visible status chip near the
composer plus a dedicated detail panel/page. Goal is not a slash-command-only
surface, and completion is not a manual toggle.

MVP must include:

- Goal status chip near the composer with objective short-form, status, and a
  one-glance budget/elapsed indicator.
- Detail panel/page showing: active goal objective, status, tokens/time used,
  remaining budget when set, paused/budget-limited state, and continuation
  status.
- Create/replace controls.
- Pause/resume controls.
- Clear control.
- Completion evidence/results display (reported by runtime/model via
  `UpdateGoalTool`, not a user "complete" button).
- Paused return choice on next session open.

Parity additions:

- Continuation state.
- Budget wrap-up state.
- Agent Mode synchronization.
- Worker-blocked completion state.

MVP states:

- No goal.
- Active goal.
- Paused.
- Budget-limited.
- Completion reported by runtime/model.
- Cleared.

Parity states:

- Completion blocked by active workers.

## Tasks And Agents

Priority: MVP with parity expansion

Purpose: Keep background work visible while normal chat stays usable. Tasks
and Agents are live pages reached from the sidebar, with in-chat indicators
when work is active — not buried behind `/tasks` and `/agents` commands.

MVP must include:

- Active task/agent list and Completed list as distinct sections.
- Row data: type, status, description/prompt, elapsed time, progress summary,
  tool count/activity, token or cost when available, and last event.
- Inspect action that opens a detail view (drawer or page) without losing the
  main chat.
- Stop action with confirmation where current behavior requires it.
- In-chat indicator (near composer or sidebar) for running work.

Parity additions:

- Full Agent Mode roster.
- Worker transcript/detail.
- Shell task output tail.
- Remote agent status.
- Dream/workflow/monitor/teammate task types.
- Foreground/background transitions.

States:

- No background work.
- Running.
- Waiting.
- Needs permission.
- Completed.
- Failed.
- Stopped.
- Stale/resumable.

## Accounts, Models, Usage, And Cost

Priority: MVP with parity expansion

Purpose: Make provider/account/model state visible before and during work.

MVP must include:

- Current account.
- Login/logout/switch basics.
- Model selector.
- Provider selector or provider label.
- Effort/reasoning controls.
- Fast mode and thinking state.
- Rate limit or usage warning.

Parity additions:

- Account aliases.
- Account pool.
- Delete/rename account.
- Usage and cost charts.
- Cache/token details.
- Refresh/touch-all flows.

States:

- Logged out.
- Logged in.
- Multiple accounts.
- Switch pending.
- Rate limited.
- Usage unavailable.
- Model unavailable.

## Settings, MCP, Plugins, Skills, And Hooks

Priority: Parity

Purpose: Replace terminal modal flows for configuration and extension systems
with a structured settings page organized by user intent, not by terminal
command names.

Must include:

- Settings categories aligned to user intent (suggested: General, Model &
  Inference, Permissions, Workspace, Privacy, Keybindings, Theme & Output,
  MCP, Plugins, Skills, Hooks, IDE & LSP, Native Integrations, Diagnostics,
  Managed).
- Source distinction per setting (user/project/local/flag/policy) and
  validation errors.
- Permission rules with rule management.
- Workspace directories.
- Privacy settings.
- Keybindings, configurable without assuming terminal key semantics.
- Theme/output style/language.
- MCP server list, status, tools, resources, add/remove/import/reconnect.
- MCP form and URL elicitation as app dialogs anchored to the requesting
  session — not as settings rows.
- Plugin marketplace/install/enable/disable/update/settings, with visible
  hot-reload state.
- Skill browser and skill invocation entry points.
- Hook list, status, and result state.
- Managed settings warnings and read-only indicators.

States:

- Loading settings.
- Validation error.
- Managed/read-only.
- Plugin installing.
- MCP disconnected.
- MCP elicitation pending.
- Hook running.

## IDE, LSP, Native, Diagnostics, And Remote

Priority: Parity

Purpose: Show navigation and ownership for advanced integration surfaces.

Must include:

- IDE connection state.
- Selected/open file context.
- Diagnostics summary.
- Diff-in-IDE action.
- Chrome/computer-use/native integration status.
- Doctor/status/stats/cost/usage pages.
- Remote session and reconnect state.
- Viewer/control mode where applicable.

States:

- Connected.
- Disconnected.
- Permission needed.
- Diagnostic warning.
- Remote reconnecting.
- Remote unavailable.
