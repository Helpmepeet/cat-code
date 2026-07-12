# Plugins, Skills, and Commands Map

Last refreshed: 2026-06-16

## Purpose

Daily-refreshable routing map for slash command exposure, dynamic command
sources, skills, plugins, plugin-provided components, marketplace flows, and
validation. Use this before changing command visibility, Skill tool indexing,
plugin loading, marketplace install/update behavior, or plugin component
validation.

Verify behavior in source before editing. Plugin and skill routing is heavily
memoized and several surfaces load lazily or only under feature flags.

## Slash Command Exposure

| Question | Inspect first | Then inspect |
|---|---|---|
| Which slash commands exist? | `src/commands.ts` | `src/commands/`, `src/types/command.ts` |
| Why is a command visible or hidden? | `src/commands.ts` `getCommands`, `meetsAvailabilityRequirement` | `src/types/command.ts` `isCommandEnabled`, command `isEnabled` callbacks |
| Why is a command unavailable in remote/bridge mode? | `src/commands.ts` `REMOTE_SAFE_COMMANDS`, `BRIDGE_SAFE_COMMANDS`, `isBridgeSafeCommand` | `src/main.tsx`, `src/screens/REPL.tsx` |
| How is command source shown in UI? | `src/commands.ts` `formatDescriptionWithSource` | `src/components/`, help/typeahead owners |
| How do `/init` and `/init-verifiers` scaffold repo-local instructions? | `src/commands/init.ts`, `src/commands/init-verifiers.ts` | `src/skills/loadSkillsDir.ts`, `src/utils/claudemd.ts`, `src/utils/settings/settings.ts` |
| How does `/plugin` expose plugin management? | `src/commands/plugin/index.tsx`, `src/commands/plugin/plugin.tsx` | `src/commands/plugin/PluginSettings.tsx`, `src/commands/plugin/ManagePlugins.tsx`, `src/commands/plugin/parseArgs.ts` |
| How do non-interactive `cat-code plugin ...` subcommands work? | `src/main.tsx` plugin commander registration | `src/cli/handlers/plugins.ts`, `src/services/plugins/pluginCliCommands.ts` |

`src/commands.ts` is the aggregation owner. Static built-ins live in
`COMMANDS()`, while feature-gated built-ins are required lazily through
`feature(...)`. The effective load order in `loadAllCommands(cwd)` is:

1. bundled skills
2. built-in-plugin skills
3. filesystem skills from `.cat-code/skills` plus legacy commands compatibility
4. workflow commands when `WORKFLOW_SCRIPTS` is enabled
5. plugin commands
6. plugin skills
7. hardcoded built-in commands

`getCommands(cwd)` then applies availability and `isEnabled` filters. Dynamic
skills discovered later in the session are deduped and inserted before built-in
commands, so they behave like late-arriving non-built-in prompt commands.

`CommandAvailability` now includes `openai` for Codex/OpenAI sessions.
`meetsAvailabilityRequirement()` is the durable owner for provider-specific
command visibility, including shared commands such as `/fast`.

`/init` and `/init-verifiers` now steer users toward `.cat-code/skills`,
`.cat-code/rules`, `.cat-code/settings*.json`, and `~/.cat-code/...`
instruction imports. Keep legacy `.claude` mentions only where the loader still
supports compatibility reads.

## Skill and Model-Invocable Command Indexes

| Surface | Owner | Notes |
|---|---|---|
| User-visible `/skills` menu | `src/commands/skills/index.ts`, `src/commands/skills/skills.tsx` | Renders `SkillsMenu` from `context.options.commands`. |
| Model Skill tool command list | `src/commands.ts` `getSkillToolCommands` | Prompt commands, not hidden from model invocation, non-builtin. Bundled, filesystem, and legacy commands are included with fallback descriptions; plugin/MCP commands require description or `when_to_use`. |
| SlashCommand tool skill list | `src/commands.ts` `getSlashCommandToolSkills` | Prompt commands with description or `when_to_use`, loaded from `skills`, `plugin`, or `bundled`, plus commands with `disableModelInvocation`. |
| MCP-provided skills | `src/commands.ts` `getMcpSkillCommands` | Separate from `getCommands()`. Enabled only by `MCP_SKILLS`; filters AppState MCP commands to prompt, `loadedFrom: 'mcp'`, and model-invocable. |
| MCP skill command construction | `src/skills/mcpSkillBuilders.ts`, `src/skills/loadSkillsDir.ts` | `loadSkillsDir.ts` registers builders for MCP skill discovery without import cycles. |

