# IDE and LSP Map

Last refreshed: 2026-05-12

## Purpose

Daily-refreshable routing map for IDE integration and Language Server Protocol
behavior. Use this to choose the first source files to inspect before changing
IDE connection, LSP lifecycle, diagnostics, passive feedback, LSP tool exposure,
plugin LSP config, UI prompts/status, or tests.

Verify behavior in source before editing. IDE and LSP paths are deliberately
best-effort: failures usually log, notify, or degrade to no attachment/tool
rather than blocking the main REPL.

## First Routes

| Area | Inspect first | Then inspect |
|---|---|---|
| IDE startup and auto-connect | `src/hooks/useIDEIntegration.tsx`, `src/utils/ide.ts` | `src/screens/REPL.tsx`, `src/commands/ide/ide.tsx`, `src/services/mcp/client.ts` |
| Manual `/ide` flow | `src/commands/ide/ide.tsx` | `src/commands/ide/index.ts`, `src/components/IdeAutoConnectDialog.tsx`, `src/utils/ide.ts` |
| IDE MCP transport and RPC | `src/services/mcp/client.ts`, `src/services/mcp/types.ts` | `src/utils/ide.ts`, `src/services/diagnosticTracking.ts`, `src/hooks/useDiffInIDE.ts` |
| IDE selection, mentions, logging | `src/hooks/useIdeSelection.ts`, `src/hooks/useIdeAtMentioned.ts`, `src/hooks/useIdeLogging.ts` | `src/utils/attachments.ts`, `src/components/PromptInput/PromptInput.tsx`, `src/components/IdeStatusIndicator.tsx` |
| IDE diff review | `src/hooks/useDiffInIDE.ts`, `src/components/permissions/FilePermissionDialog/ideDiffConfig.ts` | `src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx`, `src/components/ShowInIDEPrompt.tsx` |
| IDE diagnostics via extension | `src/services/diagnosticTracking.ts` | `src/utils/attachments.ts`, `src/components/DiagnosticsDisplay.tsx` |
| LSP manager lifecycle | `src/services/lsp/manager.ts`, `src/services/lsp/LSPServerManager.ts` | `src/services/lsp/LSPServerInstance.ts`, `src/services/lsp/LSPClient.ts`, `src/services/lsp/config.ts` |
| Passive LSP diagnostics | `src/services/lsp/passiveFeedback.ts`, `src/services/lsp/LSPDiagnosticRegistry.ts` | `src/utils/attachments.ts`, `src/components/DiagnosticsDisplay.tsx` |
| LSP tool exposure | `src/tools/LSPTool/LSPTool.ts`, `src/tools.ts` | `src/tools/LSPTool/schemas.ts`, `src/tools/LSPTool/formatters.ts`, `src/tools/LSPTool/UI.tsx`, `src/services/api/claude.ts` |
| Plugin LSP config | `src/utils/plugins/lspPluginIntegration.ts`, `src/utils/plugins/schemas.ts` | `src/services/lsp/config.ts`, `src/utils/plugins/pluginLoader.ts`, `src/hooks/useManagePlugins.ts` |
| LSP plugin recommendations | `src/hooks/useLspPluginRecommendation.tsx`, `src/utils/plugins/lspRecommendation.ts` | `src/components/LspRecommendation/LspRecommendationMenu.tsx`, `src/hooks/usePluginRecommendationBase.tsx`, `src/bootstrap/state.ts` |
| IDE/LSP status UI | `src/hooks/notifs/useIDEStatusIndicator.tsx`, `src/hooks/notifs/useLspInitializationNotification.tsx` | `src/components/IdeOnboardingDialog.tsx`, `src/components/IdeStatusIndicator.tsx`, `src/screens/REPL.tsx` |

## Startup Flow

- `src/main.tsx` calls `initializeLspServerManager()` after trust is
  established and after inline plugins are set. This is the guard that prevents
  plugin LSP server commands from executing in untrusted directories.
- `src/services/lsp/manager.ts` owns the singleton state:
  `not-started`, `pending`, `success`, `failed`. It skips bare mode, initializes
  asynchronously, registers passive diagnostics after successful init, and
  exposes `reinitializeLspServerManager()` for plugin refreshes.
- `src/hooks/useManagePlugins.ts` defensively reinitializes the LSP manager
  after plugin load/refresh so newly available plugin LSP configs are picked up.
