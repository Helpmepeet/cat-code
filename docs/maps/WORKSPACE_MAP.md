# Workspace Map

Last refreshed: 2026-07-05

## Purpose

This is the main daily-refreshable routing map for Cat Code. Use it to choose
the first files to inspect before changing behavior. It is not a full
architecture guide and should not duplicate detailed domain notes; put those in
the focused sub-maps linked below.

Verify behavior in source before editing. This repository is a forked snapshot,
and older plans, feature flags, and implementation can drift.

## Map Index

Keep detailed domain content in these sub-maps:

| Sub-map | Scope |
|---|---|
| [`prompt-system.md`](prompt-system.md) | System prompts, instruction injection, output styles, prompt context, and prompt-policy owners. |
| [`agent-mode.md`](agent-mode.md) | Agent Mode orchestration, deployment-aware behavior, roles, worker identity, and mode-specific prompts. |
| [`tools-permissions.md`](tools-permissions.md) | Built-in tools, MCP tools, permissions, sandboxing, approvals, and policy gates. |
| [`tasks-workers.md`](tasks-workers.md) | Background tasks, retained agents, shell tasks, worker lifecycle, and task UI. |
| [`terminal-ui-state.md`](terminal-ui-state.md) | Terminal UI, REPL state, Ink components, prompt input, messages, keybindings, and dialogs. |
| [`codex-core.md`](codex-core.md) | Codex-backed API behavior, account pool, request/response shaping, and provider routing. |
| [`query-provider-runtime.md`](query-provider-runtime.md) | Provider-neutral query loop, model/provider routing, context assembly, and API client flow. |
| [`config-persistence.md`](config-persistence.md) | Settings layers, config files, transcripts, memory, migrations, and persistence scope. |
| [`auth-accounts-oauth.md`](auth-accounts-oauth.md) | Auth source selection, OAuth, account storage/switching, secure storage, and account pools. |
| [`plugins-skills-commands.md`](plugins-skills-commands.md) | Slash command aggregation, skills, plugins, workflows, marketplace/install flows, and dynamic command sources. |
| [`bridge-remote-cli.md`](bridge-remote-cli.md) | Bridge, remote control, direct-connect, structured CLI/SDK transport, CCR, and upstream proxy. |
| [`web-app-runtime.md`](web-app-runtime.md) | Browser and Electron app runtimes, app-session controller, local transports, renderer state, and startup seams. |
| [`ide-lsp.md`](ide-lsp.md) | IDE integration, LSP lifecycle, diagnostics, LSP tool exposure, and plugin LSP config. |
| [`native-client-integrations.md`](native-client-integrations.md) | Chrome/browser integration, computer-use, native shims, desktop/mobile, and voice. |
| [`proactive-assistant-services.md`](proactive-assistant-services.md) | Proactive/Kairos-style services, auto dream, MagicDocs, tips, assistant summaries, and triggers. |
| [`build-release-testing.md`](build-release-testing.md) | Build/dev/compile scripts, feature sets, migrations, release/upgrade/update, lint, and tests. |
| [`analytics-diagnostics.md`](analytics-diagnostics.md) | Analytics/telemetry, GrowthBook gates, diagnostics, doctor, logging, stats, and cost/status. |

## Broad Routing Table

