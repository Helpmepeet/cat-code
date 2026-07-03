# Proactive And Assistant Services Map

Last refreshed: 2026-07-01

## Purpose

Daily-refreshable routing map for always-on behavior: proactive/Kairos mode,
assistant services, auto dream, Magic Docs, tips, prompt suggestions, agent
summaries, DreamTask, sleep, cron, remote triggers, brief, and push-style user
surfaces.

Verify behavior in source before editing. This checkout has several
feature-gated Kairos/proactive references whose implementation files are absent
or stubbed; treat those as validation targets, not confirmed runtime behavior.

## Top-Level Exposure

| Surface | Start here | Then inspect | Gate / note |
|---|---|---|---|
| Command list | `src/commands.ts` | `src/commands/brief.ts`, `src/commands/assistant/` | `/proactive`, `/brief`, and `/assistant` are conditionally required. `/brief` exists; `/assistant` is a placeholder wizard; `src/commands/proactive.*` is not present in this checkout. |
| Tool list | `src/tools.ts` | `src/tools/SleepTool/`, `src/tools/ScheduleCronTool/`, `src/tools/RemoteTriggerTool/`, `src/tools/BriefTool/` | Sleep is behind `PROACTIVE || KAIROS`; cron is behind `AGENT_TRIGGERS`; remote triggers are behind `AGENT_TRIGGERS_REMOTE`; Brief is always imported but runtime-gated. `PushNotificationTool` and `SendUserFileTool` are referenced but not present here. |
| REPL wiring | `src/screens/REPL.tsx` | `src/query/stopHooks.ts`, `src/hooks/useScheduledTasks.ts` | REPL mounts scheduled tasks, prompt suggestions, tips, speculation accept, and proactive hooks. Proactive imports resolve to no-op stubs in this checkout. |
| Away-summary generation | `src/services/awaySummary.ts` | `src/services/SessionMemory/sessionMemoryUtils.ts`, `src/services/api/instructionAssembly.ts`, `src/services/api/claude.ts` | Uses recent turn history plus session memory. Its provider-aware small-model request builds native instruction assembly and requests low reasoning effort on Codex/OpenAI. |
| Startup services | `src/utils/backgroundHousekeeping.ts` | service files below | Initializes Magic Docs, auto dream, skill improvement, extract memories, and plugin updates. |
| Task registry | `src/tasks.ts` | `src/tasks/DreamTask/DreamTask.ts`, `src/tasks/LocalAgentTask/` | `DreamTask` is registered with other task types and surfaces auto-dream as UI-visible background work. |

## Always-On Loop

The normal turn-end path starts in `src/query/stopHooks.ts`.

1. Build a `REPLHookContext` from the full turn history and current tool use
   context.
2. Save cache-safe fork params for main-thread and SDK queries.
3. If not bare/simple mode, fire background services:
   `executePromptSuggestion`, extract memories when enabled, and
   `executeAutoDream` for main-thread sessions.
4. Continue into user/plugin stop hooks.

This means prompt suggestions and auto dream are opportunistic post-sampling
services. They should not block the user-facing turn, and they must keep forked
agent requests cache-compatible with the parent request where their source says
so.

## Proactive / Kairos

| Concern | Owner | Current behavior |
|---|---|---|
| Proactive state API | `src/proactive/index.ts` | Stubbed: active/paused are always false; activate/deactivate/pause/resume/context-blocked are no-ops. |
| Proactive React hook | `src/proactive/useProactive.ts` | Stubbed: accepts loading, queue, UI, plan-mode, and tick callbacks but does nothing. |
| Activation | `src/main.tsx` | `maybeActivateProactive()` checks `--proactive` or `CLAUDE_CODE_PROACTIVE` under `PROACTIVE || KAIROS`, then calls `activateProactive('command')`. In this checkout that lands on the stub. |
| REPL guards | `src/screens/REPL.tsx` | Escape pauses proactive mode; API errors set context-blocked; successful assistant responses and compaction clear it. With stubs, these calls are inert. |
| Agent spawning | `src/tools/AgentTool/AgentTool.tsx` | Async agent execution is forced when Kairos mode is active or proactive mode reports active, so real proactive activation affects subagent blocking semantics. |