## Filesystem Skills

| Source | Owner | Behavior |
|---|---|---|
| Managed skills | `src/skills/loadSkillsDir.ts` | Loads `${managed}/.cat-code/skills` unless disabled by `CLAUDE_CODE_DISABLE_POLICY_SKILLS`. |
| User skills | `src/skills/loadSkillsDir.ts` | Loads `$CLAUDE_CONFIG_DIR/skills` (now the primary `~/.cat-code/skills` home location). |
| Project skills | `src/skills/loadSkillsDir.ts` | Walks project dirs up to home via `getProjectDirsUpToHome('skills', cwd)`. |
| `--add-dir` project skills | `src/skills/loadSkillsDir.ts` | Loads `<add-dir>/.cat-code/skills` when project settings are enabled. |
| Legacy commands-as-skills | `src/skills/loadSkillsDir.ts` | Loads `.claude/commands` markdown and `SKILL.md` directories as `loadedFrom: 'commands_DEPRECATED'`. |
| Conditional/dynamic skills | `src/skills/loadSkillsDir.ts` | `paths` frontmatter stores conditional skills; file operations can activate them. Nested `.cat-code/skills` dirs can be discovered dynamically below cwd, excluding gitignored dirs. |

Filesystem skills support only `skill-name/SKILL.md` in `/skills/` dirs.
Legacy `/commands/` supports both single `.md` files and directories with
`SKILL.md`. Shared frontmatter parsing lives in
`parseSkillFrontmatterFields`: `description`, `allowed-tools`,
`argument-hint`, `arguments`, `when_to_use`, `version`, `model`, `effort`,
`disable-model-invocation`, `user-invocable`, `hooks`, `context: fork`,
`agent`, `paths`, and `shell`.

On invocation, `createSkillCommand` prepends a base directory for disk-backed
skills, substitutes arguments, expands `${CLAUDE_SKILL_DIR}` and
`${CLAUDE_SESSION_ID}`, and executes prompt shell blocks except for MCP skills.

## Bundled and Built-In Plugin Skills

| Surface | Owner | Notes |
|---|---|---|
| Bundled skill registry | `src/skills/bundledSkills.ts` | `registerBundledSkill()` creates prompt commands with `source: 'bundled'` and `loadedFrom: 'bundled'`. |
| Bundled skill initialization | `src/skills/bundled/index.ts` | Add bundled skill modules here; feature-gated skills are registered conditionally. |
| Built-in plugin registry | `src/plugins/builtinPlugins.ts` | User-toggleable plugins that ship with the CLI. Skills are converted to bundled-source commands so they remain model-visible. |
| Built-in plugin initialization | `src/plugins/bundled/index.ts` | Scaffolding for registering built-in plugins; no built-in plugins are currently registered here. |

Use bundled skills for always-available compiled capabilities. Use built-in
plugins for features that should appear in `/plugin` and be user-toggleable.

## Plugin Loading and Component Detection

| Question | Inspect first | Then inspect |
|---|---|---|
| How are enabled/disabled plugins discovered? | `src/utils/plugins/pluginLoader.ts` | `src/utils/plugins/installedPluginsManager.ts`, `src/utils/plugins/pluginStartupCheck.ts` |
| What does `plugin.json` allow? | `src/utils/plugins/schemas.ts` `PluginManifestSchema` | `src/utils/plugins/pluginLoader.ts` |
| How are plugin cache paths/version paths chosen? | `src/utils/plugins/pluginLoader.ts`, `src/utils/plugins/pluginVersioning.ts` | `src/utils/plugins/zipCache.ts`, `src/utils/plugins/cacheUtils.ts` |
| How are plugin settings/options stored? | `src/utils/plugins/pluginOptionsStorage.ts` | `src/utils/plugins/mcpbHandler.ts`, `src/services/plugins/pluginOperations.ts` |
| What happens on `/reload-plugins`? | `src/utils/plugins/refresh.ts` | `src/commands/reload-plugins/`, `src/screens/REPL.tsx` |

