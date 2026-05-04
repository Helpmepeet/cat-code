# Workspace Routing Map

This is a routing-oriented map for AI agents working in this repository.

Use it to answer questions like:
- If I want to change X, where should I inspect first?
- What is the next likely surface after that?
- Does this concern have a clear first-class home, or is it spread across multiple layers?

This is intentionally:
- medium/high-level
- practical
- optimized for navigation before change
- not a low-level architecture walkthrough
- not a real-time or exhaustive source of truth

This repository is a forked source snapshot, not a clean upstream workspace. Verify fork-specific behavior before assuming upstream Claude Code defaults still apply.

## First Read

Start here before touching domain-specific code:
- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `docs/prompts/2026-04-30-prompt-surfaces.md` if the task involves prompts, instructions, agent behavior, or output style

Then orient on the main runtime surfaces:
- `src/entrypoints/cli.tsx`
- `src/entrypoints/init.ts`
- `src/main.tsx`
- `src/commands.ts`
- `src/tools.ts`
- `src/screens/REPL.tsx`

These files tell you:
- how the process boots
- which command and tool surfaces exist
- where the interactive runtime converges

## Routing Table

| If you want to configure/change X | Look here first | Then inspect | Notes |
|---|---|---|---|
| Find all instruction/prompt surfaces | `docs/prompts/2026-04-30-prompt-surfaces.md` | `src/constants/prompts.ts`, `src/utils/claudemd.ts`, `src/tools/AgentTool/`, `src/tools/*/prompt.ts` | Use this as the prompt-specific routing index before broad search. It collects the main system prompt path, injected instruction sources, agent/tool prompt owners, and maintenance prompts. |
| System prompt behavior | `src/constants/prompts.ts` | `src/constants/systemPromptSections.ts`, `src/utils/queryContext.ts`, `src/QueryEngine.ts`, `src/utils/systemPrompt.ts` | Prompt behavior is assembled, not owned by one file. `prompts.ts` is the main policy/prompt surface; `QueryEngine` applies custom and appended prompt variants. |
| Agent and prompt behavior | `src/constants/prompts.ts` | `src/tools/AgentTool/runAgent.ts`, `src/constants/system.ts` | `prompts.ts` owns the main prompt pipeline and deployment-aware behavior. `runAgent.ts` builds agent runtime prompts. Verify actual entrypoints in code before assuming a separate `src/agent/` subtree exists. |
| Behavior rules / output style | `src/constants/prompts.ts` | `src/constants/outputStyles.ts`, `src/outputStyles/loadOutputStylesDir.ts`, `src/tools/AgentTool/prompt.ts` | Most agent behavior rules still live in prompt text. Output style is resolved separately and then injected back into the prompt. |
| Auto-injected prompt context | `src/context.ts` | `src/utils/claudemd.ts`, `src/utils/queryContext.ts`, `src/QueryEngine.ts` | Start here if you want to remove or alter automatic git status, `CLAUDE.md`, date, or related context injection. |
| MCP setup | `src/services/mcp/config.ts` | `src/services/mcp/useManageMCPConnections.ts`, `src/services/mcp/client.ts`, `src/commands/mcp/index.ts`, `src/commands/mcp/addCommand.ts`, `src/services/mcpServerApproval.tsx` | `config.ts` is the config merge/dedup/scope surface. Connection lifecycle and surfaced MCP tools/resources happen later. |
| Tool exposure | `src/tools.ts` | `src/services/mcp/client.ts`, `src/services/mcp/utils.ts`, `src/commands.ts` | Built-in tools are registered centrally. MCP can add tools, prompts, commands, and resources dynamically. |
| Permissions / tool policy | `src/hooks/useCanUseTool.tsx` | `src/utils/permissions/permissions.ts`, `src/utils/permissions/permissionSetup.ts`, `src/components/permissions/PermissionRequest.tsx`, `src/services/tools/toolExecution.ts` | This is the main allow/ask/deny path. Inspect here before changing tool implementations. |
| Sandbox behavior | `src/utils/sandbox/sandbox-adapter.ts` | `src/utils/permissions/filesystem.ts`, `src/utils/permissions/PermissionMode.ts`, `src/main.tsx` | Sandbox config is derived from settings and permission rules; CLI and session switches sit outside the sandbox adapter. |
| Skills | `src/skills/loadSkillsDir.ts` | `src/skills/bundledSkills.ts`, `src/skills/bundled/index.ts`, `src/skills/mcpSkillBuilders.ts`, `src/commands/skills/index.ts` | Skills come from several sources: user, project, managed, plugin, bundled, and MCP. Start with the loader before editing a specific skill. |
| Plugins | `src/utils/plugins/pluginLoader.ts` | `src/plugins/builtinPlugins.ts`, `src/utils/plugins/loadPluginCommands.ts`, `src/utils/plugins/mcpPluginIntegration.ts`, `src/utils/plugins/loadPluginOutputStyles.ts` | Plugin changes often spill into commands, skills, MCP, hooks, and output styles. |
| Auth | `src/utils/auth.ts` | `src/services/oauth/client.ts`, `src/components/ConsoleOAuthFlow.tsx`, `src/commands/login/login.tsx`, `src/services/oauth/getOauthProfile.ts` | Auth source selection and fallback behavior start in `utils/auth.ts`; OAuth flow details live under `services/oauth/`. |
| Session bootstrap | `src/entrypoints/cli.tsx` | `src/entrypoints/init.ts`, `src/main.tsx`, `src/bootstrap/state.ts` | Startup is layered: CLI fast paths, shared init, then full app assembly. |
| Settings / config layering | `src/utils/settings/settings.ts` | `src/utils/settings/constants.ts`, `src/utils/managedEnv.ts`, `src/services/remoteManagedSettings/index.ts`, `src/utils/config.ts` | Settings merge rules and env application rules are not the same. Check both before changing provider, auth, or config behavior. |
| Config migrations / legacy compatibility | `src/main.tsx` | `src/migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.ts`, `src/migrations/migrateEnableAllProjectMcpServersToSettings.ts`, `src/migrations/migrateSonnet45ToSonnet46.ts` | If you rename settings keys, model aliases, or old config fields, inspect startup migrations as well as the current settings readers. |
| Hooks / lifecycle automation | `src/utils/hooks.ts` | `src/commands/hooks/index.ts`, `src/utils/processUserInput/processUserInput.ts`, `src/setup.ts`, `src/main.tsx`, `src/types/hooks.ts`, `src/schemas/hooks.ts` | Hooks are a first-class behavior surface for setup, session start/end, prompt submission, tool use, and config changes. They are not just a settings detail. |
| Bridge / remote-control integration | `src/bridge/initReplBridge.ts` | `src/bridge/bridgeMain.ts`, `src/bridge/replBridge.ts`, `src/server/directConnectManager.ts`, `src/remote/RemoteSessionManager.ts` | Use this path for claude.ai or desktop bridge behavior, remote-control/session mirroring, and direct-connect style integration. Feature-gated and adjacent to remote session surfaces. |
| Coordinator mode / delegated-work prompt policy | `src/coordinator/coordinatorMode.ts` | `src/utils/systemPrompt.ts`, `src/utils/toolPool.ts`, `src/tools/AgentTool/AgentTool.tsx`, `src/QueryEngine.ts` | This is the special multi-worker orchestration mode. It affects system prompt content, allowed tool pool, resume behavior, and subagent workflow expectations. |
| Agent runtime / orchestration | `src/tools/AgentTool/AgentTool.tsx` | `src/tools/AgentTool/runAgent.ts`, `src/tools/AgentTool/forkSubagent.ts`, `src/services/tools/toolOrchestration.ts`, `src/query.ts`, `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` | This is the main routing path for subagents, forks, background agents, and turn-loop orchestration. |
| Context assembly / memory | `src/memdir/memdir.ts` | `src/services/SessionMemory/sessionMemory.ts`, `src/services/extractMemories/prompts.ts`, `src/query/stopHooks.ts` | Persistent memory, session memory, and post-turn extraction are separate surfaces. |
| Provider / model routing | `src/utils/model/model.ts` | `src/utils/model/providers.ts`, `src/services/api/client.ts`, `src/services/api/claude.ts` | Model selection happens before API shaping. Provider choice is mostly env-driven. |
| IDE / LSP integration | `src/services/lsp/manager.ts` | `src/services/lsp/config.ts`, `src/services/lsp/passiveFeedback.ts`, `src/commands/ide/index.ts`, `src/main.tsx` | Use this route for editor integration, LSP lifecycle, diagnostics, and whether LSP is initialized after trust or in bare mode. |
| UI / UX | `src/screens/REPL.tsx` | `src/replLauncher.tsx`, `src/state/AppStateStore.ts`, `src/components/Messages.tsx`, `src/components/PromptInput/PromptInput.tsx` | `REPL.tsx` is the operational UI hub. Most user-visible behavior eventually passes through it. |
| Notifications | `src/context/notifications.tsx` | `src/components/PromptInput/Notifications.tsx`, `src/state/AppStateStore.ts` | Start here for notification queue behavior, prioritization, dismissal, and footer/status messaging. |
| Overlays / prompt-float UX | `src/context/overlayContext.tsx` | `src/context/promptOverlayContext.tsx`, `src/components/PromptInput/PromptInput.tsx`, `src/state/AppStateStore.ts` | Use this route for Escape-key coordination, modal overlay activity, and prompt-floating dialogs or suggestion layers. |
| Companion / buddy UX | `src/components/PromptInput/PromptInput.tsx` | `src/buddy/useBuddyNotification.tsx`, `src/buddy/CompanionSprite.tsx`, `src/buddy/companion.ts` | This feature is UI-driven and feature-gated. Start at the prompt input integration point, then inspect companion state and teaser/notification behavior. |
| Keybindings / Vim input UX | `src/keybindings/KeybindingProviderSetup.tsx` | `src/keybindings/defaultBindings.ts`, `src/keybindings/loadUserBindings.ts`, `src/keybindings/resolver.ts`, `src/vim/motions.ts`, `src/commands/keybindings`, `src/commands/vim` | Input behavior is its own layer, separate from REPL rendering. User bindings and Vim-style editing are not owned by the main screen components. |
| Voice mode | `src/commands/voice/index.ts` | `src/voice/voiceModeEnabled.ts`, `src/commands/voice/voice.ts`, `src/utils/auth.ts`, `src/services/analytics/growthbook.ts` | Voice exposure is gated both by feature flags and Anthropic OAuth availability. Treat it as a command plus runtime gate, not a generic input mode. |
| Command / action surfaces | `src/commands.ts` | `src/tools.ts`, `src/main.tsx`, `src/services/tools/toolOrchestration.ts` | Slash commands, CLI entry actions, and tool execution are distinct surfaces. |
| Structured CLI / SDK transport | `src/cli/structuredIO.ts` | `src/cli/remoteIO.ts`, `src/cli/transports/HybridTransport.ts`, `src/cli/transports/SSETransport.ts`, `src/cli/transports/WebSocketTransport.ts`, `src/server/directConnectManager.ts` | Start here for machine-facing IO, SDK protocol handling, permission request forwarding, and remote transport plumbing rather than the human REPL path. |
| Remote container proxy / upstream relay | `src/upstreamproxy/upstreamproxy.ts` | `src/upstreamproxy/relay.ts`, `src/entrypoints/init.ts`, `src/utils/subprocessEnv.ts`, `src/utils/proxy.ts` | Only relevant for CCR-style remote sessions. Start at the feature owner, then inspect init-time wiring and subprocess env injection. |
| Workflow / session lifecycle / resume | `src/screens/REPL.tsx` | `src/utils/sessionStart.ts`, `src/utils/hooks.ts`, `src/utils/sessionRestore.ts`, `src/utils/sessionStorage.ts`, `src/utils/conversationRecovery.ts` | Lifecycle is REPL-centered, with hooks and storage/restore layered around it. |
| Workspace / repo discovery | `src/utils/cwd.ts` | `src/commands/add-dir/index.ts`, `src/commands/add-dir/validation.ts`, `src/utils/detectRepository.ts`, `src/utils/githubRepoPathMapping.ts` | This concern is spread across cwd management, explicit workspace expansion, and git/repo detection. |
| Review / safety gates | `src/interactiveHelpers.tsx` | `src/components/TrustDialog/TrustDialog.tsx`, `src/services/mcpServerApproval.tsx`, `src/commands/review.ts`, `src/commands/security-review.ts`, `src/services/policyLimits/index.ts` | There is no single safety module. Trust, policy limits, prompt rules, permissions, and review commands are separate layers. |
| Logging / debugging | `src/utils/debug.ts` | `src/utils/log.ts`, `src/services/api/logging.ts`, `src/services/diagnosticTracking.ts`, `src/screens/Doctor.tsx` | `debug.ts` is the main debug sink; `/doctor` is the main operator-facing diagnostics surface. |
| Tests / validation | `package.json` | `src/utils/settings/validation.ts`, `src/utils/settings/allErrors.ts`, `src/screens/Doctor.tsx`, `src/tools/testing/TestingPermissionTool.tsx` | There is no obvious normal test-suite home in this snapshot. Validation is more operational and settings-centric than test-runner-centric. |