Validation decision: before relying on proactive ticks, confirm whether an
implementation replaces the stubs in the target build. The map should route
changes through the stub files first, then `REPL.tsx`, `main.tsx`, and
`AgentTool.tsx`.

## Brief And User-Visible Push Surfaces

| Surface | Owner | Routing decision |
|---|---|---|
| Brief tool | `src/tools/BriefTool/BriefTool.ts`, `src/tools/BriefTool/prompt.ts` | Model-visible user output channel named `SendUserMessage` with legacy alias `Brief`. Enabled only when entitled and explicitly opted in, except Kairos active mode bypasses opt-in. |
| `/brief` command | `src/commands/brief.ts` | Toggles `isBriefOnly`, mirrors `userMsgOptIn`, logs analytics, and injects a system reminder when not in Kairos mode. Command visibility is separately gated by `tengu_kairos_brief_config`. |
| Attachments | `src/tools/BriefTool/attachments.ts`, `src/tools/BriefTool/upload.ts` | Brief attachments resolve paths and can upload metadata for viewers. Validate paths via the tool before sending. |
| Push notification | `src/tools.ts` | `PushNotificationTool` is referenced under `KAIROS || KAIROS_PUSH_NOTIFICATION`, but no implementation exists in this checkout. Validate file presence before changing push behavior. |
| Send user file | `src/tools.ts` | `SendUserFileTool` is referenced under `KAIROS`, but no implementation exists in this checkout. Brief attachments are the concrete local file-sending surface present here. |

Brief mode is the durable Kairos-style visible-output path in this tree. When
brief is active, text outside `SendUserMessage` may be hidden or demoted; route
message visibility bugs through `BriefTool`, `src/utils/messages.ts`, and
conversation recovery before changing prompts.

## Sleep, Cron, And Triggers

| Surface | Owner | Gates and behavior |
|---|---|---|
| Sleep | `src/tools/SleepTool/prompt.ts`, `src/tools.ts` | Tool name `Sleep`; available only when bundled by `PROACTIVE || KAIROS`. Prompt says use it for resting or waiting and prefer it over shell sleep. |
| Cron tools | `src/tools/ScheduleCronTool/` | `CronCreate`, `CronDelete`, `CronList` are bundled by `AGENT_TRIGGERS` and enabled by `isKairosCronEnabled()`. Local override `CLAUDE_CODE_DISABLE_CRON` disables the system. |
| Cron runtime | `src/hooks/useScheduledTasks.ts`, `src/utils/cronScheduler.ts`, `src/utils/cronTasks.ts`, `src/utils/cronTasksLock.ts` | REPL scheduler watches `.claude/scheduled_tasks.json`, merges session-only tasks from bootstrap state, uses a per-project lock for durable tasks, and enqueues fired prompts at `later` priority with `WORKLOAD_CRON`. |
| Durable cron | `src/tools/ScheduleCronTool/prompt.ts`, `src/utils/cronTasks.ts` | `durable: true` writes `.claude/scheduled_tasks.json` only when the durable gate is enabled. Teammate crons cannot be durable. |
| Missed one-shots | `src/utils/cronScheduler.ts` | Missed durable one-shot tasks are removed, then surfaced as a prompt instructing the model to ask the user before running. |
| Remote triggers | `src/tools/RemoteTriggerTool/` | `RemoteTrigger` calls the claude.ai `/v1/code/triggers` API in-process with OAuth token and org UUID. Enabled by `tengu_surreal_dali` plus `allow_remote_sessions` policy. |

Routing decision: use local cron for in-session or project-durable prompts;
use `RemoteTrigger` for cloud/CCR scheduled remote agents; use `Sleep` for
short waits inside an active agent loop, not for durable scheduling.

## Auto Dream And DreamTask