`createPluginFromPath()` in `pluginLoader.ts` owns component detection for a
loaded plugin. Standard component directories are auto-detected only when the
manifest does not specify that component:

| Component | Standard path | Manifest field | Loaded into `LoadedPlugin` |
|---|---|---|---|
| Commands | `commands/` | `commands` | `commandsPath`, `commandsPaths`, `commandsMetadata` |
| Agents | `agents/` | `agents` | `agentsPath`, `agentsPaths` |
| Skills | `skills/` | `skills` | `skillsPath`, `skillsPaths` |
| Output styles | `output-styles/` | `outputStyles` | `outputStylesPath`, `outputStylesPaths` |
| Hooks | `hooks/hooks.json` | `hooks` | `hooksConfig` |
| MCP servers | `.mcp.json` | `mcpServers`, `channels`, `userConfig` | Loaded lazily by MCP integration |
| LSP servers | `.lsp.json` | `lspServers`, `userConfig` | Loaded lazily by LSP integration |

Manifest component paths must be plugin-relative and are checked before being
stored. Missing files produce plugin errors but do not necessarily prevent the
plugin object from loading.

## Plugin-Provided Commands and Skills

| Surface | Owner | Behavior |
|---|---|---|
| Plugin commands | `src/utils/plugins/loadPluginCommands.ts` `getPluginCommands` | Loads enabled plugin `commandsPath`, `commandsPaths`, and inline `commandsMetadata`. Names are `plugin:namespace:file`. |
| Plugin skills | `src/utils/plugins/loadPluginCommands.ts` `getPluginSkills` | Loads enabled plugin `skillsPath` and `skillsPaths`. Names are `plugin:skill`. Direct skill dirs and child `SKILL.md` dirs are both supported. |
| Plugin command markdown walk | `src/utils/plugins/walkPluginMarkdown.ts` | Used by command/output-style loaders; commands stop at skill dirs. |
| Plugin command frontmatter | `src/utils/plugins/loadPluginCommands.ts` `createPluginCommand` | Supports descriptions, allowed tools, arguments, `when_to_use`, model, effort, shell, `user-invocable`, and plugin/user-config substitutions. |

