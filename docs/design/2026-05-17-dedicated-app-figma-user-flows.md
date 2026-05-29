# Dedicated App Figma User Flows And States

**Status:** Design handoff
**Created:** 2026-05-17
**Companion docs:**
`docs/design/2026-05-17-dedicated-app-figma-prototype-brief.md`,
`docs/design/2026-05-17-dedicated-app-figma-screen-inventory.md`,
`docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md`

## Purpose

This document defines the clickable flows and state coverage expected from the
Figma prototype. The goal is to let reviewers experience the app workflows, not
just inspect static screens.

Where a flow below describes a terminal-shaped interaction (slash commands,
modal stacks, command-only resume), treat that as a behavior anchor and apply
the terminal-to-app pattern mapping in
`docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md`. Preserve
the behavior; redesign the surface.

## Prototype Entry Points

The Figma file should expose these starting frames:

- First launch: untrusted workspace.
- First launch: login required.
- Main workspace: empty new session.
- Main workspace: active streaming session.
- Main workspace: permission pending.
- Main workspace: running task/agent.
- Settings: MCP/plugin parity preview.

## Flow 1: First Launch To Workspace

Priority: MVP

Path:

1. User opens app.
2. App shows workspace trust gate.
3. User trusts workspace.
4. App shows auth provider/API key state if needed.
5. User completes or skips allowed auth step.
6. App lands in the main workspace with a new session.

Required states:

- Untrusted workspace.
- Trust declined.
- Login required.
- OAuth/API key in progress.
- Login failed/retry.
- Ready workspace.

Acceptance criteria:

- The user cannot send a prompt before required trust/auth is complete.
- The final workspace frame clearly shows session, composer, model/account, and
  connection status.

## Flow 2: Start A New Chat And Receive A Streaming Response

Priority: MVP

Path:

1. User starts from empty workspace.
2. User types a multiline prompt.
3. User sends prompt.
4. Composer switches to active/stop state.
5. Assistant response streams.
6. Tool-use preview appears.
7. Tool result resolves.
8. Final assistant message appears.

Required states:

- Empty chat.
- Draft prompt.
- Sending.
- Streaming text.
- Running tool.
- Completed response.
- Turn cancelled.
- Error in turn.

Acceptance criteria:

- The user can see what is happening without reading raw logs.
- Stop/abort state is visible while the turn is active.
- Tool cards are inspectable without losing transcript context.

## Flow 3: Permission Request During Tool Use

Priority: MVP

Path:

1. Assistant attempts a tool action.
2. App shows permission dialog.
3. Dialog explains action, target, working directory/path, and consequence.
4. User chooses allow once.
5. Tool continues and result appears in transcript.
6. Alternate branch shows deny and denied result.

Required states:

- Tool approval.
- File/path approval.
- Shell approval.
- Sandbox/network approval.
- Allowed once.
- Denied.
- Always allow saved where supported.
- Stale request after reconnect.

Acceptance criteria:

- Permission choices are visually distinct and cannot be accepted accidentally.
- Denial is reflected in the transcript/tool card.
- Sandbox/network approval is visually distinct from ordinary tool approval.

## Flow 4: Command Palette

Priority: MVP with parity preview

Path:

1. User opens command palette as an accelerator (`Cmd/Ctrl+K` or equivalent).
2. User searches for a command or action.
3. User selects an action that opens a page or dialog (e.g., open Settings,
   open Goal detail).
4. User returns and selects an action that runs inline and produces a result
   card or toast.
5. User sees unavailable or feature-gated command state with a tooltip
   explaining why.

Required states:

- Empty palette.
- Search results.
- No results.
- Disabled command (visibly disabled, not hidden).
- Recent action.
- Plugin/MCP/skill/workflow command source.

Acceptance criteria:

- Every MVP capability the palette exposes is also reachable from a visible
  control, menu, or page. The palette is an accelerator, not the only path.
- Critical MVP actions are discoverable without typing slash syntax.
- Feature-gated commands do not look broken; they show why they are disabled.
- Plugin, skill, MCP, and workflow command origins can be indicated compactly.

## Flow 5: Session Create And Resume

Priority: MVP

Path:

1. User opens session list in the sidebar/browser (not via `/resume`).
2. User starts a new session via a primary New action in the sidebar or tab
   bar.
3. User switches back to the session list.
4. User resumes an existing same-project session via the Resume action on a
   session row.
5. Alternate branch shows cross-project warning before opening incompatible
   context.

Required states:

- Empty session list.
- Loading sessions.
- Active session.
- Same-project resume.
- Cross-project warning.
- Resume failed.

Acceptance criteria:

- Active session identity is visible after resume.
- Cross-project warning is explicit before opening incompatible context.

## Flow 6: Goal Management

Priority: MVP

Path:

1. User opens the goal panel from the goal status chip near the composer or
   from the sidebar — not via `/goal` typed into the prompt.
2. User creates a goal through visible controls in the panel.
3. Goal appears as a status chip near the composer and in the detail panel.
4. User pauses goal.
5. User resumes goal.
6. User clears goal.
7. Alternate branch shows runtime/model completion evidence (reported by
   `UpdateGoalTool` and worker checks, not a user "complete" button).

Required states:

- No goal.
- Goal create.
- Active goal.
- Paused goal.
- Budget-limited goal.
- Completion evidence.
- Cleared goal.

Parity preview state:

- Completion blocked by active workers.

Acceptance criteria:

- Create, replace, pause, resume, and clear are user-facing controls.
- Completion is shown as runtime/model result state, not as a simple manual
  complete button.
- Budget and continuation state are understandable at a glance.

## Flow 7: Running Task Or Agent

Priority: MVP with parity preview

Path:

1. User sees running task/agent indicator near the composer or sidebar.
2. User opens the live Tasks or Agents page from the sidebar — not via
   `/tasks` typed into the prompt.
3. User inspects one task in a detail view (drawer or page) while the main
   chat remains usable.
4. User returns to chat while task continues.
5. User stops a task with confirmation where current behavior requires it.
6. Alternate branch shows completed or failed task.

Required states:

- No work.
- Running.
- Waiting.
- Needs permission.
- Completed.
- Failed.
- Stopped.
- Stale/resumable.

Acceptance criteria:

- The user can inspect background work without losing active chat.
- Stop action requires confirmation when current behavior requires it.
- MVP clearly separates simple active task status from full Agent Mode parity.

## Flow 8: Model, Account, And Usage Context

Priority: MVP

Path:

1. User opens the model/control menu through a composer-adjacent control —
   not via `/model` or `/effort` typed into the prompt.
2. User changes model or effort.
3. User opens the account menu (composer-adjacent or sidebar entry to the
   Accounts page).
4. User switches account or sees login state.
5. Rate limit/usage warning appears as a persistent status chip or banner,
   not as transcript-only text.

Required states:

- Logged out.
- Logged in.
- Multiple accounts.
- Switch pending.
- Model unavailable.
- Rate limited.
- Usage unavailable.

Acceptance criteria:

- Model/provider/effort state is visible before prompt submission.
- Account state and rate-limit warnings do not require opening settings.

## Flow 9: Settings And Extension Preview

Priority: Parity

Path:

1. User opens Settings from the sidebar (not via `/permissions`, `/mcp`,
   `/plugin`, `/skills`, or other slash commands typed into a prompt).
2. User navigates the Permissions category to view and edit rules.
3. User navigates the MCP category to view server list, status, tools, and
   resources.
4. User opens plugin marketplace or plugin detail under Plugins.
5. User opens the skill browser under Skills.
6. MCP elicitation dialog appears as an app dialog anchored to the requesting
   active session — not buried as a settings row.

Required states:

- Settings loaded.
- Validation error.
- Managed/read-only setting.
- MCP connected/disconnected.
- MCP form elicitation.
- MCP URL elicitation.
- Plugin installing/enabled/disabled.
- Skill available/running.

Acceptance criteria:

- Settings are organized by user decision, not by terminal command names.
- MCP elicitation is treated as an active dialog, not only a settings row.

## Flow 10: Reconnect, Error, And Blocked Send

Priority: MVP

Path:

1. User is in active chat.
2. Runtime disconnects.
3. Composer becomes blocked.
4. App shows reconnecting status.
5. Connection restores.
6. App preserves draft/transcript position.
7. Alternate branch shows reconnect failure.

Required states:

- Connected.
- Disconnected.
- Reconnecting.
- Send disabled.
- Draft preserved.
- Reconnect failed.
- Runtime error.

Acceptance criteria:

- The user understands whether work is still running.
- Draft text and visible transcript context are not visually lost.
- The app offers a clear retry or fallback path.

## Global State Matrix

Every MVP screen should define the relevant subset of these states:

| State | Required treatment |
|---|---|
| Empty | Direct next action, no marketing copy. |
| Loading | Stable layout, visible progress, no layout jump. |
| Active | Clear current action and current owner. |
| Streaming | Incremental response state and stop affordance. |
| Waiting | Explain what the app is waiting for. |
| Permission pending | Block unsafe action and show decision context. |
| Disabled | Explain why action is unavailable when practical. |
| Error | State what failed, what is blocked, and what can be retried. |
| Denied | Show user decision and resulting tool/message state. |
| Disconnected | Preserve context and show reconnect or fallback state. |
| Reconnecting | Keep transcript visible and prevent unsafe duplicate sends. |
| Completed | Show result and next useful action. |
| Paused | Show resume/keep-paused choices where relevant. |
| Budget-limited | Show budget state and final evidence when available. |

## MVP Clickability Checklist

The prototype is ready for review when these paths are clickable:

- First launch to workspace.
- New chat to streaming response.
- Tool card expand/collapse.
- Permission allow and deny branches.
- Command palette search and command selection.
- Session new/resume.
- Goal create, pause, resume, clear, and completion evidence view.
- Task/agent inspect and stop.
- Model/account control change.
- Disconnected/reconnect recovery.

## Annotation Checklist

Each annotated frame should identify:

- Priority: MVP, parity, or future.
- User intent.
- Required data shown.
- Primary action.
- Secondary action.
- Blocking state, if any.
- Empty/loading/error behavior.
- Notes where the design intentionally differs from terminal UI.
- Preserved-semantics note when the frame represents safety, goal, session,
  tool, auth, agent/task, MCP/plugin/skill, or reconnect/blocking behavior —
  cite the preservation rule from
  `docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md`.