## Example Routes

| If you want to... | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Find every prompt/instruction owner before making a prompt change | `docs/prompts/2026-04-30-prompt-surfaces.md` | `src/constants/prompts.ts`, `src/utils/claudemd.ts`, `src/tools/AgentTool/`, `src/tools/*/prompt.ts` | Start here when the real question is "where do prompts live?" rather than "how does one specific feature work?" |
| Adjust the terminal UI color palette or theme colors | `src/utils/theme.ts` | `src/components/ThemePicker.tsx`, `src/commands/theme/theme.tsx`, `src/components/design-system/color.ts` | Start in `theme.ts` if you want to change actual semantic color values like `claude`, `warning`, `permission`, or `clawd_body`. |
| Stop auto-injecting `CLAUDE.md` into prompt context | `src/context.ts` | `src/utils/claudemd.ts`, `src/utils/queryContext.ts`, `src/QueryEngine.ts` | `context.ts` decides whether `CLAUDE.md` memory is loaded at all; `claudemd.ts` controls discovery and ordering. |
| Change system prompt rules or assistant behavior style | `src/constants/prompts.ts` | `src/utils/systemPrompt.ts`, `src/utils/queryContext.ts`, `src/QueryEngine.ts` | Use this route when changing default behavior, formatting rules, or policy text rather than repo memory files. |
| Change deployment-aware identity or behavior | `src/constants/prompts.ts` | `src/tools/AgentTool/runAgent.ts`, `src/constants/system.ts` | Main prompt behavior lives in `prompts.ts`; agent runtime prompt assembly lives in `runAgent.ts`; identity prefixes are in `system.ts`. |
| Change which slash commands exist or how they are exposed | `src/commands.ts` | the matching module under `src/commands/`, `src/main.tsx`, `src/screens/REPL.tsx` | Start at the registry, then inspect the specific command module and any startup path that exposes it. |
| Change which tools the model can see or call | `src/tools.ts` | `src/hooks/useCanUseTool.tsx`, `src/utils/permissions/permissions.ts`, `src/services/tools/toolExecution.ts` | Tool registration and tool permission policy are separate surfaces; inspect both before changing behavior. |
| Change MCP config scope, auto-connect, or exposed MCP tools | `src/services/mcp/config.ts` | `src/services/mcp/useManageMCPConnections.ts`, `src/services/mcp/client.ts`, `src/commands/mcp/index.ts` | Start here if the question is where MCP servers come from, how they merge, or what gets surfaced into the session. |
| Recover or change auth/login behavior | `src/utils/auth.ts` | `src/services/oauth/client.ts`, `src/commands/login/login.tsx`, `src/utils/config.ts` | Use this route for login source selection, token refresh/recovery, and persisted local account state. |
| Change settings precedence or config layering | `src/utils/settings/settings.ts` | `src/utils/settings/constants.ts`, `src/utils/managedEnv.ts`, `src/utils/config.ts` | Start here when the real question is precedence, merge rules, or which scopes are loaded. |
| Change session resume, recovery, or transcript restore | `src/utils/sessionStorage.ts` | `src/utils/conversationRecovery.ts`, `src/utils/sessionRestore.ts`, `src/screens/REPL.tsx`, `src/commands/resume/resume.tsx` | Persistence, recovery, and resume UI are split; do not change only one layer. |
| Change coordinator/subagent behavior | `src/coordinator/coordinatorMode.ts` | `src/tools/AgentTool/AgentTool.tsx`, `src/utils/toolPool.ts`, `src/utils/systemPrompt.ts`, `src/QueryEngine.ts` | This path affects special orchestration mode, prompt content, and allowed tool pool together. |
| Change hooks that run on setup, session start, prompt submit, or tool use | `src/utils/hooks.ts` | `src/commands/hooks/index.ts`, `src/setup.ts`, `src/main.tsx`, `src/utils/processUserInput/processUserInput.ts`, `src/types/hooks.ts` | Use this route for lifecycle automation, blocking hooks, hook schemas, or hook-trigger wiring. |
| Change IDE integration or LSP diagnostics behavior | `src/services/lsp/manager.ts` | `src/services/lsp/config.ts`, `src/services/lsp/passiveFeedback.ts`, `src/commands/ide/index.ts`, `src/main.tsx` | Start here for editor-facing diagnostics, LSP server startup, and IDE status/integration surfaces. |
| Change keybindings or Vim-style input behavior | `src/keybindings/KeybindingProviderSetup.tsx` | `src/keybindings/defaultBindings.ts`, `src/keybindings/loadUserBindings.ts`, `src/vim/motions.ts`, `src/commands/keybindings`, `src/commands/vim` | Input handling is its own layer, separate from the main REPL screen. |
| Change claude.ai bridge, remote-control, or session mirroring behavior | `src/bridge/initReplBridge.ts` | `src/bridge/bridgeMain.ts`, `src/bridge/replBridge.ts`, `src/server/directConnectManager.ts`, `src/remote/RemoteSessionManager.ts` | Use this route for bridge-managed sessions and remote-control behavior. |
| Change machine-facing CLI or SDK transport behavior | `src/cli/structuredIO.ts` | `src/cli/remoteIO.ts`, `src/cli/transports/HybridTransport.ts`, `src/cli/transports/SSETransport.ts`, `src/cli/transports/WebSocketTransport.ts` | Use this route for stream-json, SDK protocol handling, permission request forwarding, and transport wiring. |

