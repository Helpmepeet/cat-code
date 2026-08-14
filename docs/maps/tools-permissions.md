# Tools And Permissions Map

Last refreshed: 2026-08-14 against the current source tree.

## Purpose

Daily-refreshable routing map for tool registration, MCP-backed tool exposure,
permission policy, sandboxing, execution orchestration, tool search, and input
validation in Cat Code.

Use this file to choose the first implementation surfaces to inspect before
changing tool availability or tool-safety behavior. This is a routing map, not
the behavioral source of truth. Verify current code paths before editing.

## First Files To Inspect

Read in this order for most tool, MCP, or permission work:

| Order | File | Why first |
|---|---|---|
| 1 | [`WORKSPACE_MAP.md`](WORKSPACE_MAP.md) | Current map index and sub-map routing. |
| 2 | [`../../src/tools.ts`](../../src/tools.ts) | Built-in tool registry, feature-gated exposure, deny-rule filtering, and merged tool-pool assembly. |
| 3 | [`../../src/constants/tools.ts`](../../src/constants/tools.ts) | Base tool-name constants and shared allowlists (ex: async agent base tools). |
| 4 | [`../../src/Tool.ts`](../../src/Tool.ts) | Core `Tool` contract, tool defaults, schema hooks, validation hooks, and name matching. |
| 5 | [`../../src/hooks/useCanUseTool.tsx`](../../src/hooks/useCanUseTool.tsx) | Interactive approval flow and decision handoff into UI, classifier, and worker-specific handlers. |
| 6 | [`../../src/utils/permissions/permissions.ts`](../../src/utils/permissions/permissions.ts) | Main allow / ask / deny engine, rule precedence, auto-mode classifier path, and permission updates. |
| 7 | [`../../src/utils/permissions/permissionSetup.ts`](../../src/utils/permissions/permissionSetup.ts) | Permission-context construction, mode transitions, dangerous-rule stripping, and working-directory setup. |
| 8 | [`../../src/utils/permissions/filesystem.ts`](../../src/utils/permissions/filesystem.ts) | Path matching, dangerous-file checks, internal path exceptions, and file permission suggestions. |
| 9 | [`../../src/utils/permissions/pathValidation.ts`](../../src/utils/permissions/pathValidation.ts) | Shared path allow/deny logic used by file operations and shell path validation. |
| 10 | [`../../src/services/tools/toolExecution.ts`](../../src/services/tools/toolExecution.ts) | Per-tool execution loop, input validation, hook integration, telemetry, and result shaping. |
| 11 | [`../../src/services/tools/toolOrchestration.ts`](../../src/services/tools/toolOrchestration.ts) | Serial vs concurrent batching and context mutation ordering. |
| 12 | [`../../src/services/tools/StreamingToolExecutor.ts`](../../src/services/tools/StreamingToolExecutor.ts) | Streaming-time execution, concurrency gates, and sibling cancellation behavior. |
| 13 | [`../../src/services/mcp/client.ts`](../../src/services/mcp/client.ts) | MCP connection lifecycle, MCP tool wrapping, resource exposure, and result transformation. |
| 14 | [`../../src/services/mcp/config.ts`](../../src/services/mcp/config.ts) | MCP config layering, deduplication, validation, and scope rules. |
| 15 | [`../../src/utils/toolSearch.ts`](../../src/utils/toolSearch.ts) | Deferred-tool policy, tool-search gating, and threshold logic. |
| 16 | [`../../src/utils/teammateMailbox.ts`](../../src/utils/teammateMailbox.ts) | Separate authority boundary for Agent Teams mailbox controls — closed control union, runtime principals, request correlation. See "Agent Teams Mailbox Control Authority" below. |

## Current Mental Model

The live tool system is assembled in layers:

1. `src/tools.ts` declares the built-in tool pool and feature-gated tool
   exposure.
2. `src/services/mcp/client.ts` converts connected MCP server tools into live
   `Tool` objects and exposes MCP resources and auth helpers.
3. `src/tools.ts` merges built-in and MCP tools into the prompt-visible tool
   pool, applying blanket deny rules before the model sees tools.
4. `src/services/tools/toolExecution.ts` validates input, runs hooks, requests
   permission decisions, executes the tool, and normalizes results.
5. `src/hooks/useCanUseTool.tsx` and `src/utils/permissions/permissions.ts`
   decide whether a tool call is allowed, denied, or requires user approval.