- `src/screens/REPL.tsx` mounts IDE and LSP hooks: IDE auto-connect, IDE status,
  LSP error polling, and LSP plugin recommendations.

## IDE Routing

- IDE detection and connection metadata live in `src/utils/ide.ts`. Lockfiles
  under the Claude config `ide` directory provide workspace folders, port,
  IDE name, transport (`sse` or `ws`), Windows/WSL state, and optional auth
  token.
- `useIDEIntegration()` calls `initializeIdeIntegration()`, then adds a dynamic
  MCP config named `ide` when auto-connect is allowed by global config, `--ide`,
  supported IDE terminal detection, `CLAUDE_CODE_SSE_PORT`, install intent, or
  `CLAUDE_CODE_AUTO_CONNECT_IDE`.
- `/ide` in `src/commands/ide/ide.tsx` is the manual route. It detects valid
  and invalid IDE lockfiles, connects by writing `dynamicMcpConfig.ide`, removes
  the IDE client and cached transport on disconnect, and has an `open` mode for
  opening the current project or worktree.
- `src/services/mcp/client.ts` treats `sse-ide` and `ws-ide` as internal IDE
  transports. Only `mcp__ide__executeCode` and `mcp__ide__getDiagnostics` are
  exposed as regular MCP tools, but local code can call any IDE RPC directly
  through `callIdeRpc()`.
- Path translation for Windows IDE plus WSL CLI lives in
  `src/utils/idePathConversion.ts`.

## IDE Feedback

- `src/hooks/useIdeSelection.ts` listens for `selection_changed` notifications
  and stores selected text/file context in REPL state.
- `src/hooks/useIdeAtMentioned.ts` listens for `at_mentioned` notifications and
  converts IDE 0-based lines to 1-based prompt references.
- `src/hooks/useIdeLogging.ts` forwards IDE `log_event` notifications to
  analytics with the `tengu_ide_` prefix.
- `src/utils/attachments.ts` turns IDE selection and opened-file state into
  main-thread attachments only.
- `src/hooks/useDiffInIDE.ts` opens edit diffs with IDE RPC `openDiff`, waits
  for save/close/reject outcomes, recomputes edits from IDE-modified contents,
  and cleans up tabs with `close_tab`/`closeAllDiffTabs`.

## Diagnostics

- IDE extension diagnostics are tracked by
  `src/services/diagnosticTracking.ts`. The REPL calls
  `diagnosticTracker.handleQueryStart()` at the start of each real query,
  capturing/resetting baselines from the connected IDE client.
- `getDiagnosticAttachments()` in `src/utils/attachments.ts` asks the IDE
  diagnostics tracker for new diagnostics and only emits attachments when Bash
  is available so the model can act on them.
- Passive LSP diagnostics are separate from IDE diagnostics:
  `src/services/lsp/passiveFeedback.ts` registers
  `textDocument/publishDiagnostics` handlers on every configured LSP server and
  converts LSP severities/URIs into the shared diagnostic attachment shape.
- `src/services/lsp/LSPDiagnosticRegistry.ts` deduplicates diagnostics within a
  batch and across turns, limits volume to 10 diagnostics per file and 30 total,
  and clears pending entries after attachment delivery.
- `src/components/DiagnosticsDisplay.tsx` renders both IDE and LSP diagnostic
  attachments.

## LSP Lifecycle

- `src/services/lsp/config.ts` loads LSP servers only from enabled plugins via
  `loadAllPluginsCacheOnly()` and `getPluginLspServers()`. There is no
  user/project settings route for LSP servers.
- `src/services/lsp/LSPServerManager.ts` maps file extensions from
  `extensionToLanguage` to server names, creates server instances, lazy-starts
  the first matching server for a file, and sends `didOpen`, `didChange`,
  `didSave`, and `didClose` notifications.
- `src/services/lsp/LSPServerInstance.ts` owns per-server state and health:
  `stopped`, `starting`, `running`, `stopping`, `error`. It initializes with
  workspace folders, root URI/path, text-document capabilities, diagnostics,
  hover, definition, references, document symbols, and call hierarchy support.
- `src/services/lsp/LSPClient.ts` is the stdio JSON-RPC wrapper. It spawns the
  plugin command, wires message readers/writers, queues notification/request
  handlers before connection, traces protocol messages for debugging, and
  handles process/connection crashes.

## LSP Tool