## If Adding Or Pruning A Feature

- Start with the exposure surface, not the implementation details:
  - commands: `src/commands.ts`
  - tools: `src/tools.ts`
  - UI entry points: `src/screens/REPL.tsx`, `src/main.tsx`
  - bootstrap and CLI fast paths: `src/entrypoints/cli.tsx`, `src/entrypoints/init.ts`
- Check feature gating before assuming the surface is live:
  - build-time flags: `scripts/build.ts`
  - runtime call sites: `src/entrypoints/cli.tsx`, `src/main.tsx`, `src/commands.ts`, `src/tools.ts`, `src/tasks.ts`
- If the feature changes agent behavior, also inspect prompt and policy surfaces:
  - prompt/rules: `src/constants/prompts.ts`, `src/context.ts`, `src/utils/queryContext.ts`
  - permissions/policy: `src/hooks/useCanUseTool.tsx`, `src/utils/permissions/permissions.ts`, `src/services/policyLimits/index.ts`
- If the feature is stateful, inspect persistence and recovery before shipping it:
  - settings/config: `src/utils/settings/settings.ts`, `src/utils/config.ts`
  - transcripts/session restore: `src/utils/sessionStorage.ts`, `src/utils/sessionRestore.ts`, `src/utils/conversationRecovery.ts`
  - memory: `src/memdir/memdir.ts`, `src/services/SessionMemory/sessionMemory.ts`