6. `src/utils/permissions/filesystem.ts`,
   `src/utils/permissions/pathValidation.ts`, and
   `src/utils/sandbox/sandbox-adapter.ts` enforce path and sandbox boundaries.
7. `src/utils/toolSearch.ts` can defer MCP tools and selected built-in tools so
   the model discovers them through `ToolSearchTool` instead of receiving every
   schema inline.

## Routing Table

| Concern | Start here | Then inspect | Notes |
|---|---|---|---|
| Built-in tool registration | `src/tools.ts` | `src/tools/`, `src/Tool.ts`, `src/constants/tools.ts`, `src/commands.ts` | `getAllBaseTools()` is the source of truth for built-ins that exist in the current runtime. Many tools are feature-gated or env-gated at import time. Base tool-name constants and shared allowlists live in `src/constants/tools.ts`. |
| Tool contract and defaults | `src/Tool.ts` | tool implementation file, `src/utils/api.ts` | Start here when changing what every tool can declare: schemas, concurrency, permission hooks, prompt text, deferred loading, result rendering, or MCP metadata. |
| Tool pool visible to the model | `src/tools.ts` | `src/services/mcp/client.ts`, `src/utils/toolSearch.ts` | `getTools()`, `assembleToolPool()`, and `getMergedTools()` are the main assembly points. Blanket deny rules can remove tools before prompt exposure. |
| Interactive permission prompts | `src/hooks/useCanUseTool.tsx` | `src/hooks/toolPermission/`, `src/components/permissions/PermissionRequest.tsx` | This is the main UI-side approval path. It handles config allows, config denies, coordinator waits, swarm-worker behavior, classifier shortcuts, and interactive prompt display. |
| Bridge-mediated approvals | `src/hooks/useCanUseTool.tsx` | `src/bridge/mergeBridgePermissionCallbacks.ts`, `src/hooks/usePtcloveBridge.ts`, `src/hooks/useReplBridge.tsx` | Approval prompts can be mirrored to both REPL bridge and ptclove bridge callbacks before the local dialog resolves. |
| Rule-based permission engine | `src/utils/permissions/permissions.ts` | `src/utils/permissions/PermissionRule.ts`, `src/utils/permissions/PermissionResult.ts`, `src/utils/permissions/permissionRuleParser.ts` | Use this when changing rule precedence, bypass behavior, ask/deny matching, or auto-mode classifier routing. |
| Auto-mode classifier pipeline and fallback | `src/utils/permissions/yoloClassifier.ts` | `src/utils/permissions/yoloClassifier.test.ts`, `src/utils/permissions/autoModeProviderLadder.ts`, `src/services/api/client.ts` | Standard builds run the upstream port: a 64-token harm-only first stage followed by conditional full adjudication. Each stage owns an independent provider ladder; malformed or unavailable results fail closed. |
| Permission-context construction | `src/utils/permissions/permissionSetup.ts` | `src/utils/permissions/permissionsLoader.ts`, `src/utils/settings/settings.ts`, `src/commands/add-dir/validation.ts` | This is where session mode, additional working dirs, auto-mode safety stripping, and on-disk rule loading are assembled into `ToolPermissionContext`. |
| File/path permission policy | `src/utils/permissions/filesystem.ts` | `src/utils/permissions/pathValidation.ts`, `src/tools/BashTool/pathValidation.ts`, `src/utils/fsOperations.ts` | Routing owner for dangerous config files, `.cat-code` plus legacy `.claude`/`.git` protections, internal editable/readable paths, and permission suggestions. |
| Sandbox integration | `src/utils/permissions/pathValidation.ts` | `src/utils/sandbox/sandbox-adapter.ts`, `src/tools/BashTool/shouldUseSandbox.ts`, `src/utils/permissions/permissions.ts` | The path validator treats sandbox write allowlists as an extra write scope for out-of-working-dir paths. Bash sandbox auto-allow is decided higher up in permissions. |
| Tool execution lifecycle | `src/services/tools/toolExecution.ts` | `src/services/tools/toolHooks.ts`, `src/hooks/useCanUseTool.tsx`, `src/utils/toolResultStorage.ts` | Main per-call pipeline: schema parsing, validation, hook execution, permission decision, tool call, result processing, and failure handling. |
| Concurrent tool orchestration | `src/services/tools/toolOrchestration.ts` | `src/services/tools/StreamingToolExecutor.ts`, tool `isConcurrencySafe()` implementations | Non-read-only or non-concurrency-safe tools serialize. Read-only safe batches can run together. Context modifiers are applied after concurrent batches complete. |
| Tool hooks | `src/services/tools/toolHooks.ts` | `src/utils/hooks.ts`, `src/schemas/hooks.ts`, `src/types/hooks.ts` | Start here for PreToolUse, PostToolUse, and PostToolUseFailure behavior and how hook outputs affect continuation or MCP output rewrites. |
| MCP config layering | `src/services/mcp/config.ts` | `src/utils/config.ts`, `src/utils/plugins/mcpPluginIntegration.ts`, `src/utils/settings/types.ts` | Config layering spans global, project, managed, plugin, and connector sources. Deduplication is content-based, not just by server name. |
| MCP tool exposure | `src/services/mcp/client.ts` | `src/tools/MCPTool/MCPTool.ts`, `src/services/mcp/mcpStringUtils.ts`, `src/services/mcp/utils.ts` | Connected MCP tools are wrapped into normal `Tool` objects. `mcpInfo` preserves original server/tool identity even when display names are unprefixed. |
| MCP resources and auth tools | `src/services/mcp/client.ts` | `src/tools/ListMcpResourcesTool/`, `src/tools/ReadMcpResourceTool/`, `src/tools/McpAuthTool/` | Resource listing and auth surfaces are first-class tools, separate from normal MCP server tools. |
| Tool search and deferred loading | `src/utils/toolSearch.ts` | `src/tools/ToolSearchTool/ToolSearchTool.ts`, `src/tools/ToolSearchTool/prompt.ts`, `src/services/api/claude.ts` | Tool search decides whether deferred tools are omitted from the inline tool list and discovered later through tool references. |
| Tool input validation | `src/services/tools/toolExecution.ts` | `src/Tool.ts`, specific tool `inputSchema`, tool `validateInput()` implementation | The execution layer owns schema parsing and calls `validateInput()` before permission checks. Tool implementations own domain-specific validation details. |
| Shell-specific validation | `src/tools/BashTool/bashPermissions.ts` | `src/tools/BashTool/pathValidation.ts`, `src/tools/BashTool/readOnlyValidation.ts`, `src/tools/BashTool/shouldUseSandbox.ts` | Bash has deeper subcommand classification, redirection checks, path validation, sandbox routing, and classifier integration than most tools. |
| Tool examples and prompt-visible guidance | tool `prompt.ts` or tool implementation | `src/tools/ToolSearchTool/prompt.ts`, `src/utils/api.ts` | Tool descriptions and prompts are model-visible policy surfaces. For many tools they matter as much as code-level permission hooks. |
| Web search behavior and Exa transport | `src/tools/WebSearchTool/WebSearchTool.ts` | `src/tools/WebSearchTool/exa.ts`, `src/tools/WebSearchTool/prompt.ts`, `src/tools/WebSearchTool/UI.tsx`, `src/utils/subprocessEnv.ts` | `WebSearchTool.ts` owns schema, permission, progress, and result rendering handoff. `exa.ts` owns the direct Exa request, freshness/domain filters, response validation, timeout/abort behavior, and `EXA_API_KEY`; subprocess env forwarding keeps the key available to child runtimes. |

