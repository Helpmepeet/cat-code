# Dedicated App UI Requirements

Status: source-verified requirements inventory
Created: 2026-05-17
Scope: migrate Cat Code from terminal-first UI to a dedicated application

## Purpose

This document lists the user-facing and terminal-owned capabilities that the
dedicated app must handle before it can become the primary Cat Code interface.
It is a requirements inventory, not an implementation plan.

The dedicated app target is the current `src/app-runtime/` and
`src/dedicated-app/` path. The older root `web/` plan remains useful historical
context, but it is not the replacement target unless a later task explicitly
chooses it as a temporary bridge.

## Source Basis

The inventory was checked against these current source and routing surfaces:

- `CLAUDE.md`
- `docs/maps/WORKSPACE_MAP.md`
- `docs/maps/terminal-ui-state.md`
- `docs/maps/dedicated-app.md`
- `docs/maps/tools-permissions.md`
- `docs/maps/tasks-workers.md`
- `docs/maps/plugins-skills-commands.md`
- `docs/maps/config-persistence.md`
- `docs/maps/auth-accounts-oauth.md`
- `docs/maps/query-provider-runtime.md`
- `docs/maps/bridge-remote-cli.md`
- `docs/maps/agent-mode.md`
- `docs/maps/ide-lsp.md`
- `docs/maps/native-client-integrations.md`
- `docs/maps/proactive-assistant-services.md`
- `docs/maps/analytics-diagnostics.md`
- `docs/agent/2026-05-03-dedicated-app-groundtruth.md`
- `docs/design/2026-05-03-dedicated-app-prototype-brief.md`
- `docs/plans/2026-04-30-ui-inventory.md`
- `docs/plans/2026-04-30-ui-web-ui-plan.md`
- `src/screens/REPL.tsx`
- `src/components/PromptInput/`
- `src/components/messages/`
- `src/components/permissions/`
- `src/components/tasks/`
- `src/commands.ts`
- `src/commands/`
- `src/tools.ts`
- `src/tools/`
- `src/app-runtime/`
- `src/dedicated-app/`

When this document conflicts with older plans, current source and maps win.

## Current Reality

The terminal UI remains the operational center. `src/screens/REPL.tsx` owns
session display, prompt submission, command dispatch, dialog priority,
permission queues, background task UI, goal continuation, Agent Mode status,
remote session wiring, and many notification surfaces.

The app runtime boundary exists but is still narrow. `src/app-runtime/` exposes
`AppSessionController`, `sessionEvents`, `createQueryEngineAppSession`, and
permission bridging. The current app-facing events are:

- `message`
- `goal.snapshot`
- `permission.requested`
- `permission.resolved`
- `abort.status`

The dedicated app shell is still scaffolded around placeholder state.
`src/dedicated-app/DedicatedAppShell.tsx` renders sessions, panels, chat,
permissions, goal, runtime status, agents, accounts, and settings from
`DedicatedAppRuntimeState`, but `src/dedicated-app/placeholderState.ts` makes
clear that these are not live backend capabilities yet.

## Classification

Priority labels:

- MVP: required before normal daily chat can move from terminal to app.
- Parity: required before the terminal is no longer the primary interface.
- Future: web/app-native enhancement that can wait until parity is stable.

Readiness labels:

- App-runtime ready: a non-terminal event/control boundary exists.
- Placeholder only: the dedicated shell shows mock or inert state.
- Terminal-owned: live behavior exists mainly in `REPL.tsx`, Ink components, or
  terminal-only command UI.
- Runtime-owned: behavior exists below the UI and needs an app surface.

## Product Shape Requirements

The dedicated app must be a dense local agent workspace, not a terminal
transcript embedded in a browser. It should follow the prototype direction:

- Fixed sidebar with workspace identity, session search, session list, and
  navigation for Chat, Agents, Accounts, and Settings.
- Top tab bar or equivalent for multiple open chats.
- One to three resizable chat panels, with a path to split-panel workflows.
- Chat surface with streaming messages, tool cards, diffs, command output,
  thinking blocks, and sticky prompt input.
- Command palette for sessions and slash commands.
- Permission modal that maps to existing allow, deny, and always-allow
  semantics.
- Context/session usage gauge near the input.
- Goal status visible near session/runtime status.
- Agents page for running/completed workers and control actions.
- Accounts page for token usage, provider/account state, cache usage, and
  rate-limit status.
- Settings page for app, runtime, permissions, providers, MCP, plugins, skills,
  IDE, and native integrations.