- When pruning a feature, remove or verify all of the following rather than just the implementation:
  - registry exposure
  - feature flags
  - prompt or auto-injected context references
  - settings/config keys
  - session restore or persistence hooks
  - doctor/debug/operator-facing surfaces

## Persistence Scope And Config Layering

- Session-only state is mostly in-memory for the current process. Main surfaces: `src/bootstrap/state.ts`, `src/utils/sessionEnvVars.ts`, `src/utils/settings/settingsCache.ts`. This includes `/env` vars, session-only trust and permission decisions, inline `--settings` JSON, `--plugin-dir` plugins, and merged settings caches.
- User-global config lives outside the repo:
  - user settings: `~/.cat-code/settings.json` or `~/.cat-code/cowork_settings.json` via `src/utils/settings/settings.ts`
  - global config file: `${CLAUDE_CONFIG_DIR:-$HOME/.cat-code}/.cat-code*.json`, with legacy fallback `~/.cat-code/.config.json`, via `src/utils/env.ts` and `src/utils/config.ts`
  - user instruction memory: `~/.cat-code/CLAUDE.md` and `~/.cat-code/rules/` via `src/utils/config.ts` and `src/utils/claudemd.ts`
  - cached remote policy/config artifacts: `~/.cat-code/remote-settings.json` and `~/.cat-code/policy-limits.json` via `src/services/remoteManagedSettings/syncCacheState.ts` and `src/services/policyLimits/index.ts`