## Tool Exposure Flow

```text
src/tools.ts
  declares built-in base tools
  applies feature/env gates
  filters blanket-denied tools

src/services/mcp/config.ts
  loads and merges MCP server config

src/services/mcp/client.ts
  connects servers
  wraps server tools into Tool objects
  exposes MCP resources and auth helpers

src/tools.ts
  assembles built-in + MCP tool pool

src/utils/toolSearch.ts
  decides which tools are deferred vs inline

src/services/api/claude.ts
  serializes prompt-visible tool definitions or tool references
```

## Permission And Validation Flow

```text
src/services/tools/toolExecution.ts
  safeParse input with tool.inputSchema
  call tool.validateInput() if present
  run PreToolUse hooks

src/hooks/useCanUseTool.tsx
  calls hasPermissionsToUseTool()

src/utils/permissions/permissions.ts
  checks deny rules
  checks ask rules
  calls tool.checkPermissions()
  may invoke auto-mode classifier
  returns allow / ask / deny

src/hooks/useCanUseTool.tsx
  resolves config allow immediately
  or routes to coordinator / worker / interactive approval

tool call executes

src/services/tools/toolHooks.ts
  runs PostToolUse or PostToolUseFailure hooks
```

## Permission Rule Precedence

Inspect these surfaces when a tool is unexpectedly allowed, denied, or asking:

1. `src/tools.ts` `filterToolsByDenyRules()`
   Tool can disappear from prompt exposure before runtime.