| Concern | Owner | Routing decision |
|---|---|---|
| Initialization | `src/utils/backgroundHousekeeping.ts`, `src/services/autoDream/autoDream.ts` | `initAutoDream()` installs a closure-scoped runner at startup. |
| Turn-end trigger | `src/query/stopHooks.ts` | `executeAutoDream()` fires after main-thread turns when not bare and not inside an agent. |
| Enable gate | `src/services/autoDream/config.ts`, `src/services/autoDream/autoDream.ts` | Disabled in Kairos active mode, remote mode, and when auto memory is off. `autoDreamEnabled` setting overrides GrowthBook `tengu_onyx_plover.enabled`. |
| Thresholds | `src/services/autoDream/autoDream.ts` | Defaults: 24 hours since last consolidation and 5 touched sessions. GrowthBook can tune `minHours` and `minSessions`; session scanning is throttled to 10 minutes. |
| Lock and session scan | `src/services/autoDream/consolidationLock.ts` | `.consolidate-lock` mtime is the last consolidation timestamp; body is holder PID. Failure rolls mtime back so retry is possible. |
| Prompt | `src/services/autoDream/consolidationPrompt.ts` | Forked agent consolidates memory files, uses narrow transcript grep, updates the memory index, and returns a brief summary. |
| Task UI | `src/tasks/DreamTask/DreamTask.ts` | Registers type `dream`, tracks phase, files touched, recent turns, and supports kill by aborting the fork and rolling back lock mtime. |

Routing decision: auto dream is background memory consolidation, not a general
Kairos scheduler. Kairos active mode intentionally skips it because Kairos uses
a disk-skill dream path.

## Magic Docs

| Concern | Owner | Routing decision |
|---|---|---|
| Detection | `src/services/MagicDocs/magicDocs.ts` | FileRead listener tracks files containing `# MAGIC DOC: ...`; optional italic line after the header becomes document-specific instructions. Ant-only initialization. |
| Trigger | `src/services/MagicDocs/magicDocs.ts` | Post-sampling hook runs only for `repl_main_thread`, only when the last assistant turn has no tool calls, and only when tracked docs exist. |
| Agent | `src/services/MagicDocs/magicDocs.ts`, `src/services/MagicDocs/prompts.ts` | Async built-in `magic-docs` agent may only use Edit on the tracked file. It rereads the latest file, drops deleted/unmarked docs, and preserves the header. |
| Prompt source | `src/services/MagicDocs/prompts.ts` | Uses `~/.claude/magic-docs/prompt.md` when present, otherwise default rules. Provider prompt style changes formatting only. |

Routing decision: Magic Docs should update current architecture docs in place
after useful conversation signal, not append changelog history and not write
outside the tracked file.

## Prompt Suggestions And Speculation

| Concern | Owner | Routing decision |
|---|---|---|
| Enable gate | `src/services/PromptSuggestion/promptSuggestion.ts` | Env override wins. Otherwise requires GrowthBook `tengu_chomp_inflection`, interactive mode, non-teammate leader, and `promptSuggestionEnabled !== false`. |
| Suppression | `src/services/PromptSuggestion/promptSuggestion.ts` | Suppress for disabled state, pending permission/sandbox request, elicitation, plan mode, external rate limit, early conversations, API errors, and cold parent cache. |
| Generation | `src/services/PromptSuggestion/promptSuggestion.ts` | Forked agent predicts the user's next likely input, denies tools through `canUseTool`, skips transcript, and skips cache writes. |
| Filtering | `src/services/PromptSuggestion/promptSuggestion.ts` | Rejects meta text, formatting, too-short/too-long output, evaluative text, Claude-voice text, and multi-sentence suggestions. |
| Speculation | `src/services/PromptSuggestion/speculation.ts`, `src/screens/REPL.tsx` | Ant-only optional fast path. Runs the suggested prompt in an overlay, allows safe reads and permission-compatible writes, stops at unsafe bash/tool boundaries, and copies overlay writes to main only on accept. |
| Acceptance | `src/services/PromptSuggestion/speculation.ts` | Injects speculated messages, merges read-file cache, logs time saved, and can promote a pipelined suggestion. Failures fall back to normal query flow. |