Plugin commands and skills are prompt commands with `source: 'plugin'`.
Plugin skills set `loadedFrom: 'plugin'`, get progress message `loading`, and
include `Base directory for this skill: ...` on invocation. Both commands and
skills substitute `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
`${CLAUDE_SESSION_ID}`, and non-sensitive `${user_config.KEY}` values. Plugin
skills also substitute `${CLAUDE_SKILL_DIR}`.

In `--bare` mode, marketplace plugin auto-load is skipped unless explicit
session plugins are passed with `--plugin-dir`.

## Plugin Hooks

| Surface | Owner | Notes |
|---|---|---|
| Hook file parsing | `src/utils/plugins/pluginLoader.ts` `loadPluginHooks` helper | Loads standard `hooks/hooks.json` and manifest `hooks`, merging and detecting duplicate hook files. |
| Hook registration | `src/utils/plugins/loadPluginHooks.ts` | Converts plugin hooks to native hook matchers with `pluginRoot`, `pluginName`, and `pluginId`, then registers them in bootstrap state. |
| Hook hot reload | `src/utils/plugins/loadPluginHooks.ts` | Watches plugin-affecting settings changes and reloads hooks after cache clear. |
| Removed-plugin pruning | `src/utils/plugins/loadPluginHooks.ts` `pruneRemovedPluginHooks` | Removes disabled/uninstalled plugin hooks immediately while preserving existing callback hooks. |

`loadPluginHooks()` does the atomic clear-and-register swap. Cache clearing
alone must not wipe registered hooks because some hook events may never trigger
a later full reload.

## Plugin Output Styles

| Surface | Owner | Notes |
|---|---|---|
| Filesystem output styles | `src/outputStyles/loadOutputStylesDir.ts` | Loads `.claude/output-styles/*.md` from managed/user/project sources. |
| Plugin output styles | `src/utils/plugins/loadPluginOutputStyles.ts` | Loads enabled plugin `outputStylesPath` and `outputStylesPaths`; namespaced as `plugin:style`. |
| Style merge and selection | `src/constants/outputStyles.ts` | Merges built-ins, plugin, user, project, managed styles. Plugin styles can set `force-for-plugin`. |

Plugin output styles support `name`, `description`, and `force-for-plugin`.
Non-plugin output styles ignore `force-for-plugin` and can use
`keep-coding-instructions`.

## Plugin MCP Integration

| Surface | Owner | Notes |
|---|---|---|
| Load plugin MCP servers | `src/utils/plugins/mcpPluginIntegration.ts` `loadPluginMcpServers` | Reads `.mcp.json`, manifest `mcpServers`, JSON files, inline configs, and MCPB/DXT bundles. Manifest entries override default `.mcp.json`. |
| Scope server names | `src/utils/plugins/mcpPluginIntegration.ts` `addPluginScopeToServers` | Server names become `plugin:<pluginName>:<serverName>` with dynamic scope and plugin source. |
| Resolve env/config | `src/utils/plugins/mcpPluginIntegration.ts` `resolvePluginMcpEnvironment` | Substitutes plugin vars, optional user config, and environment vars; adds `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` for stdio servers. |
| Channel config prompts | `src/utils/plugins/mcpPluginIntegration.ts` `getUnconfiguredChannels` | Finds manifest `channels` whose required per-server user config is missing. |
| MCPB storage/config | `src/utils/plugins/mcpbHandler.ts` | Handles MCP bundle extraction and per-server user config storage. |

Top-level `manifest.userConfig` feeds MCP `${user_config.KEY}` substitution.
Channel-specific `channels[].userConfig` is stored per server and wins on key
collision for that server.

## Plugin LSP Integration

| Surface | Owner | Notes |
|---|---|---|
| Load plugin LSP servers | `src/utils/plugins/lspPluginIntegration.ts` `loadPluginLspServers` | Reads `.lsp.json` and manifest `lspServers`; manifest entries merge over defaults. |
| Validate LSP config | `src/utils/plugins/schemas.ts` `LspServerConfigSchema` | Requires command and extension-to-language mappings; validates command shape and transport fields. |
| Scope server names | `src/utils/plugins/lspPluginIntegration.ts` `addPluginScopeToLspServers` | Server names become `plugin:<pluginName>:<serverName>` with dynamic scope. |
| Apply to running session | `src/utils/plugins/refresh.ts`, `src/services/lsp/manager.ts` | `/reload-plugins` reloads plugin LSP config and reinitializes the LSP manager. |
| Recommendations | `src/utils/plugins/lspRecommendation.ts` | Reads inline marketplace LSP metadata only; string-path configs are not readable from marketplace listings. |

LSP config path declarations are validated to stay inside the plugin directory.
Top-level `manifest.userConfig` can feed `${user_config.KEY}` substitution in
LSP command, args, env, and workspace folder.

## Marketplace, Install, and Update Flows

| Flow | Inspect first | Then inspect |
|---|---|---|
| Declared marketplace intent | `src/utils/plugins/marketplaceManager.ts` `getDeclaredMarketplaces` | settings files, `src/utils/plugins/addDirPluginSettings.ts` |
| Materialized marketplace state | `src/utils/plugins/marketplaceManager.ts` | `~/.claude/plugins/known_marketplaces.json`, marketplace cache paths |
| Startup reconciliation | `src/utils/plugins/reconciler.ts` | `src/services/plugins/PluginInstallationManager.ts`, `src/utils/plugins/headlessPluginInstall.ts` |
| Interactive `/plugin marketplace ...` | `src/commands/plugin/ManageMarketplaces.tsx`, `src/commands/plugin/AddMarketplace.tsx` | `src/utils/plugins/marketplaceManager.ts`, `src/utils/plugins/parseMarketplaceInput.ts` |
| CLI marketplace subcommands | `src/main.tsx` plugin commander block | `src/cli/handlers/plugins.ts` |
| Install/enable/disable/uninstall/update core | `src/services/plugins/pluginOperations.ts` | `src/utils/plugins/pluginInstallationHelpers.ts` |
| Background autoupdate | `src/utils/plugins/pluginAutoupdate.ts` | `src/utils/plugins/schemas.ts` `isMarketplaceAutoUpdate`, `src/commands/plugin/ManageMarketplaces.tsx` |
| Active component refresh | `src/utils/plugins/refresh.ts` | `/reload-plugins`, `src/screens/REPL.tsx`, headless refresh call sites |

The durable model is three layers:

1. Intent: settings such as `enabledPlugins` and `extraKnownMarketplaces`.
2. Materialization: marketplace and plugin cache under the plugins directory.
3. Active session: AppState commands/agents/errors, registered hooks, MCP
   reconnect key, and LSP manager config.

Install is settings-first. `installResolvedPlugin()` resolves dependency
closure, writes all enabled plugin IDs to settings in one update, then caches
each plugin/version and records installation metadata. `/reload-plugins` is
the explicit active-session swap for commands, agents, hooks, MCP, and LSP.
New marketplace installs during startup can auto-refresh active plugins; updates
usually set `needsRefresh` or require restart depending on the path.

## Tests And Validation

| Validation target | Owner | Notes |
|---|---|---|
| Runtime schema | `src/utils/plugins/schemas.ts` | Runtime load path is generally lenient and strips unknown manifest keys. |
| `/plugin validate` UI | `src/commands/plugin/ValidatePlugin.tsx` | Runs manifest validation from the interactive slash command path. |
| CLI `plugin validate` | `src/main.tsx`, `src/cli/handlers/plugins.ts` | Also validates plugin content files when validating a plugin manifest in `.claude-plugin`. |
| Manifest validation | `src/utils/plugins/validatePlugin.ts` | Strict schemas for author feedback, path traversal checks, marketplace-only field warnings. |
| Component validation | `src/utils/plugins/validatePlugin.ts` `validatePluginContents` | Checks skills, agents, commands, and hooks frontmatter/content warnings. |

Use `validateManifest()` for a file or directory. Directory validation prefers
`.claude-plugin/marketplace.json` over `.claude-plugin/plugin.json`. CLI
validation additionally calls `validatePluginContents()` for plugin manifests,
covering component markdown and `hooks/hooks.json`.

## Workflow Commands and Tool Routing

Workflow support is feature-gated by `WORKFLOW_SCRIPTS`.

| Surface | Owner | Notes |
|---|---|---|
| Workflow slash command aggregation | `src/commands.ts` `getWorkflowCommands` import | If enabled, imports the feature-gated WorkflowTool command factory and inserts workflow commands before plugin commands. |
| Workflow tool exposure | `src/tools.ts` | If enabled, initializes bundled workflows and exposes `WorkflowTool`. |
| Tool name/permissions | `src/tools/WorkflowTool/constants.ts`, `src/constants/tools.ts`, `src/utils/permissions/classifierDecision.ts` | Tool name is `Workflow`; permission UI special-cases workflow requests. |

In this snapshot, only `src/tools/WorkflowTool/constants.ts` is present under
`src/tools/WorkflowTool/`; the feature-gated implementation modules are lazy
imports and may be generated, omitted, or present only in other builds. Treat
workflow behavior as feature/build dependent and verify the actual artifact
before changing workflow command/tool behavior.

## Cache and Refresh Checklist

When changing routing or component loaders, check the corresponding cache clear:

| Cache/refresh surface | Owner |
|---|---|
| All command caches | `src/commands.ts` `clearCommandsCache`, `clearCommandMemoizationCaches` |
| Skill directory caches | `src/skills/loadSkillsDir.ts` `clearSkillCaches` |
| Plugin command/skill caches | `src/utils/plugins/loadPluginCommands.ts` |
| Plugin output style cache | `src/utils/plugins/loadPluginOutputStyles.ts` |
| Output style aggregate cache | `src/constants/outputStyles.ts`, `src/outputStyles/loadOutputStylesDir.ts` |
| Plugin load/cache state | `src/utils/plugins/pluginLoader.ts`, `src/utils/plugins/cacheUtils.ts` |
| Active plugin session state | `src/utils/plugins/refresh.ts` |
| Marketplace cache | `src/utils/plugins/marketplaceManager.ts` |

For docs-only edits to this map, run `git diff --check` and a focused link/path
check for referenced files.