- User-global but project-keyed state is stored inside the global config file, not in repo files. `src/utils/config.ts` keeps `projects[canonicalGitRootOrCwd]` entries for per-project user state such as onboarding, trust, MCP toggles, and recent metrics.
- Project-shared settings are repo-scoped and intended to travel with the workspace:
  - `.claude/settings.json`
  - `CLAUDE.md`
  - `.claude/CLAUDE.md`
  - `.claude/rules/*.md`
  - primary readers: `src/utils/settings/settings.ts`, `src/utils/claudemd.ts`
- Project-local settings are repo-scoped but private:
  - `.claude/settings.local.json`
  - `CLAUDE.local.md`
  - main handling: `src/utils/settings/settings.ts`, `src/utils/claudemd.ts`
- Managed policy is a separate admin-controlled layer:
  - file-based managed settings: `/etc/claude-code/managed-settings.json` plus `/etc/claude-code/managed-settings.d/*.json` on Linux, `/Library/Application Support/ClaudeCode/managed-settings.json` plus drop-ins on macOS, `C:\Program Files\ClaudeCode\managed-settings.json` plus drop-ins on Windows via `src/utils/settings/managedPath.ts`
  - OS policy/MDM: macOS `com.anthropic.claudecode` managed preferences; Windows `HKLM\SOFTWARE\Policies\ClaudeCode` with `HKCU\SOFTWARE\Policies\ClaudeCode` as lowest-priority fallback via `src/utils/settings/mdm/constants.ts` and `src/utils/settings/mdm/settings.ts`
  - remote managed settings cache: `~/.cat-code/remote-settings.json`