| Area | Inspect first | Then inspect | Detailed map |
|---|---|---|---|
| Startup and runtime assembly | `src/entrypoints/cli.tsx`, `src/entrypoints/init.ts` | `src/main.tsx`, `src/bootstrap/state.ts`, `src/screens/REPL.tsx` | [`query-provider-runtime.md`](query-provider-runtime.md), [`terminal-ui-state.md`](terminal-ui-state.md) |
| Main terminal UI and session loop | `src/screens/REPL.tsx` | `src/replLauncher.tsx`, `src/components/`, `src/hooks/`, `src/state/`, `src/ink/` | [`terminal-ui-state.md`](terminal-ui-state.md) |
| Slash commands and command exposure | `src/commands.ts` | `src/commands/`, `src/skills/`, `src/plugins/`, `src/utils/plugins/` | [`plugins-skills-commands.md`](plugins-skills-commands.md) |
| Build scripts and feature gates | `package.json`, `scripts/build.ts` | Runtime `feature(...)` call sites in entrypoints, commands, tools, and tasks | [`build-release-testing.md`](build-release-testing.md) |
| Prompt system and instruction behavior | `docs/prompts/` prompt-surface notes | `src/constants/prompts.ts`, `src/context.ts`, `src/utils/queryContext.ts`, `src/tools/AgentTool/` | [`prompt-system.md`](prompt-system.md) |
| Agent Mode and delegated workers | `src/agent-mode/` | `src/tools/AgentTool/`, `src/tasks/`, `src/screens/REPL.tsx`, `src/QueryEngine.ts` | [`agent-mode.md`](agent-mode.md), [`tasks-workers.md`](tasks-workers.md) |
| Built-in tools, MCP, permissions, sandboxing | `src/tools.ts`, `src/hooks/useCanUseTool.tsx` | `src/tools/`, `src/services/mcp/`, `src/utils/permissions/`, `src/utils/sandbox/` | [`tools-permissions.md`](tools-permissions.md) |
| Standalone MCP helper servers | `scripts/mcp/` | Helper-specific tests, transcript/session files they inspect, CLI command they spawn | [`tools-permissions.md`](tools-permissions.md), [`build-release-testing.md`](build-release-testing.md) |
| Background tasks and task UI | `src/tasks.ts` | `src/tasks/`, `src/components/tasks/`, `src/hooks/useBackgroundTaskNavigation.ts` | [`tasks-workers.md`](tasks-workers.md) |
| Query/provider runtime | `src/QueryEngine.ts`, `src/query.ts` | `src/services/api/client.ts`, `src/services/api/claude.ts`, `src/utils/model/`, `src/context.ts` | [`query-provider-runtime.md`](query-provider-runtime.md) |
| Codex-backed API behavior | `src/codex-core/`, `src/services/api/codex-fetch-adapter.ts` | `src/services/api/codexAccountPool.ts`, `src/services/api/codexAccountLeaseManager.ts`, Codex transport surfaces | [`codex-core.md`](codex-core.md) |
| Settings, config, persistence, memory | `src/utils/settings/settings.ts`, `src/utils/config.ts` | `src/utils/sessionStorage.ts`, `src/memdir/`, `src/services/SessionMemory/`, migrations | [`config-persistence.md`](config-persistence.md) |
| Auth, login, account state | `src/utils/auth.ts` | `src/services/oauth/`, `src/commands/login/`, `src/commands/accounts/`, secure storage, account pool touchpoints | [`auth-accounts-oauth.md`](auth-accounts-oauth.md) |
| Bridge, remote control, structured IO | `src/bridge/initReplBridge.ts`, `src/cli/structuredIO.ts` | `src/bridge/`, `src/remote/`, `src/server/`, `src/cli/transports/`, `src/upstreamproxy/` | [`bridge-remote-cli.md`](bridge-remote-cli.md) |
| Browser chat and app runtime | `src/main.tsx`, `src/web/startRuntimeBackedWebMode.ts`, `src/web/AppSessionWebSocketServer.ts` | `src/app-runtime/AppSessionController.ts`, `src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts`, `web/src/App.tsx`, `web/src/appState.ts` | [`web-app-runtime.md`](web-app-runtime.md), [`build-release-testing.md`](build-release-testing.md) |
| Electron desktop app | `app/main/main.ts`, `app/supervisor/supervisor.ts` | `app/sidecar/`, `app/preload/preload.ts`, `app/renderer/`, `app/shared/` | [`web-app-runtime.md`](web-app-runtime.md), [`build-release-testing.md`](build-release-testing.md) |
| IDE and LSP integration | `src/services/lsp/manager.ts`, `src/commands/ide/` | `src/tools/LSPTool/`, IDE components/hooks/utils, plugin LSP integration | [`ide-lsp.md`](ide-lsp.md) |
| Native/browser/client integrations | `src/utils/claudeInChrome/`, `src/utils/computerUse/` | `src/native-ts/`, `src/voice/`, desktop/mobile/chrome/voice commands | [`native-client-integrations.md`](native-client-integrations.md) |
| Proactive and assistant services | `src/proactive/` | `src/services/autoDream/`, `src/services/MagicDocs/`, `src/services/tips/`, trigger/sleep/brief surfaces | [`proactive-assistant-services.md`](proactive-assistant-services.md) |
| Workspace and repository discovery | `src/utils/cwd.ts` | `src/commands/add-dir/`, `src/utils/detectRepository.ts`, `src/utils/githubRepoPathMapping.ts` | [`config-persistence.md`](config-persistence.md) |
| Diagnostics, logging, and validation | `src/screens/Doctor.tsx`, `src/utils/debug.ts` | `src/utils/log.ts`, analytics/telemetry surfaces, stats/cost/status diagnostics | [`analytics-diagnostics.md`](analytics-diagnostics.md) |

## Maintenance Rules

- Keep this file concise: route by area, owner files, and sub-map only.
- Do not add phase plans, research notes, low-level call chains, or exact
  function walkthroughs here.
- Do not include dates in map filenames. Dates are allowed in content refresh
  lines.
- When a domain needs more detail, update or create the relevant sub-map instead
  of expanding this main map.
- Prefer implementation over prose when docs disagree; then refresh the affected
  route and note only the durable owner surface here.