2. `src/utils/permissions/permissions.ts`
   Entire-tool deny rule. Note: a blanket deny for `Agent` also denies `ResumeAgent` (it is another subagent execution surface).
3. `src/utils/permissions/permissions.ts`
   Entire-tool ask rule, with Bash sandbox exceptions.
4. Tool-specific `checkPermissions()`
   Bash, file tools, MCP tools, and AgentTool can impose narrower rules.
5. Safety-check asks from filesystem/path policy
   These are bypass-immune.
6. Auto-mode classifier path in `permissions.ts`
   Can convert an ask into allow or deny, subject to mode and feature gates. For
   Codex/OpenAI classifier side queries, transient model-route failures can fall
   back across the GPT cascade in `yoloClassifier.ts`.
7. `src/hooks/useCanUseTool.tsx`
   Final interactive, coordinator, or worker approval UI behavior.

## Agent Teams Mailbox Control Authority (2026-07-12 hardening)

Separate from the interactive permission engine above: `SendMessage`,
`ExitPlanMode`, `TaskUpdate`, and the in-process teammate loop exchange
*privileged control* messages over the team mailbox (shutdown, permission,
sandbox, plan-approval, team-permission, mode-set). This is its own
authority-checked boundary. Start with `src/utils/teammateMailbox.ts`.

- **Closed control union.** `MailboxControlPayloadSchema` (a Zod union of
  `PermissionRequest/ResponseMessageSchema`, `SandboxPermissionRequest/
  ResponseMessageSchema`, `ShutdownRequest/Approved/RejectedMessageSchema`,
  `PlanApprovalRequest/ResponseMessageSchema`,
  `TeamPermissionUpdateMessageSchema`, `ModeSetRequestMessageSchema`) is the
  only closed set of privileged types. A control object can only be created
  by `writeControlToMailbox()` — the low-level chat writer's type makes
  `control` unrepresentable, so plain chat cannot carry one. `idle_notification`
  and `task_assignment` are a separate, non-privileged notification union.
- **Runtime principals, not caller-authored identity.** `TeamPrincipal =
  {kind, agentId, name, allocationId}` is resolved from current runtime
  identity (`resolveCurrentTeamPrincipal()`, `resolveTeamPrincipalByName()`)
  plus a fresh versioned roster snapshot — never from a caller-supplied
  `from` field. `writeControlToMailbox()` has no caller-authored sender
  argument by construction.
- **Envelope authority matrix.** `classifyMailboxMessage()` enforces:

  | Direction | Allowed controls |
  |---|---|
  | team lead -> teammate | permission response, sandbox response, shutdown request, plan response, team-permission update, mode-set request |
  | teammate -> team lead | permission request, sandbox request, shutdown approved/rejected, plan request |

  `team_permission_update` is in the closed union, this matrix, and its
  consumer, but has no producer today (`TeamsDialog.tsx` only emits
  `mode_set_request`) — dormant, not a regression (`main` had no producer
  either). Wire a producer or drop the type before treating this row as live.

  Peers cannot originate leader-only controls. Wrong-direction, wrong-sender,
  or wrong-recipient-allocation messages classify as `invalid_control`, never
  silently downgrade to chat, and unmarked legacy control-shaped JSON is
  `protocol_mismatch` (explicit restart/cleanup required), not a downgrade
  either.
- **Request correlation.** Response controls (shutdown approved/rejected,
  plan response, permission/sandbox response) must consume one outstanding
  `PendingControlRecord` (`teamHelpers.ts`; state machine `sending -> written
  -> processing -> consumed`, compare-and-swapped by `claimPendingControl()`/
  `finishPendingControl()`) keyed by request ID, control type, and
  sender/recipient agent + allocation IDs. Unsolicited, duplicate, stale, or
  wrong-incarnation responses are rejected, not accepted-with-a-warning.
- **Consumers.** `src/hooks/useInboxPoller.ts`, `src/utils/attachments.ts`
  (headless dispatch), and `src/utils/swarm/inProcessRunner.ts`
  (`waitForNextPromptOrShutdown()`) all classify before acting — never parse
  `message.text` as authority. `inProcessRunner.ts` keeps one narrow legacy
  fallback (raw `isShutdownRequest(m.text)` text-sniff) ONLY when no
  version-2 team snapshot is resolvable at all (absent/legacy team); once a
  version-2 snapshot resolves, only `classifyMailboxMessage()`'s verdict is
  trusted.