The terminal must remain a compatibility and emergency surface until the app can
handle normal chat, streaming, tool approvals, session resume, goal state, and
worker visibility.

## Feature Matrix

| Area | Required UI capability | Priority | Current source owners | Current app gap |
|---|---|---:|---|---|
| Startup | Trust, onboarding, auth, setup, and first-render routing | MVP | `src/main.tsx`, `src/entrypoints/cli.tsx`, `src/components/TrustDialog/`, `src/components/Onboarding.tsx`, `src/components/ApproveApiKey.tsx`, `src/components/ConsoleOAuthFlow.tsx` | Terminal startup owns this. App needs first-run screens and safe trust/auth handoff. |
| Runtime boundary | Submit input, stream messages, request permissions, expose goal snapshot, abort active turn | MVP | `src/app-runtime/AppSessionController.ts`, `src/app-runtime/sessionEvents.ts`, `src/app-runtime/createQueryEngineAppSession.ts` | Core event contract exists, but shell is not wired to live sessions. |
| Main chat | Stream assistant/user/system messages with scroll anchoring and jump-to-latest | MVP | `src/screens/REPL.tsx`, `src/components/Messages.tsx`, `src/components/VirtualMessageList.tsx`, `src/components/FullscreenLayout.tsx` | Terminal-owned rendering and layout need app-native equivalents. |
| Prompt input | Multiline prompt, history, autocomplete, mentions, attachments, paste, image paste, stashing, mode indicators | MVP | `src/components/PromptInput/`, `src/components/TextInput.tsx`, `src/components/VimTextInput.tsx`, `src/hooks/useTextInput.ts`, `src/hooks/useVimInput.ts` | Entire input shell is terminal-owned. |
| Commands | Discover and run built-in, skill, workflow, plugin, and MCP commands | MVP | `src/commands.ts`, `src/types/command.ts`, `src/commands/`, `src/skills/`, `src/utils/plugins/` | App needs a command palette and command result UI for prompt, local, and local-JSX command types. |
| Tool display | Collapsed and expanded cards for tools, progress, results, errors, diffs, file content, command output | MVP | `src/tools.ts`, `src/tools/*/UI.tsx`, `src/components/messages/AssistantToolUseMessage.tsx`, `src/components/messages/UserToolResultMessage/`, `src/components/StructuredDiff/` | Terminal renderers are Ink-based. App needs HTML/app-native renderers over the same tool data. |
| Permissions | Tool, file, shell, sandbox, web fetch, computer-use, skill, plan, ask-user, worker, and bypass approvals | MVP | `src/hooks/useCanUseTool.tsx`, `src/utils/permissions/`, `src/components/permissions/`, `src/app-runtime/appRuntimeCanUseTool.ts` | Runtime bridge exists for ask decisions, but app needs full UI and rule management. |
| Sessions | New, resume, cross-project warning, session list/search, fork/branch, rename, tags, rewind, transcript compatibility | MVP/Parity | `src/screens/ResumeConversation.tsx`, `src/components/LogSelector.tsx`, `src/utils/sessionStorage.ts`, `src/utils/conversationRecovery.ts`, `src/utils/sessionRestore.ts`, `src/commands/resume/`, `src/commands/branch/`, `src/commands/rewind/`, `src/commands/rename/`, `src/commands/tag/` | App shell has placeholder sessions only. Live transcript list/resume is not app-wired. |
| Goal mode | Create, show, replace, pause, resume, clear, budget status, completion evidence, continuation state | MVP/Parity | `src/utils/threadGoal.ts`, `src/utils/threadGoalActions.ts`, `src/commands/goal/`, `src/tools/GetGoalTool/`, `src/tools/CreateGoalTool/`, `src/tools/UpdateGoalTool/`, `src/screens/REPL.tsx` | App event can expose snapshots, but full goal controls and continuation UI remain terminal-owned. |
| Agent Mode | Start Agent Mode, show worker roster, worker state, worker controls, synthesis status, resumable workers | Parity | `src/agent-mode/`, `src/commands/agent/`, `src/commands/agents/`, `src/tools/ListWorkersTool/`, `src/tools/WaitWorkersTool/`, `src/tools/GetWorkerResultTool/`, `src/tools/CancelWorkerTool/`, `src/screens/REPL.tsx` | App needs a first-class Agents page and in-chat worker visibility. |
| Background tasks | Show active task/agent status and common inspect/stop actions for MVP; add shell, local agent, remote agent, teammate, dream, workflow, and monitor task details for parity | MVP/Parity | `src/tasks.ts`, `src/tasks/`, `src/components/tasks/`, `src/hooks/useBackgroundTaskNavigation.ts`, `src/state/selectors.ts` | Terminal task dialog/footer is not app-wired. |
| Accounts | Login/logout, account pool, aliases, delete, switch, refresh, usage hints, rate limits | MVP/Parity | `src/utils/auth.ts`, `src/services/oauth/`, `src/services/api/claudeAccountPool.ts`, `src/services/api/codexAccountPool.ts`, `src/services/api/codexAccountLeaseManager.ts`, `src/commands/accounts/`, `src/commands/login/`, `src/commands/logout/`, `src/commands/switch-account/`, `src/commands/rename-account/`, `src/commands/delete-account/`, `src/commands/touch-all/` | App has placeholder account surface only. |
| Models and inference | Model picker, effort/reasoning controls, fast mode, thinking toggle, provider-aware labels | MVP | `src/commands/model/`, `src/commands/effort/`, `src/commands/reasoning/`, `src/commands/fast/`, `src/components/ModelPicker.tsx`, `src/components/ThinkingToggle.tsx`, `src/utils/model/`, `src/utils/effort.ts`, `src/utils/fastMode.ts` | App needs controls above/near prompt and account/provider context. |
| Settings | Permissions, config, theme, output style, keybindings, privacy, hooks, MCP, plugins, skills, language | Parity | `src/components/Settings/`, `src/commands/config/`, `src/commands/permissions/`, `src/commands/theme/`, `src/commands/output-style/`, `src/commands/keybindings/`, `src/commands/privacy-settings/`, `src/commands/hooks/`, `src/commands/mcp/`, `src/commands/plugin/`, `src/commands/skills/` | App settings page must replace multiple terminal modal flows. |
| MCP, skills, plugins | MCP server list/status/tools/resources, MCP form/URL elicitations, plugin marketplace/manage, skill browser/invocation | Parity | `src/services/mcp/`, `src/components/mcp/`, `src/commands/mcp/`, `src/commands/plugin/`, `src/commands/skills/`, `src/commands.ts`, `src/skills/`, `src/utils/plugins/` | App must show dynamic sources and hot-refresh state. |
| IDE and LSP | Auto-connect, manual connect, status, selected/open file context, diagnostics, diff-in-IDE, LSP recommendations | Parity | `src/hooks/useIDEIntegration.tsx`, `src/commands/ide/`, `src/utils/ide.ts`, `src/services/lsp/`, `src/tools/LSPTool/`, `src/components/IdeStatusIndicator.tsx`, `src/components/IdeOnboardingDialog.tsx`, `src/hooks/useDiffInIDE.ts` | App needs status, prompts, and editor integration controls. |
| Native integrations | Chrome, computer-use approvals, desktop handoff, mobile QR, voice mode | Parity/Future | `src/utils/claudeInChrome/`, `src/utils/computerUse/`, `src/commands/chrome/`, `src/commands/desktop/`, `src/commands/mobile/`, `src/commands/voice/`, `src/services/voice.ts`, `src/services/voiceStreamSTT.ts` | App needs app-native settings and status surfaces; voice and mobile can phase later. |
| Diagnostics | Doctor, status, stats, cost, usage, validation errors, debug/error status | Parity | `src/screens/Doctor.tsx`, `src/commands/doctor/`, `src/commands/status/`, `src/commands/stats/`, `src/commands/cost/`, `src/commands/usage/`, `src/components/Settings/Status.tsx`, `src/utils/status.tsx`, `src/cost-tracker.ts` | App needs durable pages or dialogs for health and usage. |
| Notifications | Status notices, update notifications, rate limit hints, idle return, prompt suggestions, tips, task completion | MVP/Parity | `src/context/notifications.tsx`, `src/components/StatusNotices.tsx`, `src/screens/REPL.tsx`, `src/components/PromptInput/Notifications.tsx`, `src/services/PromptSuggestion/`, `src/services/tips/` | App needs visual toasts/banners and resumable notification state. |
| Remote/server | Remote Control, remote sessions, direct-connect, SSH proxy, reconnect, viewer/control modes | Parity | `src/bridge/`, `src/remote/`, `src/server/`, `src/hooks/useRemoteSession.ts`, `src/hooks/useDirectConnect.ts`, `src/cli/structuredIO.ts`, `src/commands/bridge/`, `src/commands/session/`, `src/commands/remote-env/`, `src/commands/remote-setup/` | App must support durable disconnect/reconnect and server-hosted execution. |
| Dedicated shell | Sidebar, panels, sessions, chat, goal, permissions, agents, accounts, settings | MVP scaffolding | `src/app-runtime/dedicatedAppState.ts`, `src/dedicated-app/DedicatedAppShell.tsx`, `src/dedicated-app/host.ts`, `src/dedicated-app/renderDocument.ts` | Placeholder only. Needs live controller, state projection, transport, hydration, and actions. |