- Transcript and memory files are separate from settings/config files:
  - session transcript: `~/.cat-code/projects/<sanitized-project>/<sessionId>.jsonl` via `src/utils/sessionStorage.ts`
  - session memory summary: `~/.cat-code/projects/<sanitized-project>/<sessionId>/session-memory/summary.md` via `src/utils/permissions/filesystem.ts` and `src/services/SessionMemory/sessionMemory.ts`
  - auto memory: `~/.cat-code/projects/<sanitized-git-root>/memory/MEMORY.md` via `src/memdir/paths.ts`
  - team memory: `~/.cat-code/projects/<sanitized-git-root>/memory/team/MEMORY.md` via `src/memdir/teamMemPaths.ts`
  - managed/user/project/local instruction memory remains separate from auto-managed memory: managed `.../CLAUDE.md`, user `~/.cat-code/CLAUDE.md`, project `CLAUDE.md` and `.claude/CLAUDE.md`, local `CLAUDE.local.md`
- Settings precedence for normal merged settings is low to high: plugin settings base -> user settings -> project settings -> local settings -> flag settings -> policy settings. Main sources: `src/utils/settings/settingsCache.ts`, `src/utils/settings/constants.ts`, `src/utils/settings/settings.ts`.
- `policySettings` is the main exception: it does not deep-merge all policy sources. It takes the first populated policy source in this order and uses only that source: remote managed settings -> admin MDM/HKLM/plist -> managed settings files/drop-ins -> HKCU.
- Inside file-based managed settings, `managed-settings.json` is the base and `managed-settings.d/*.json` overlays it alphabetically; later drop-ins win.
- Merge behavior is mixed rather than simple overwrite: merged settings deep-merge objects and concat/dedupe arrays, while `updateSettingsForSource()` treats arrays as replacement when persisting one editable source.
- `--setting-sources` can narrow normal file scopes to `user`, `project`, and/or `local`, but `flagSettings` and `policySettings` are always included once settings are loaded. Main surfaces: `src/main.tsx`, `src/utils/settings/constants.ts`, `src/bootstrap/state.ts`.
- Env application intentionally differs from normal settings merge:
  - `src/utils/managedEnv.ts` applies global config env first
  - before trust is established, it applies all env vars only from trusted settings sources (`userSettings`, `flagSettings`, `policySettings`), then only SAFE_ENV_VARS from the fully merged settings
  - after trust is established, it applies global config env plus the fully merged settings env, including project/local env
  - session `/env` vars are separate again: `src/utils/sessionEnvVars.ts` stores them only for spawned child processes, not as part of the settings merge