- **Producers must observe delivery.** Every serialized privileged type must
  go through `writeControlToMailbox()`, and callers must await or explicitly
  observe the returned promise — including `useInboxPoller.ts`'s permission-
  response callbacks, historically fire-and-forget. A failed write must not
  be treated as delivered: e.g. `handleShutdownApproval` requires the
  matching outstanding request and a successful write before aborting the
  in-process controller or scheduling process shutdown; on failure it returns
  `success: false` and keeps the teammate alive.

## Key Owner Files By Tool Type

| Tool type | Owner files | Notes |
|---|---|---|
| Regular built-in tools | `src/tools.ts`, tool implementation file, `src/Tool.ts` | Most built-ins declare Zod `inputSchema` and optionally `validateInput()` and `checkPermissions()`. |
| Deferred built-in tools | tool implementation file, `src/tools/ToolSearchTool/prompt.ts`, `src/utils/toolSearch.ts` | `shouldDefer: true` marks built-ins for tool search when enabled. |
| MCP tools | `src/services/mcp/client.ts`, `src/tools/MCPTool/MCPTool.ts` | MCP tools use JSON Schema directly via `inputJSONSchema`. Their runtime prompt text comes from MCP server descriptions. |
| Resource tools | `src/tools/ListMcpResourcesTool/`, `src/tools/ReadMcpResourceTool/` | Separate from normal MCP call tools; still part of the tool pool and can be deferred. |
| Agent orchestration tools | `src/tools/AgentTool/`, worker-control tool dirs, `src/services/tools/toolOrchestration.ts` | These shape subagent behavior and can change the global tool pool seen by workers. |
| Shell tools | `src/tools/BashTool/`, `src/tools/PowerShellTool/`, `src/tools/REPLTool/` | These have the deepest permission logic and mode-specific behavior. |
| File mutation and persisted result bounds | `src/tools/{FileEditTool,FileWriteTool,FilePatchTool,NotebookEditTool}/` | `src/utils/{diff,analyzeContext}.ts`, the tool-specific tests, `src/utils/fileOperationAnalytics.ts` | Validate every destination, including move destinations, before mutation. The tool result must retain bounded, useful diff/line context rather than whole edited files or notebooks; rollback and result enumeration remain part of the safety contract. |

## Tool Search And Deferred Loading

Use these routing decisions when the issue is "why didn’t the model see this
tool?" or "why did it need `ToolSearchTool` first?":

- `src/utils/toolSearch.ts`
  owns the master mode decision: `tst`, `tst-auto`, or `standard`.
- `src/tools/ToolSearchTool/ToolSearchTool.ts`
  owns deferred-tool lookup, keyword scoring, and direct `select:<tool>` flow.
- `src/tools/ToolSearchTool/prompt.ts`
  defines which tools count as deferrable and the model-facing contract for
  fetching them.
- `src/services/api/claude.ts`
  is where deferred-tool decisions become API payload shape.
- `src/tools.ts`
  still matters because the tool must exist in the pool before it can be
  deferred.

Important current behavior:

- MCP tools are commonly deferred, but `alwaysLoad` can force inline exposure.
- Some built-in tools also defer through `shouldDefer: true`.
- `ToolSearchTool` itself must remain available or tool search collapses back
  to standard inline exposure.
- Deferred-tool names are announced either in `<system-reminder>` attachments
  or the older `<available-deferred-tools>` block, depending on the delta gate
  in `src/tools/ToolSearchTool/prompt.ts`.

## MCP Exposure And Validation Notes

When debugging MCP behavior, separate these concerns:

| Concern | Owner | Notes |
|---|---|---|
| Server config parse and validation | `src/services/mcp/config.ts` | Uses MCP config schemas and rejects invalid server config before connection. |
| Runtime connection and tool list fetch | `src/services/mcp/client.ts` | Converts server tool metadata into local `Tool` objects. |
| Tool name normalization | `src/services/mcp/mcpStringUtils.ts`, `src/services/mcp/normalization.ts` | MCP names can be prefixed or unprefixed depending on SDK mode and env. |
| Permission identity for MCP tools | `src/services/mcp/mcpStringUtils.ts`, `src/utils/permissions/permissions.ts` | Permission matching uses the fully-qualified MCP identity even when display names are unprefixed. |
| Result transformation and truncation | `src/services/mcp/client.ts`, `src/utils/mcpValidation.ts`, `src/utils/mcpOutputStorage.ts` | Structured content, content arrays, large output files, and images have separate handling. |
| MCP resources | `src/tools/ListMcpResourcesTool/`, `src/tools/ReadMcpResourceTool/` | Resource routing is separate from MCP `callTool`. |