- `src/tools.ts` includes `LSPTool` only when `ENABLE_LSP_TOOL` is truthy.
- `src/tools/LSPTool/LSPTool.ts` marks the tool as `isLsp`, `shouldDefer`,
  read-only, concurrency-safe, permission-gated by normal read permissions, and
  enabled only when `isLspConnected()` sees at least one non-error server.
- `src/services/api/claude.ts` sends LSP tool schemas with `defer_loading` when
  tool search is active and LSP initialization is `pending` or `not-started`.
- Supported operations are defined in `src/tools/LSPTool/schemas.ts`:
  go-to-definition, references, hover, document symbols, workspace symbols,
  implementation, prepare call hierarchy, incoming calls, and outgoing calls.
- `LSPTool.call()` waits for pending initialization, opens the target file on
  the matching LSP server when needed, enforces a 10 MB read cap, sends the
  LSP request, filters gitignored location results, formats responses, and
  returns user-visible errors as tool data instead of throwing.

## Plugin LSP

- LSP config schema is in `src/utils/plugins/schemas.ts`. A plugin can declare
  `lspServers` inline, as a relative JSON path, as an array of both, or through
  a root `.lsp.json`.
- `src/utils/plugins/lspPluginIntegration.ts` validates relative paths stay
  within the plugin directory, validates configs with `LspServerConfigSchema`,
  resolves `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
  `${user_config.KEY}`, and environment variables, and scopes server names as
  `plugin:<pluginName>:<serverName>`.
- `src/utils/plugins/lspRecommendation.ts` scans installed marketplaces for
  inline `lspServers`, matches by file extension, requires the LSP command
  binary to exist locally, skips installed or never-suggested plugins, and
  sorts official marketplace plugins first.
- `src/hooks/useLspPluginRecommendation.tsx` watches tracked file history,
  shows at most one recommendation per session, installs accepted plugins into
  user settings, tracks ignored/never/disable responses in global config, and
  uses `LspRecommendationMenu` for the prompt.

## UI Status

- `src/hooks/notifs/useIDEStatusIndicator.tsx` owns IDE hint, disconnected,
  JetBrains plugin, and install-error notifications. It suppresses these in
  remote mode.
- `src/components/IdeStatusIndicator.tsx` shows current selected lines or
  opened file in the prompt footer when an IDE is connected.
- `src/components/IdeOnboardingDialog.tsx` is shown after successful supported
  IDE install/connection paths and records per-terminal display state in global
  config.
- `src/hooks/notifs/useLspInitializationNotification.tsx` polls LSP manager and
  server errors every 5 seconds, adds `/plugin`-routed notifications, and mirrors
  LSP errors into `appState.plugins.errors`.
- `src/screens/REPL.tsx` places IDE onboarding above lower-priority suggestions;
  LSP recommendation is a low-priority non-blocking dialog near plugin hints.

## Tests And Validation

- No dedicated IDE/LSP test files were found in the current tree by filename or
  `describe/test/it` search. Add focused tests near the changed owner when
  modifying behavior.
- For LSP lifecycle or diagnostics changes, start with unit coverage around
  `src/services/lsp/manager.ts`, `src/services/lsp/LSPServerManager.ts`,
  `src/services/lsp/LSPServerInstance.ts`, `src/services/lsp/passiveFeedback.ts`,
  and `src/services/lsp/LSPDiagnosticRegistry.ts`.
- For LSP tool changes, cover schema validation, permission/read failure paths,
  method mapping, formatting, gitignored filtering, and pending initialization in
  `src/tools/LSPTool/`.
- For plugin LSP changes, cover manifest formats, `.lsp.json`, path traversal
  rejection, environment/user-config substitution, and scoped names in
  `src/utils/plugins/lspPluginIntegration.ts`.
- For IDE changes, cover detection/lockfile parsing, dynamic MCP config updates,
  WSL path conversion, and direct IDE RPC call sites. UI changes should include
  focused component/hook tests or an interactive REPL verification path.
- For docs-only refreshes, run `git diff --check` and verify referenced paths
  still exist.

## Maintenance Rules

- Keep this map route-oriented. Do not add long call-chain walkthroughs,
  historical plans, or issue narratives.
- Prefer current source over this map when they disagree, then refresh the map.
- Keep ownership boundaries clear: IDE MCP transport is not LSP; IDE diagnostics
  from the extension are not passive LSP diagnostics; plugin LSP config is the
  only LSP server configuration route.