## Startup And App Shell Requirements

MVP requirements:

- App startup must preserve trust semantics from `src/utils/config.ts` and
  `src/components/TrustDialog/`.
- App startup must support Anthropic and Codex/OpenAI auth flows currently owned
  by `ConsoleOAuthFlow`.
- App must surface missing API key, OAuth, forced login, org mismatch, and
  third-party provider setup states before a user can send prompts.
- App must not execute project/plugin/LSP commands before trust is established.
- App must provide a local host or packaged app entry equivalent to
  `bun run serve:dedicated-app`, but backed by live runtime state.
- App must preserve terminal fallback and not break CLI `--print`, `--remote`,
  direct-connect, or normal REPL startup.

Parity requirements:

- App must support resume startup, direct-connect startup, remote viewer startup,
  SSH/proxy startup, initial prompt submission, and file download startup paths
  currently coordinated in `src/main.tsx`.
- App must expose update/install state, channel warnings, and invalid
  configuration before or during first render.

## Chat And Transcript Requirements

MVP requirements:

- Stream assistant text, tool-use previews, tool results, errors, and final
  assistant messages in order.
- Preserve scroll position when the user is reading earlier messages.
- Provide jump-to-latest and new-message count behavior equivalent to
  `FullscreenLayout`.
- Render user, assistant, system, attachment, progress, compact-boundary,
  snip-boundary, rate-limit, shutdown, hook-progress, and task-assignment
  messages.