Routing decision: suggestion text is UI affordance; speculation is an isolated
execution cache. Do not let either bypass permission, elicitation, or plan-mode
gates.

## Tips

| Concern | Owner | Routing decision |
|---|---|---|
| Spinner pick | `src/screens/REPL.tsx`, `src/services/tips/tipScheduler.ts` | REPL picks at most one tip per turn, passing theme, read-file cache, and observed bash tools. |
| Relevance | `src/services/tips/tipRegistry.ts` | Built-in tips inspect settings, startup counts, IDE state, plugins, feature gates, and file/CLI signals. Custom settings can add tips or exclude defaults. |
| Cooldown | `src/services/tips/tipHistory.ts` | Records last shown startup count in global config and picks the relevant tip with the longest time since shown. |
| Analytics | `src/services/tips/tipScheduler.ts` | `recordShownTip()` records history and logs `tengu_tip_shown`. |

Routing decision: tips are spinner education only. They should never trigger
work, mutate project files, or replace prompt suggestions.

## Agent Summaries

| Concern | Owner | Routing decision |
|---|---|---|
| Service | `src/services/AgentSummary/agentSummary.ts` | Every 30 seconds, read agent transcript, filter incomplete tool calls, fork a no-tool summary prompt, and update local agent task progress. |
| Call sites | `src/tools/AgentTool/agentToolUtils.ts`, `src/tools/AgentTool/AgentTool.tsx` | Started for SDK/background progress summaries when cache-safe params are available; stopped when the foreground/background agent lifecycle ends. |
| Cache contract | `src/services/AgentSummary/agentSummary.ts` | Keep parent cache-safe params and deny tools by callback; do not add output-token overrides that change cache keys. |

Routing decision: agent summaries are progress labels, not task results. Keep
them short, current, and derived from the agent transcript.

## Gates Checklist

Check these before changing always-on behavior:

- Build flags: `PROACTIVE`, `KAIROS`, `KAIROS_BRIEF`, `KAIROS_PUSH_NOTIFICATION`, `AGENT_TRIGGERS`, `AGENT_TRIGGERS_REMOTE`, `EXTRACT_MEMORIES`.
- Runtime settings: `autoDreamEnabled`, `promptSuggestionEnabled`, `spinnerTipsEnabled`, `spinnerTipsOverride`, default view/brief opt-in.
- Runtime state: `getKairosActive()`, `getUserMsgOptIn()`, `getIsRemoteMode()`, `getIsNonInteractiveSession()`, scheduled task state, teammate context.
- Environment overrides: `CLAUDE_CODE_PROACTIVE`, `CLAUDE_CODE_BRIEF`, `CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`.
- GrowthBook gates/configs: `tengu_onyx_plover`, `tengu_chomp_inflection`, `tengu_kairos_brief`, `tengu_kairos_brief_config`, `tengu_kairos_cron`, `tengu_kairos_cron_durable`, `tengu_surreal_dali`.
- Permission gates: tool permission context, plan mode, pending permission/sandbox requests, policy `allow_remote_sessions`, teammate ownership restrictions.

## Validation

For docs-only refreshes, run:

```bash
git diff --check -- docs/maps/proactive-assistant-services.md
test -f docs/maps/proactive-assistant-services.md
```

For behavior changes, add source-specific validation:

- Proactive/Kairos: confirm whether `src/proactive/` stubs are replaced in the
  target build and whether `src/commands/proactive.*`,
  `PushNotificationTool`, or `SendUserFileTool` exist.
- Brief: verify `/brief` toggles tool availability and visible output routing.
- Cron: test session-only and durable create/list/delete, missed one-shot
  handling, and lock behavior with two sessions in the same project.
- Auto dream: test gate order, lock rollback, DreamTask kill, and completion
  message when files are touched.
- Magic Docs: test header detection, deleted-file untracking, same-file-only
  Edit permission, and no update after tool-using turns.
- Prompt suggestions/speculation: test suppression reasons, cache-cold guard,
  filtering, overlay copy-on-accept, and fallback on speculation failure.
- Agent summaries: test timer cleanup and transcript-derived summary updates
  without allowing tools.