## Domains With No Clear First-Class Home Yet

When a concern has no single owner, do not treat the first matching file as authoritative. Use the fallback inspection order below.

| Concern | Inspect in this order | Notes |
|---|---|---|
| Session/transcript persistence and recovery | `src/utils/sessionStorage.ts`, `src/utils/sessionStoragePortable.ts` -> `src/utils/conversationRecovery.ts`, `src/utils/sessionRestore.ts`, `src/utils/sessionStart.ts` -> `src/screens/REPL.tsx` -> `src/commands/resume/resume.tsx`, `src/screens/ResumeConversation.tsx`, `src/dialogLaunchers.tsx` -> `src/tools/AgentTool/resumeAgent.ts`, `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` -> `src/assistant/sessionHistory.ts`, `src/remote/RemoteSessionManager.ts`, `src/remote/SessionsWebSocket.ts` | Local transcript JSONL, resume UI, subagent state, and remote session recovery are separate surfaces. `src/history.ts` is prompt history, not transcript truth. |
| Prompt and policy behavior | `docs/prompts/2026-04-30-prompt-surfaces.md` -> `src/constants/prompts.ts` -> `src/context.ts` -> `src/utils/claudemd.ts` -> `src/utils/queryContext.ts` -> `src/QueryEngine.ts` | Start with the prompt index, then inspect base rules, auto-injected user/project context, and runtime replacement/append behavior. |
| Safety / review gates | `src/hooks/useCanUseTool.tsx` -> `src/utils/permissions/permissions.ts`, `src/utils/permissions/permissionSetup.ts` -> `src/utils/sandbox/sandbox-adapter.ts` -> `src/services/policyLimits/index.ts` -> `src/interactiveHelpers.tsx`, `src/components/TrustDialog/TrustDialog.tsx`, `src/services/mcpServerApproval.tsx` | Safety behavior is assembled from execution policy, sandboxing, org/admin limits, and approval UX. There is no single safety owner. |
| Identity / profile switching | `src/utils/auth.ts` -> `src/services/oauth/client.ts`, `src/services/oauth/getOauthProfile.ts` -> `src/commands/login/login.tsx` -> `src/utils/config.ts` | There does not appear to be a dedicated multi-profile surface. Treat this as auth flow plus persisted local account state. |
| Validation / testing | `package.json` -> `src/screens/Doctor.tsx` -> `src/utils/settings/validation.ts`, `src/utils/settings/allErrors.ts` -> feature-specific validation hooks if present | There is no conventional top-level test home in this repo snapshot. Start with runnable scripts and operator diagnostics. |
| Context collapse | `src/utils/queryContext.ts` -> `src/QueryEngine.ts` -> `src/services/contextCollapse/index.ts` | The named context-collapse module is not authoritative in this fork. Verify real call sites before changing collapse behavior. |
| Workspace / repo discovery | `src/utils/cwd.ts` -> `src/commands/add-dir/index.ts`, `src/commands/add-dir/validation.ts` -> `src/utils/detectRepository.ts` -> `src/utils/githubRepoPathMapping.ts` -> `src/utils/permissions/filesystem.ts` | Working directory, repo inference, add-dir behavior, and permission scope are separate concerns. |

- Use the persistence section above when the open question is scope or precedence rather than ownership.
- Avoid creating a fake central owner in docs or code unless the repo actually consolidates the behavior first.

## Fork-Specific Memo