- Support Markdown with code blocks, tables, inline code, and safe HTML
  handling.
- Support streaming reasoning/thinking summaries, collapsed by default or
  governed by the existing verbose/thinking settings.
- Render images and pasted text attachments in a inspectable way.
- Continue showing chat during reconnect or active turn state changes.

Parity requirements:

- Support transcript mode, message actions, copy actions, timestamps/model
  metadata, message search, global search, hidden/meta message handling, and
  brief-only filtering.
- Preserve collapsed read/search groups, grouped tool-use rows, background bash
  notification collapse, hook summary collapse, and teammate shutdown collapse.
- Preserve compact and snip boundaries so users understand context changes.
- Preserve sidechain/local-agent transcript display and switching.

## Prompt Input Requirements

MVP requirements:

- Multiline input with Enter-to-send and newline shortcut behavior.
- Auto-resizing input area suitable for long prompts.
- Slash command autocomplete sourced from `getCommands(cwd)`.
- File/context mentions, IDE mentions, Slack/channel suggestions when
  configured, and quick-open entry points.
- Paste handling for large text, image paste, pasted-content references, and
  clipboard images.
- Prompt history navigation and history search.
- Disable or guard sending while disconnected, awaiting permission, or in a
  blocking modal.
- Preserve prompt drafts across reconnect and page refresh for the active
  session.
- Show model, provider, effort, fast mode, permission mode, context usage, goal
  status, IDE status, task state, and suppressed-dialog hints near the input.

Parity requirements:

- Vim mode, mode cycling, external editor handoff, prompt stash, side-question
  handling, prompt suggestions/speculation, voice push-to-talk, teammate/agent
  input routing, and team/direct-member messages.
- Configurable keybindings must map to app shortcuts without assuming terminal
  key semantics.

## Command Palette Requirements

MVP requirements:

- Command palette must use the same command registry as the terminal:
  `getCommands(cwd)` in `src/commands.ts`.
- It must display command name, alias, description, source, argument hint, and
  availability/disabled state.
- It must support built-in commands, bundled skills, filesystem skills, plugin
  commands, plugin skills, workflow commands, MCP skills, and dynamic skills.
- It must route prompt commands into model-visible prompts.
- It must route local commands into immediate result messages.
- It must route local-JSX commands into app-native dialogs/pages rather than
  terminal JSX.
- It must handle sensitive arguments without writing them into visible history.

MVP command set:

- Chat/session commands: `/clear`, `/compact`, `/resume`, `/rename`,
  `/branch`, `/rewind`, `/tag`, `/copy`, `/export`.
- Chat/session palette actions: current-session history search and global
  search, which are keybinding/dialog surfaces in current source rather than
  built-in slash commands.