## Validation Entry Points

Use these files when the problem is malformed input, bad schema projection, or
unexpected tool-call rejection:

| Validation type | Start here | Then inspect |
|---|---|---|
| Generic tool input parsing | `src/services/tools/toolExecution.ts` | `src/Tool.ts`, the tool's `inputSchema` |
| Tool-specific semantic validation | tool `validateInput()` | related helper module used by that tool |
| Permission validation | `src/utils/permissions/permissions.ts` | tool `checkPermissions()`, `permissionSetup.ts` |
| File/path validation | `src/utils/permissions/pathValidation.ts` | `filesystem.ts`, Bash path validators |
| MCP config validation | `src/services/mcp/config.ts` | `src/services/mcp/types.ts`, `src/utils/settings/validation.ts` |
| Settings-level permission rule validation | `src/utils/settings/permissionValidation.ts` | `src/utils/settings/toolValidationConfig.ts` |

## Tests And Validation

Use focused checks first, then the documented build:

| Area | Focused tests or checks |
|---|---|
| Permission suggestions and filesystem safety | `bun test src/utils/permissions/filesystemSuggestions.test.ts` and nearby permission tests |
| Auto-mode classifier | `bun test src/utils/permissions/yoloClassifier.test.ts` and `bun --feature=AUTO_MODE_UPSTREAM_PORT test src/utils/permissions/yoloClassifier.test.ts` |
| Agent tool and worker-control integration | `bun test src/tools/AgentTool/AgentTool.test.ts` plus worker-control tool tests |
| File-edit result bounds | `bun test src/tools/FileEditTool/FileEditTool.test.ts src/tools/FileWriteTool/FileWriteTool.test.ts src/tools/FilePatchTool/applier.test.ts src/tools/NotebookEditTool/NotebookEditTool.test.ts` |
| Mailbox control authority (closed union, authority matrix, request correlation) | `bun test src/utils/teammateMailbox.test.ts src/utils/attachments.test.ts src/hooks/useInboxPoller.test.ts src/utils/swarm/inProcessRunner.test.ts src/tools/SendMessageTool/SendMessageTool.test.ts src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.test.ts` |
| Tool search behavior | `bun test` for `src/tools/ToolSearchTool/` and `src/utils/toolSearch.ts` if present in current snapshot |
| MCP configuration and client behavior | MCP-related tests under `src/services/mcp/` and integration checks through connected server flows |
| Build-level validation | `bun run build:dev:full` |

## Traps And Stale Assumptions

- Do not assume every tool in `src/tools/` is exposed. `src/tools.ts` and
  `feature(...)` gating decide what is actually live.
- Do not assume deny rules act only at runtime. Blanket denies can remove tools
  from prompt exposure before the model ever sees them.
- Do not assume bypass mode overrides everything. Safety-check asks and
  content-specific ask rules are intentionally bypass-immune.
- Do not assume MCP tool names are stable display strings. Permission checks may
  use `mcp__server__tool` even when the displayed name is unprefixed.
- Do not assume `isReadOnly()` alone controls concurrency. Actual batching uses
  `isConcurrencySafe()`.
- Do not assume a file-mutating tool result can safely retain the full source input. Route transcript-size or persistence changes through the four file-tool owners and their bounded-result tests.
- Do not assume tool search is off unless explicitly enabled. In this snapshot,
  unset `ENABLE_TOOL_SEARCH` still defaults to deferred-tool mode unless other
  gates disable it.
- Do not assume MCP tools use Zod schemas. They commonly use raw JSON Schema
  via `inputJSONSchema`.
- Do not assume shell-tool permission logic lives in one place. Bash behavior is
  split across `bashPermissions.ts`, `pathValidation.ts`,
  `readOnlyValidation.ts`, sandbox helpers, and the generic permission engine.
- Do not assume `useCanUseTool()` is just UI. It also handles coordinator waits,
  swarm-worker behavior, classifier fast-paths, and cancellation behavior.
- Do not assume sandboxing only affects Bash execution. Path validation also
  treats the sandbox write allowlist as part of write-scope decisions.
- Do not assume Agent Teams mailbox controls are covered by the interactive
  permission engine above. They are a separate authority boundary
  (`src/utils/teammateMailbox.ts` `classifyMailboxMessage()` /
  `writeControlToMailbox()`) with its own closed union, runtime-principal
  resolution, and request correlation — see "Agent Teams Mailbox Control
  Authority".