- Compile-time feature gating is the first reality check: `scripts/build.ts` chooses bundled flags, while `src/entrypoints/cli.tsx`, `src/main.tsx`, `src/screens/REPL.tsx`, `src/commands.ts`, `src/tools.ts`, and `src/tasks.ts` all conditionally expose codepaths with `feature(...)`. Do not assume a file or command is live just because it exists in source.
- Prompt and policy surfaces are fork-modified, but not fully removed: `src/constants/prompts.ts` is still the main authoritative prompt surface, `src/constants/cyberRiskInstruction.ts` is intentionally blank in this fork, `src/context.ts` still injects git/`CLAUDE.md`/date context, and `src/utils/systemPrompt.ts` plus `src/utils/queryContext.ts` can replace or append the default prompt entirely.
- README-level claims are broader than runtime reality: `README.md` says telemetry is stripped and guardrails removed, but org/network controls still exist in `src/services/policyLimits/index.ts`, `src/services/remoteManagedSettings/index.ts`, and `src/services/remoteManagedSettings/securityCheck.tsx`. For agents, these are more authoritative than README copy when behavior conflicts.
- “No telemetry” does not mean “no feature/config service”: `src/services/analytics/index.ts`, `src/services/analytics/sink.ts`, and `src/services/analytics/firstPartyEventLogger.ts` are inert compatibility shells, but `src/services/analytics/growthbook.ts` still matters for cached/runtime gate values and feature-dependent behavior. Treat `src/services/analytics/` as mixed-authority, not uniformly dead.
- Some surfaces are present only as stubs and should not be treated as real product behavior: `src/services/contextCollapse/index.ts` is effectively a no-op implementation; `src/remote/remotePermissionBridge.ts` synthesizes minimal tool stubs for unknown remote tools; and several slash commands imported by `src/commands.ts` are explicit placeholders in `src/commands/break-cache/index.js`, `src/commands/ctx_viz/index.js`, `src/commands/issue/index.js`, `src/commands/onboarding/index.js`, `src/commands/share/index.js`, `src/commands/summary/index.js`, and `src/commands/teleport/index.js`.
- Internal-only or upstream-looking surfaces can mislead in this fork: `src/commands.ts` still imports many internal-only commands into `INTERNAL_ONLY_COMMANDS`, `src/entrypoints/cli.tsx` still contains feature-gated fast paths for internal capabilities, and `README.md` / feature docs should not be used as the source of truth for agent-visible behavior without checking the gated runtime paths above.

## Dedicated App Runtime Boundary Addendum

Use this addendum when working on the dedicated app refactor. The rest of this
workspace map still reflects the current terminal-first product, while the
dedicated app effort needs routing that does not send workers back into the
wrong shell.

| If you want to change or verify X | Inspect first | Then inspect | Notes |
|---|---|---|---|
| Shared dedicated-app runtime logic | `src/app-runtime/` | the minimal dedicated shell entry path outside root `web/` | If logic is reusable by the dedicated app, prefer the runtime boundary over shell-local code. |
| Dedicated app shell wiring | the minimal dedicated shell entry path outside root `web/` | `src/app-runtime/` | Keep the shell thin. Do not turn it into another copy of the runtime layer. |
| Terminal-only UI behavior | `src/screens/REPL.tsx` | Ink components and REPL-owned lifecycle files | This is the existing product shell, not the dedicated app target. Do not route replacement work here unless you are extracting code back out into `src/app-runtime/`. |
| Boundary validation | `src/app-runtime/` existence and imports | docs searches for stale root `web/` claims | A boundary is not real until the path exists, builds, and stays free of Ink/REPL coupling. |
| Dedicated app scaffold validation | `bun run validate:dedicated-app` | `bun run build:dedicated-app`, `bun run serve:dedicated-app` | The validator checks app-runtime and dedicated-shell import boundaries; the build script bundles the React shell scaffold and Bun host. |

Dedicated app rules of thumb:

- Do not start dedicated-app implementation from root `web/`.
- Do not treat `src/screens/REPL.tsx` as a reusable shell for the dedicated app.
- Do not mark roadmap phases complete because a shell prototype exists without
  the runtime boundary.
- Prefer moving shared behavior into `src/app-runtime/` before adding
  shell-specific logic.
- Treat live QueryEngine session bootstrap and final desktop/native packaging as
  follow-on work until they are explicitly wired and verified.

## What Not To Encode Here

- Do not encode low-level call chains or exact function sequences. They will drift faster than the routing surfaces.
- Do not assume every directory mentioned in top-level docs is active in this fork. Verify against source, especially feature-gated or stubbed areas.
- Do not treat this file as the source of truth for exact behavior. Use it to pick the first inspection surface, then confirm in code before changing policy or config behavior.
- Do not assume a concern has one owner just because it has one obvious file. Several important behaviors in this workspace are deliberately assembled across layers.