- Model/control: `/model`, `/effort`, `/reasoning`, `/fast`, `/vim`.
- Safety: `/permissions`, `/sandbox`, `/allowed-tools` where present.
- Goal/task MVP: `/goal` plus active task/agent status and common `/tasks`
  inspect/stop controls.
- Runtime: `/status`, `/doctor`, `/cost`, `/usage`, `/stats`, `/context`,
  `/diff`.
- Account: `/login`, `/logout`, `/accounts`, `/switch-account`,
  `/rename-account`, `/delete-account`, `/touch-all`.
- Extension: `/mcp`, `/plugin`, `/skills`, `/hooks`, `/ide`, `/chrome`.

Parity command set:

- Agent/task parity: `/agent`, `/agents`, and full `/tasks` management,
  including launch, roster, detailed task inspect, foreground, and stop flows.
- Preserve all user-visible commands in `COMMANDS()` plus feature-gated commands
  when enabled: review/ultrareview, commit, commit-push-pr, install flows,
  desktop/mobile/voice, remote-control/session/remote-env/remote-setup, passes,
  privacy-settings, output-style, theme, cache-stats, release-notes, stickers,
  upgrade, brief, assistant/proactive, workflows, peers, fork, buddy, torch,
  ultraplan, and internal ant-only commands where the build exposes them.
- Preserve remote and bridge command filtering semantics from `src/commands.ts`.

## Tool Rendering Requirements

MVP requirements:

- Tool calls must render as collapsed cards by default with name, icon or label,
  status, summary, and elapsed/progress where available.
- Expanded cards must show structured input and output, with special renderers
  for file reads, file writes, edits/patches, bash/powershell output, notebook
  edits, web fetch/search, MCP calls, images, goal tools, task tools, worker
  tools, and agent tools.
- Bash and PowerShell output must preserve stdout/stderr boundaries, ANSI color,
  exit status, truncation, and sandbox/permission annotations.
- Diffs must support red/green display, file path, line numbers, and IDE-open
  affordances when available.
- Long outputs must remain responsive through collapse, virtualization, lazy
  loading, or output tails.
- Tool errors, cancellations, denials, rejected plans, and user rejections must
  render distinctly.

Parity requirements:

- Preserve tool-use grouping, collapsed read/search summaries, active/completed
  dots, hook progress, skill progress, worker badges, teammate labels, and
  progress summaries.
- Support deferred tool search and MCP tool identity so the UI can explain why
  a tool is available, deferred, denied, or hidden.
- Support app-native renderers for all `src/tools/*/UI.tsx` behavior or an
  explicit fallback renderer with structured JSON and readable text.

## Permission And Safety Requirements

MVP requirements:

- App must preserve existing allow, deny, ask, bypass, classifier, and
  bypass-immune safety semantics.
- App must surface permission requests from `AppSessionController` and respond
  through the existing permission response shape.
- Permission UI must show tool name, tool parameters, working directory/path,
  worker/agent identity, current permission mode, rule implications, and
  updated input where applicable.
- The user must be able to allow once, deny, and always allow where the existing
  permission system supports it.
- Sandbox network approvals must be explicit and distinct from tool approvals.
- File/path approvals must preserve dangerous-file checks, workspace directory
  rules, `.git`/config protections, and IDE diff review options.
- Permission prompts must not be accidentally accepted by stale typing or
  reconnect replay.

Parity requirements:

- Support Bash, PowerShell, file edit, file write, filesystem, notebook edit,
  web fetch, skill, ask-user, computer-use, worker pending, plan-mode enter/exit,
  sandbox, sed edit, and fallback permission request variants.
- Support permission rule editing, recent denials, workspace directories, debug
  info, explanation toggles, and shell permission feedback.
- Support coordinator/worker permission routing and remote/structured SDK
  permission request/response flows.

## Goal Mode Requirements

MVP requirements:

- App must show the active goal objective, status, tokens used, time used,
  remaining budget, and completion state.
- App must allow user-facing create, replace, pause, resume, and clear actions
  with the same parsing and validation as `/goal` in
  `src/utils/threadGoal.ts` and `src/commands/goal/`.
- App must surface completion state and model/runtime completion results from
  `src/tools/UpdateGoalTool/` without adding a separate user-facing complete
  action unless it preserves tool evidence and Agent Mode worker checks.
- App must surface budget-limited state and final completion budget evidence.
- App must show when a goal is paused and offer resume/keep-paused choices on
  return.
- App must expose goal state near the chat input and in a full goal detail view.
- App must keep goal state synchronized with transcript persistence and app
  runtime `goal.snapshot` events.

Parity requirements:

- Preserve goal continuation behavior, idle continuation signals,
  budget-wrap-up handling, active-goal loop behavior, and Agent Mode objective
  synchronization.
- Preserve model tools: `GetGoal`, `CreateGoal`, and `UpdateGoal`.
- Preserve blocking semantics when Agent Mode has unresolved workers and goal
  completion is not yet valid.

## Agents, Workers, And Tasks Requirements

MVP requirements:

- App must show active and completed background work without blocking normal
  chat navigation.
- App must show worker/task type, status, prompt/description, progress summary,
  elapsed time, tool count/activity, token/cost when available, and last event.
- App must support stopping or foregrounding supported tasks with the existing
  confirmation behavior.
- App must allow the user to inspect a worker or task transcript/output while
  the main chat remains available.

Parity requirements:

- Support task kinds registered in `src/tasks.ts`: local shell, local agent,
  remote agent, dream, and feature-gated workflow/monitor tasks. Also support
  in-process teammate tasks imported directly by REPL/task navigation.
- Support local agent retention, sidechain transcript bootstrap, pending
  messages, resume, kill, output symlink/tail display, and completion
  notifications.
- Support Agent Mode worker roster, durable `.agent-mode-state.json`,
  worker-control tools, friendly worker names, resumable/stale states, and
  synthesis status.
- Support teammate view, teammate input routing, current-work abort versus
  full kill, team context, color identity, and Shift/keyboard navigation
  equivalents.
- Support remote agent polling, CCR URL open, remote review/ultraplan variants,
  remote kill/archive behavior, and sidecar metadata restore.
- Support shell task output tails, interactive prompt watchdog notifications,
  backgrounding foreground shell/agent work, and child cleanup when an agent
  exits.

## Sessions And Persistence Requirements

MVP requirements:

- App must create new sessions and resume existing sessions from the same JSONL
  transcript storage used by the terminal.
- App must show searchable session list, current project, cross-project resume
  warnings, title/first message, date, model, token/cost hints where available,
  tags, and agent metadata.
- Refresh or reconnect must return to the same app session without losing
  visible transcript or draft input.
- Transcript writes must remain compatible with `src/utils/sessionStorage.ts`
  and `src/utils/sessionRestore.ts`.

Parity requirements:

- Support forked resume, branch/fork conversation, rewind with file history,
  rename, tags, export, copy, current-session history search, global semantic
  search, and all-project session browsing.
- Preserve transcript metadata entries for mode, worktree, goals, content
  replacements, file history, attribution, context collapse, and subagent
  metadata.
- Avoid replacing optimized session-list enrichment with full transcript reads.

## Accounts, Usage, Models, And Cost Requirements

MVP requirements:

- App must show the active provider, active model, account identity, auth state,
  and provider-specific model controls.
- App must expose model picker, effort/reasoning controls, fast mode, and
  thinking toggle near the prompt.
- App must show session cost/token usage and context/token usage enough for
  day-to-day control.
- App must support login/logout and account switch flows for Anthropic and
  Codex/OpenAI.

Parity requirements:

- Show Claude account pool entries, aliases, subscription, health, active
  account, org/profile details, and extra usage state.
- Show Codex account pool entries, aliases, account IDs, health/capped/dead
  state, usage hints, credit balance, active account, main lease, subagent
  leases, and failover/rotation information.
- Support rename/delete/touch-all account operations.
- Show detailed usage, cost, cache usage, per-model usage, rate-limit options,
  and stats charts currently available through `/accounts`, `/usage`, `/cost`,
  `/stats`, and `/rate-limit-options`.

## Settings, MCP, Plugins, Skills, And Hooks Requirements

MVP requirements:

- App settings must expose core chat/runtime preferences: model, effort,
  reasoning/thinking, fast mode, permission mode, theme, output style,
  keybindings, provider/account basics, and context display.
- App must show MCP server connection status and tool/resource count.
- App must show available skills and plugin/skill command sources used by the
  command palette.

Parity requirements:

- Settings must preserve user/project/local/flag/policy source distinctions and
  validation errors.
- Support permission rules, workspace directories, recent denials, classifier
  permission controls, hooks, plugin marketplace/install/enable/disable/update,
  plugin settings/options, MCP add/remove/import/approval/reconnect, MCP tools
  and resources, MCP form and URL elicitations, elicitation completion
  notifications and hook/result handling, skill browser/invocation, output
  styles, privacy settings, language, statusline, passes, and managed settings
  security warnings.
- App must handle hot reload and active session refresh for commands, agents,
  hooks, MCP, LSP, and plugin components.

## IDE, LSP, And Native Integration Requirements

MVP requirements:

- Show IDE connection status and selected/open file context when available.
- Preserve file/path click behavior or provide an app-native way to open files
  in the editor.
- Surface diagnostics attachments and edit-time diagnostic warnings.

Parity requirements:

- Support manual `/ide` connect/disconnect/open flows, IDE onboarding,
  JetBrains/VS Code style status notices, diff-in-IDE review, at-mention
  references, LSP initialization/status/errors, LSP recommendations, and LSP
  tool operation results.
- Support `/chrome` setup/status and Chrome MCP tool rendering.
- Support computer-use approvals, screenshot/status display, and session-scoped
  grants.
- Support desktop handoff, mobile QR, voice command/state, push-to-talk, voice
  STT status, and native installer/update surfaces where enabled.

## Notifications, Diagnostics, And Status Requirements

MVP requirements:

- App must show active turn status, spinner/progress text, elapsed time, model,
  provider, permission mode, context usage, running task count, and connection
  state.
- App must show errors, rate-limit warnings, auth warnings, invalid settings,
  update/install messages, and task completion notices without relying on
  terminal scrollback.
- App must provide visual-only notifications by default.

Parity requirements:

- Port Doctor diagnostics, Status tab, Stats, Cost, Usage, cache stats,
  validation errors, sandbox doctor section, MCP/keybinding/plugin warnings,
  environment variable warnings, native install locks, context warnings, and
  debug/error log visibility.
- Preserve idle-return dialog, cost threshold dialog, token warning, auto mode
  opt-in, update/channel dialogs, LSP/plugin recommendations, prompt
  suggestions, spinner tips, and brief mode indicators.

## Remote, Reconnect, And Server Runtime Requirements

MVP requirements:

- App must tolerate control-surface disconnects without losing the running
  turn, pending permission, transcript, or active goal state.
- If disconnected, app must keep visible state, disable unsafe sends, preserve
  drafts, and make reconnect status explicit.
- Pending permissions must not be auto-allowed on reconnect.

Parity requirements:

- Support Remote Control bridge, remote viewer sessions, direct-connect
  sessions, SSH/proxy sessions, CCR session URLs, session QR display, bridge
  safe command filtering, structured SDK permission/control events, and local
  server-Mac runtime direction.
- App must support multiple open sessions/panels while background agents or
  remote sessions continue running.
- App should be able to become the primary client while terminal remains a
  fallback client of the same runtime contract.

## MVP Cut

The smallest useful app migration should include:

1. Live app-runtime session connection for one local session.
2. Chat transcript rendering with streaming text, system messages, Markdown,
   tool cards, errors, scroll anchoring, and jump-to-latest.
3. Prompt input with multiline send, slash command autocomplete for critical
   commands, paste/image attachments, draft persistence, and disconnected guard.
4. Permission modal for tool/file/shell/sandbox approvals using
   `AppSessionController` permission events.
5. Active goal display and create/pause/resume/clear controls.
6. Session create/resume for same-project sessions.
7. Model/provider/effort/fast/thinking controls.
8. Account/auth visibility and login/logout/switch basics.
9. Running task/agent status list with inspect and stop for common task types.
10. Status/notification surfaces for auth, rate limits, settings errors,
    active turn, and connection state.

This MVP is not full parity. It is enough to prefer the app for normal chat
while keeping the terminal as fallback.

## Full Parity Cut

Full parity means every user-facing terminal feature either has an app-native
surface or is deliberately documented as terminal-only. In practice that
requires:

- Complete command palette coverage for all enabled commands.
- Complete tool renderer coverage for built-in, MCP, plugin, worker, goal, and
  proactive tools.
- Full permission rule management and all request variants.
- Full session management including tags, branch, rewind, search, global search,
  export, copy, and all-project browsing.
- Full Agent Mode, worker-control, task, teammate, and remote agent visibility.
- Full accounts, usage, settings, MCP, plugins, skills, hooks, IDE/LSP, native,
  diagnostics, stats, cost, and remote/server flows.
- Terminal running as compatibility client rather than runtime owner.

## Future App-Native Enhancements

These should wait until MVP or parity surfaces are stable:

- Rich split-pane workspace with pinning tool output next to chat.
- Drag-and-drop files, sessions, and panels.
- App-native lightbox for images and attachments.
- Rich charting for token/cost/rate-limit/account trends.
- Mermaid and richer document previews in transcript.
- Persistent agent tree side panel with live hierarchy.
- Browser or OS notifications, if explicitly desired later.
- Mobile/tablet layout beyond the current desktop-first direction.

## Major Migration Gaps

1. `REPL.tsx` still owns too much product state and dialog priority. The app
   needs runtime state projection without importing `REPL.tsx` or Ink.
2. `AppSessionController` exposes core turn events, permissions, goal snapshots,
   and abort state, but it does not yet expose the full session list, task list,
   command UI, settings, accounts, diagnostics, or remote lifecycle.
3. `DedicatedAppShell` is a placeholder renderer. It does not submit prompts,
   consume live events, persist drafts, hydrate transcripts, or execute actions.
4. Tool renderers and command dialogs are mostly Ink/React terminal components.
   App-native renderers are needed instead of reusing terminal JSX directly.
5. Permission safety has a partial runtime bridge, but app UI must cover the
   full matrix of permission variants and rule-management surfaces.
6. Goal state is partially app-event ready, but goal continuation, pause/resume
   prompts, budget accounting, and Agent Mode synchronization remain
   REPL-centered.
7. Sessions and transcripts are runtime-owned but picker/resume UX is
   terminal-owned.
8. Agent Mode and background task UX remain terminal-owned, even though their
   runtime state is largely below the UI.
9. Remote/server runtime behavior exists in several paths that must not be
   collapsed: Remote Control bridge, remote sessions, and direct connect.
10. Existing docs still contain stale root `web/` assumptions. Future app work
    should route through `docs/maps/dedicated-app.md`.

## Source Owner Index

| Feature family | Primary owners |
|---|---|
| Runtime and query | `src/app-runtime/`, `src/QueryEngine.ts`, `src/query.ts`, `src/services/api/` |
| Terminal shell | `src/screens/REPL.tsx`, `src/replLauncher.tsx`, `src/main.tsx` |
| Dedicated shell | `src/dedicated-app/`, `scripts/validate-dedicated-app.ts` |
| Prompt input | `src/components/PromptInput/`, `src/hooks/useTextInput.ts`, `src/hooks/useVimInput.ts`, `src/keybindings/` |
| Messages | `src/components/Messages.tsx`, `src/components/MessageRow.tsx`, `src/components/messages/`, `src/utils/messages.ts` |
| Commands | `src/commands.ts`, `src/types/command.ts`, `src/commands/`, `src/skills/`, `src/utils/plugins/` |
| Tools | `src/tools.ts`, `src/Tool.ts`, `src/tools/`, `src/services/tools/` |
| Permissions | `src/hooks/useCanUseTool.tsx`, `src/utils/permissions/`, `src/components/permissions/`, `src/app-runtime/appRuntimeCanUseTool.ts` |
| Goal | `src/utils/threadGoal.ts`, `src/utils/threadGoalActions.ts`, `src/commands/goal/`, `src/tools/*GoalTool/` |
| Sessions | `src/utils/sessionStorage.ts`, `src/utils/conversationRecovery.ts`, `src/utils/sessionRestore.ts`, `src/screens/ResumeConversation.tsx`, `src/components/LogSelector.tsx` |
| Agents and tasks | `src/agent-mode/`, `src/tasks.ts`, `src/tasks/`, `src/components/tasks/`, `src/tools/AgentTool/`, worker-control tools |
| Accounts and auth | `src/utils/auth.ts`, `src/services/oauth/`, `src/services/api/*AccountPool.ts`, account commands |
| Settings and persistence | `src/utils/settings/`, `src/utils/config.ts`, `src/components/Settings/` |
| MCP, skills, plugins | `src/services/mcp/`, `src/commands/mcp/`, `src/commands/plugin/`, `src/commands/skills/`, `src/skills/`, `src/utils/plugins/` |
| IDE/LSP | `src/hooks/useIDEIntegration.tsx`, `src/utils/ide.ts`, `src/services/lsp/`, `src/tools/LSPTool/` |
| Native integrations | `src/utils/claudeInChrome/`, `src/utils/computerUse/`, `src/commands/chrome/`, `src/commands/desktop/`, `src/commands/mobile/`, `src/commands/voice/` |
| Diagnostics/status | `src/screens/Doctor.tsx`, `src/commands/status/`, `src/commands/stats/`, `src/commands/cost/`, `src/cost-tracker.ts`, `src/utils/status.tsx` |
| Remote/server | `src/bridge/`, `src/remote/`, `src/server/`, `src/cli/structuredIO.ts`, `src/commands/bridge/` |
