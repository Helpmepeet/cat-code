import { feature } from 'bun:bundle'
import type { BetaJSONOutputFormat } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { loadRoleFilePrompt, loadContextIndex } from '../../agent-mode/roleFiles.js'
import {
  readSessionState,
  readPersistedWorkerHandle,
  recordWorkerSessionSpawn,
} from '../../agent-mode/sessionState.js'
import { allocateWorkerName, releaseWorkerName } from '../../agent-mode/workerNames.js'
import { getCommand, getSkillToolCommands, hasCommand } from '../../commands.js'
import {
  getDefaultAgentPrompt,
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { query } from '../../query.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { cleanupAgentTracking } from '../../services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
  ServerResource,
} from '../../services/mcp/types.js'
import type {
  McpRuntimeInputs,
  McpRuntimeSnapshot,
  Tool,
  Tools,
  ToolUseContext,
} from '../../Tool.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { Command } from '../../types/command.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from '../../utils/forkedAgent.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { resolveRequestProvider } from '../../utils/model/providers.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import { type EffortLevel, resolveSubagentEffort } from '../../utils/effort.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import { getAgentModePromptInjections } from '../../agent-mode/roleFiles.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../../utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import {
  resolveAgentTools,
  type AgentToolEnvironment,
} from './agentToolUtils.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'

/**
 * Initialize agent-specific MCP servers
 * Agents can define their own MCP servers in their frontmatter that are additive
 * to the parent's MCP clients. These servers are connected when the agent starts
 * and cleaned up when the agent finishes.
 *
 * @param agentDefinition The agent definition with optional mcpServers
 * @param parentClients MCP clients inherited from parent context
 * @returns Merged clients (parent + agent-specific), agent MCP tools, and cleanup function
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
  registerCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  cleanup: () => Promise<void>
}> {
  // If no agent-specific servers defined, return parent clients as-is
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  // When MCP is locked to plugin-only, skip frontmatter MCP servers for
  // USER-CONTROLLED agents only. Plugin, built-in, and policySettings agents
  // are admin-trusted — their frontmatter MCP is part of the admin-approved
  // surface. Blocking them (as the first cut did) breaks plugin agents that
  // legitimately need MCP, contradicting "plugin-provided always loads."
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] Skipping MCP servers: strictPluginOnlyCustomization locks MCP to plugin-only (agent source: ${agentDefinition.source})`,
    )
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
  // Track which clients were newly created (inline definitions) vs. shared from parent
  // Only newly created clients should be cleaned up when the agent finishes
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  // Create cleanup function for agent-specific servers
  // Only clean up newly created clients (inline definitions), not shared/referenced ones
  // Shared clients (referenced by string name) are memoized and used by the parent context
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Error cleaning up MCP server '${client.name}': ${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // Hand the caller its cleanup handle before the first connect. A rejecting
  // connectToServer part-way through the loop throws out of this function, so
  // returning the handle at the end is too late to close the clients that did
  // connect.
  registerCleanup?.(cleanup)

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

    if (typeof spec === 'string') {
      // Reference by name - look up in existing MCP configs
      // This uses the memoized connectToServer, so we may get a shared client
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] MCP server not found: ${spec}`,
          { level: 'warn' },
        )
        continue
      }
    } else {
      // Inline definition as { [name]: config }
      // These are agent-specific servers that should be cleaned up
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Invalid MCP server spec: expected exactly one key`,
          { level: 'warn' },
        )
        continue
      }
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true
    }

    // Connect to the server
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)
    }

    // Fetch tools if connected
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Connected to MCP server '${name}' with ${tools.length} tools`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Failed to connect to MCP server '${name}': ${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // Return merged clients (parent + agent-specific) and agent tools
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * Type guard to check if a message from query() is a recordable Message type.
 * Matches the types we want to record: assistant, user, progress, or system compact_boundary.
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

type SetupCleanup = () => void | Promise<void>

/**
 * Cleanup scope for the resources acquired before the query loop's own
 * try/finally: the worker-name reservation, the Perfetto trace entry, the
 * transcript subdir mapping, the agent's frontmatter hooks, and any MCP clients
 * it connected. Setup between those acquisitions and the loop can throw (an
 * unreadable frontmatter skill, a rejecting MCP connect), and that throw skips
 * the loop's finally entirely — this one is what runs instead.
 *
 * Exactly-once is enforced by ownership, not by idempotent releases: the loop's
 * finally empties this list before releasing anything, so whichever runs, only
 * one of them releases.
 */
export async function* runAgent(
  params: Parameters<typeof runAgentInCleanupScope>[0],
): AsyncGenerator<Message, void> {
  const setupCleanups: SetupCleanup[] = []
  try {
    yield* runAgentInCleanupScope(params, setupCleanups)
  } finally {
    for (const release of setupCleanups.splice(0)) {
      try {
        await release()
      } catch (err) {
        logForDebugging(
          `Failed to release agent setup resource: ${errorMessage(err)}`,
          { level: 'warn' },
        )
      }
    }
  }
}

async function* runAgentInCleanupScope({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  effort,
  maxTurns,
  outputFormat,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  agentToolEnvironment,
  mcpRuntimeInputs,
  mcpRuntimeSnapshot,
  worktreePath,
  description,
  agentName,
  transcriptSubdir,
  sessionStateTracking,
  onQueryProgress,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /** Whether this agent can show permission prompts. Defaults to !isAsync.
   * Set to true for in-process teammates that run async but share the terminal. */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  /** Effort level the caller selected for this spawn. Outranks the agent
   * definition's `effort:` pin and the parent's current effort; see
   * resolveSubagentEffort() for the full chain and for why it is dropped on
   * cache-identical (useExactTools) runs. */
  effort?: EffortLevel
  maxTurns?: number
  outputFormat?: BetaJSONOutputFormat
  /** Preserve toolUseResult on messages for subagents with viewable transcripts */
  preserveToolUseResults?: boolean
  /** Precomputed tool pool for the worker agent. Computed by the caller
   * (AgentTool.tsx) to avoid a circular dependency between runAgent and tools.ts.
   * Always contains the full tool pool assembled with the worker's own permission
   * mode, independent of the parent's tool restrictions. */
  availableTools: Tools
  /** Tool permission rules to add to the agent's session allow rules.
   * When provided, replaces ALL allow rules so the agent only has what's
   * explicitly listed (parent approvals don't leak through). */
  allowedTools?: string[]
  /** Optional callback invoked with CacheSafeParams after constructing the agent's
   * system prompt, context, and tools. Used by background summarization to fork
   * the agent's conversation for periodic progress summaries. */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /** Replacement state reconstructed from a resumed sidechain transcript so
   * the same tool results are re-replaced (prompt cache stability). When
   * omitted, createSubagentContext clones the parent's state. */
  contentReplacementState?: ContentReplacementState
  /** When true, use availableTools directly without filtering through
   * resolveAgentTools(). Also inherits the parent's thinkingConfig and
   * isNonInteractiveSession instead of overriding them. Used by the fork
   * subagent path to produce byte-identical API request prefixes for
   * prompt cache hits. */
  useExactTools?: boolean
  /** Explicit tool-pool environment for the internal resolveAgentTools() call
   * when useExactTools is false. Callers that resolve their own copy of this
   * same tool list OUTSIDE the environment's usual AsyncLocalStorage-based
   * detection (in-process teammates build their system prompt before their
   * ALS context exists) pass it explicitly so this per-turn resolution can't
   * disagree with that prior resolution. Defaults to 'default'. */
  agentToolEnvironment?: AgentToolEnvironment
  /** A fully assembled MCP runtime read by the caller. This is used by launch
   * paths that already consumed refreshMcpRuntime and must not perform a second
   * snapshot read before handing tools, commands, clients, and resources to the
   * subagent. */
  mcpRuntimeInputs?: McpRuntimeInputs
  /** The MCP generation this launch was authorized against. AgentTool reads it
   * once after waiting for required servers and passes it here so the tool
   * pool, clients, and resources the subagent starts with all come from that
   * same read. Omit it and this run reads the parent context's current
   * snapshot itself; with no live MCP source at all, the parent's static
   * options are used as before. */
  mcpRuntimeSnapshot?: McpRuntimeSnapshot
  /** Worktree path if the agent was spawned with isolation: "worktree".
   * Persisted to metadata so resume can restore the correct cwd. */
  worktreePath?: string
  /** Original task description from AgentTool input. Persisted to metadata
   * so a resumed agent's notification can show the original description. */
  description?: string
  /** Friendly system/user-facing name for targeting this subagent. */
  agentName?: string
  /** Optional subdirectory under subagents/ to group this agent's transcript
   * with related ones (e.g. workflows/<runId> for workflow subagents). */
  transcriptSubdir?: string
  /** Optional Agent Mode durable-state context. When present, this run is the
   * actual start/resume of a worker session and should update durable worker
   * state by default. Set recordSpawn: false for sync→background continuation
   * when the worker identity should be reused but not re-recorded as a spawn. */
  sessionStateTracking?: {
    sessionId: string
    mode: string
    objective: string
    statePath?: string
    recordSpawn?: boolean
  }
  /** Optional callback fired on every message yielded by query() — including
   * stream_event deltas that runAgent otherwise drops. Use to detect liveness
   * during long single-block streams (e.g. thinking) where no assistant
   * message is yielded for >60s. */
  onQueryProgress?: () => void
}, setupCleanups: SetupCleanup[]): AsyncGenerator<Message, void> {
  // Track subagent usage for feature discovery

  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  // Always-shared channel to the root AppState store. toolUseContext.setAppState
  // is a no-op when the *parent* is itself an async agent (nested async→async),
  // so session-scoped writes (hooks, bash tasks) must go through this instead.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
    resolveRequestProvider(
      toolUseContext.options.mainLoopModel,
      toolUseContext.options.mainLoopProvider,
    ),
  )

  const agentId = override?.agentId ? override.agentId : createAgentId()
  const persistedWorkerHandle =
    sessionStateTracking && override?.agentId
      ? await readPersistedWorkerHandle(
          sessionStateTracking.sessionId,
          override.agentId,
          sessionStateTracking.statePath,
        )
      : null
  const reservedWorkerHandles = sessionStateTracking
    ? (
        (
          await readSessionState(
            sessionStateTracking.sessionId,
            sessionStateTracking.statePath,
          )
        )?.knownWorkers ??
        []
      )
        .map(worker => worker.handle)
        .filter((handle): handle is string => Boolean(handle && handle.length > 0))
    : []
  const workerName =
    persistedWorkerHandle ??
    agentName ??
    allocateWorkerName(agentDefinition.agentType, reservedWorkerHandles, {
      allowGeneric: Boolean(sessionStateTracking),
    })
  const workerHandle = workerName ?? agentId
  if (workerName) {
    setupCleanups.push(() => releaseWorkerName(workerName))
  }

  // Route this agent's transcript into a grouping subdirectory if requested
  // (e.g. workflow subagents write to subagents/workflows/<runId>/).
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
    setupCleanups.push(() => clearAgentTranscriptSubdir(agentId))
  }

  // Register agent in Perfetto trace for hierarchy visualization
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
    setupCleanups.push(() => unregisterPerfettoAgent(agentId))
  }

  // Log API calls path for subagents (ant-only)
  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[Subagent ${agentDefinition.agentType}] API calls: ${getDisplayPath(getDumpPromptsPath(agentId))}`,
    )
  }

  // Handle message forking for context sharing
  // Filter out incomplete tool calls from parent messages to avoid API errors
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]

  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])

  // Read-only agents (Explore, Plan) don't act on commit/PR/lint rules from
  // CLAUDE.md — the main agent has full context and interprets their output.
  // Dropping claudeMd here saves ~5-15 Gtok/week across 34M+ Explore spawns.
  // Explicit override.userContext from callers is preserved untouched.
  // Kill-switch defaults true; flip tengu_slim_subagent_claudemd=false to revert.
  const shouldOmitClaudeMd =
    agentDefinition.omitClaudeMd &&
    !override?.userContext &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
  const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitClaudeMd
    ? userContextNoClaudeMd
    : baseUserContext

  // Explore/Plan are read-only search agents — the parent-session-start
  // gitStatus (up to 40KB, explicitly labeled stale) is dead weight. If they
  // need git info they run `git status` themselves and get fresh data.
  // Saves ~1-3 Gtok/week fleet-wide.
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  const resolvedSystemContext =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan'
      ? systemContextNoGit
      : baseSystemContext

  // Override permission mode if agent defines one
  // However, don't override if parent is in bypassPermissions or acceptEdits mode - those should always take precedence
  // For async agents, also set shouldAvoidPermissionPrompts since they can't show UI
  const agentPermissionMode = agentDefinition.permissionMode
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // Override permission mode if agent defines one (unless parent is bypassPermissions, acceptEdits, or auto)
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        feature('TRANSCRIPT_CLASSIFIER') &&
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // Set flag to auto-deny prompts for agents that can't show UI
    // Use explicit canShowPermissionPrompts if provided, otherwise:
    //   - bubble mode: always show prompts (bubbles to parent terminal)
    //   - default: !isAsync (sync agents show prompts, async agents don't)
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // For background agents that can show prompts, await automated checks
    // (classifier, permission hooks) before showing the permission dialog.
    // Since these are background agents, waiting is fine — the user should
    // only be interrupted when automated checks can't resolve the permission.
    // This applies to bubble mode (always) and explicit canShowPermissionPrompts.
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // Scope tool permissions: when allowedTools is provided, use them as session rules.
    // IMPORTANT: Preserve cliArg rules (from SDK's --allowedTools) since those are
    // explicit permissions from the SDK consumer that should apply to all agents.
    // Only clear session-level rules from the parent to prevent unintended leakage.
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // Preserve SDK-level permissions from --allowedTools
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // Use the provided allowedTools as session-level permissions
          session: [...allowedTools],
        },
      }
    }

    // Per-call override → agent definition pin → parent's current effort
    const effortValue = resolveSubagentEffort({
      requestedEffort: effort,
      agentDefinitionEffort: agentDefinition.effort,
      parentEffortValue: state.effortValue,
      cacheIdenticalRun: useExactTools,
    })

    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue
    ) {
      return state
    }
    return {
      ...state,
      toolPermissionContext,
      effortValue,
    }
  }

  const resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(
        agentDefinition,
        availableTools,
        isAsync,
        agentToolEnvironment,
      ).resolvedTools

  const additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

  const agentSystemPrompt = override?.systemPrompt
    ? override.systemPrompt
    : asSystemPrompt(
        await getAgentSystemPrompt(
          agentDefinition,
          toolUseContext,
          resolvedAgentModel,
          additionalWorkingDirectories,
          resolvedTools,
          workerName ?? undefined,
        ),
      )

  // Determine abortController:
  // - Override takes precedence
  // - Async agents get a new unlinked controller (runs independently)
  // - Sync agents share parent's controller
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

  // Execute SubagentStart hooks and collect additional context
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // Add SubagentStart hook context as a user message (consistent with SessionStart/UserPromptSubmit)
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SubagentStart',
      toolUseID: randomUUID(),
      hookEvent: 'SubagentStart',
    })
    initialMessages.push(contextMessage)
  }

  // Register agent's frontmatter hooks (scoped to agent lifecycle)
  // Pass isAgent=true to convert Stop hooks to SubagentStop (since subagents trigger SubagentStop)
  // Same admin-trusted gate for frontmatter hooks: under ["hooks"] alone
  // (skills/agents not locked), user agents still load — block their
  // frontmatter-hook REGISTRATION here where source is known, rather than
  // blanket-blocking all session hooks at execution time (which would
  // also kill plugin agents' hooks).
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent - converts Stop to SubagentStop
    )
    setupCleanups.push(() => clearSessionHooks(rootSetAppState, agentId))
  }

  // Preload skills from agent frontmatter
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // Filter valid skills and warn about missing ones
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // Resolve the skill name, trying multiple strategies:
      // 1. Exact match (hasCommand checks name, userFacingName, aliases)
      // 2. Fully-qualified with agent's plugin prefix (e.g., "my-skill" → "plugin:my-skill")
      // 3. Suffix match on ":skillName" for plugin-namespaced skills
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' specified in frontmatter was not found`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' is not a prompt-based skill`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // Load all skill contents concurrently and add to initial messages
    const { formatSkillLoadingMetadata } = await import(
      '../../utils/processUserInput/processSlashCommand.js'
    )
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Preloaded skill '${skillName}'`,
      )

      // Add command-message metadata so the UI shows which skill is loading
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

  // The parent's MCP generation for this launch: the caller's snapshot when it
  // took one, otherwise a single read of the live source, otherwise the static
  // options. Clients and resources are taken from the same object so they can
  // never straddle two generations.
  const parentMcpRuntime = mcpRuntimeInputs
    ? undefined
    : (mcpRuntimeSnapshot ??
      toolUseContext.options.getMcpRuntimeSnapshot?.())
  const parentMcpClients = mcpRuntimeInputs
    ? [...mcpRuntimeInputs.mcpClients]
    : parentMcpRuntime
      ? [...parentMcpRuntime.clients]
      : toolUseContext.options.mcpClients
  const parentMcpResources: Record<string, ServerResource[]> = mcpRuntimeInputs
    ? Object.fromEntries(
        Object.entries(mcpRuntimeInputs.mcpResources).map(
          ([server, resources]) => [server, [...resources]],
        ),
      )
    : parentMcpRuntime
      ? Object.fromEntries(
          Object.entries(parentMcpRuntime.resources).map(
            ([server, resources]) => [server, [...resources]],
          ),
        )
      : toolUseContext.options.mcpResources
  const parentCommands = mcpRuntimeInputs
    ? [...mcpRuntimeInputs.commands]
    : parentMcpRuntime
      ? [
          ...toolUseContext.options.commands.filter(
            command => !command.isMcp && command.loadedFrom !== 'mcp',
          ),
          ...parentMcpRuntime.commands,
        ]
      : []
  const parentBaseTools = availableTools.filter(tool => !tool.mcpInfo)
  const parentBaseCommands = toolUseContext.options.commands.filter(
    command => !command.isMcp && command.loadedFrom !== 'mcp',
  )

  // Initialize agent-specific MCP servers (additive to parent's servers)
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    parentMcpClients,
    cleanup => setupCleanups.push(cleanup),
  )

  // Merge agent MCP tools with resolved agent tools, deduplicating by name.
  // resolvedTools is already deduplicated (see resolveAgentTools), so skip
  // the spread + uniqBy overhead when there are no agent-specific MCP tools.
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools
  const agentMcpClients = mergedMcpClients.slice(parentMcpClients.length)
  const refreshMcpRuntime = () => {
    const snapshot = toolUseContext.options.getMcpRuntimeSnapshot?.()
    if (!snapshot) {
      return {
        tools: allTools,
        commands: parentCommands,
        mcpClients: mergedMcpClients,
        mcpResources: parentMcpResources,
      }
    }
    const refreshedTools = resolveAgentTools(
      agentDefinition,
      [...parentBaseTools, ...snapshot.tools],
      isAsync,
      agentToolEnvironment,
    ).resolvedTools

    return {
      tools:
        agentMcpTools.length > 0
          ? uniqBy([...refreshedTools, ...agentMcpTools], 'name')
          : refreshedTools,
      commands: [...parentBaseCommands, ...snapshot.commands],
      mcpClients: [...snapshot.clients, ...agentMcpClients],
      mcpResources: Object.fromEntries(
        Object.entries(snapshot.resources).map(([server, resources]) => [
          server,
          [...resources],
        ]),
      ),
    }
  }

  // Build agent-specific options
  const agentOptions: ToolUseContext['options'] = {
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    tools: allTools,
    commands: parentCommands,
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: resolvedAgentModel,
    mainLoopProvider: resolveRequestProvider(
      resolvedAgentModel,
      toolUseContext.options.mainLoopProvider,
    ),
    // For fork children (useExactTools), inherit thinking config to match the
    // parent's API request prefix for prompt cache hits. For regular
    // sub-agents, disable thinking to control output token costs.
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: parentMcpResources,
    getMcpRuntimeSnapshot: toolUseContext.options.getMcpRuntimeSnapshot,
    refreshMcpRuntime,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // Fork children (useExactTools path) need querySource on context.options
    // for the recursive-fork guard at AgentTool.tsx call() — it checks
    // options.querySource === 'agent:builtin:fork'. This survives autocompact
    // (which rewrites messages, not context.options). Without this, the guard
    // reads undefined and only the message-scan fallback fires — which
    // autocompact defeats by replacing the fork-boilerplate message.
    ...(useExactTools && { querySource }),
  }

  // Create subagent context using shared helper
  // - Sync agents share setAppState, setResponseLength, abortController with parent
  // - Async agents are fully isolated (but with explicit unlinked abortController)
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    // Sync agents share these callbacks with parent
    shareSetAppState: !isAsync,
    shareSetResponseLength: true, // Both sync and async contribute to response metrics
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // Preserve tool use results for subagents with viewable transcripts (in-process teammates)
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // Expose cache-safe params for background summarization (prompt cache sharing)
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // Record initial messages before the query loop starts, plus the agentType
  // so resume can route correctly when subagent_type is omitted. Both writes
  // are fire-and-forget — persistence failure shouldn't block the agent.
  void recordSidechainTranscript(initialMessages, agentId).catch(_err =>
    logForDebugging(`Failed to record sidechain transcript: ${_err}`),
  )
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(workerName && { agentName: workerName }),
    ...(worktreePath && { worktreePath }),
    ...(description && { description }),
    parentSessionId: getSessionId(),
    parentToolUseId: toolUseContext.toolUseId,
    spawnedAt: new Date().toISOString(),
  }).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))

  if (sessionStateTracking && sessionStateTracking.recordSpawn !== false) {
    void recordWorkerSessionSpawn({
      sessionId: sessionStateTracking.sessionId,
      mode: sessionStateTracking.mode,
      objective: sessionStateTracking.objective,
      ...(sessionStateTracking.statePath
        ? { statePath: sessionStateTracking.statePath }
        : {}),
      handle: workerHandle,
      agentId,
      role: agentDefinition.agentType,
      description: description ?? 'Continue current objective',
      worktreePath: worktreePath ?? null,
      spawnedAt: new Date().toISOString(),
    }).catch(_err =>
      logForDebugging(`Failed to record Agent Mode worker spawn: ${_err}`),
    )
  }

  // Track the last recorded message UUID for parent chain continuity
  let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns,
      outputFormat,
    })) {
      onQueryProgress?.()
      // Forward subagent API request starts to parent's metrics display
      // so TTFT/OTPS update during subagent execution.
      if (
        message.type === 'stream_event' &&
        message.event.type === 'message_start' &&
        message.ttftMs != null
      ) {
        toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
        continue
      }

      // Yield attachment messages (e.g., structured_output) without recording them
      if (message.type === 'attachment') {
        // Handle max turns reached signal from query.ts
        const reachedMaxTurns =
          message.attachment.type === 'max_turns_reached'
        if (reachedMaxTurns) {
          logForDebugging(
            `[Agent
: $
{
  agentDefinition.agentType
}
] Reached max turns limit ($
{
  message.attachment.maxTurns
}
)`,
          )
        }
        // The max-turns attachment is yielded like any other rather than
        // swallowed: it is the only record that the run was cut short, and
        // finalizeAgentTool reads it to mark the result failed. Dropping it
        // here made exhaustion look like a clean completion to every caller.
        yield message
        if (reachedMaxTurns) break
        continue
      }

      if (isRecordableMessage(message)) {
        // Record only the new message with correct parent (O(1) per message)
        await recordSidechainTranscript(
          [message],
          agentId,
          lastRecordedUuid,
        ).catch(err =>
          logForDebugging(`Failed to record sidechain transcript: ${err}`),
        )
        if (message.type !== 'progress') {
          lastRecordedUuid = message.uuid
        }
        yield message
      }
    }

    if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // Run callback if provided (only built-in agents have callbacks)
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }
  } finally {
    // Reaching here means setup completed, so this block owns every pre-loop
    // resource too. Disarm the setup scope first so the two never both release.
    setupCleanups.length = 0
    // Clean up agent-specific MCP servers (runs on normal completion, abort, or error)
    await mcpCleanup()
    // Clean up agent's session hooks
    if (agentDefinition.hooks) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    // Clean up prompt cache tracking state for this agent
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      cleanupAgentTracking(agentId)
    }
    // Release cloned file state cache memory
    agentToolUseContext.readFileState.clear()
    // Release the cloned fork context messages
    initialMessages.length = 0
    // Release perfetto agent registry entry
    unregisterPerfettoAgent(agentId)
    // Release transcript subdir mapping
    clearAgentTranscriptSubdir(agentId)
    // Release this agent's todos entry. Without this, every subagent that
    // called TodoWrite leaves a key in AppState.todos forever (even after all
    // items complete, the value is [] but the key stays). Whale sessions
    // spawn hundreds of agents; each orphaned key is a small leak that adds up.
    rootSetAppState(prev => {
      if (!(agentId in prev.todos)) return prev
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // Kill any background bash tasks this agent spawned. Without this, a
    // `run_in_background` shell loop (e.g. test fixture fake-logs.sh) outlives
    // the agent as a PPID=1 zombie once the main session eventually exits.
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    if (workerName) releaseWorkerName(workerName)
    /* eslint-disable @typescript-eslint/no-require-imports */
    if (feature('MONITOR_TOOL')) {
      const mcpMod =
        require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js')
      mcpMod.killMonitorMcpTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
}

/**
 * Filters out assistant messages with incomplete tool calls (tool uses without
 * results), along with the tool_result blocks that paired with them.
 * This prevents API errors when sending messages with orphaned tool calls.
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // Build a set of tool use IDs that have results
  const toolUseIdsWithResults = new Set<string>()

  for (const message of messages) {
    if (message?.type === 'user') {
      const userMessage = message as UserMessage
      const content = userMessage.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolUseIdsWithResults.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // Find the assistant messages to exclude, and collect every tool_use ID they
  // carry — not just the unpaired ones. An interrupted turn yields results for
  // the calls that finished before the interrupt, so dropping the whole
  // assistant message strands those results with nothing to pair against.
  const droppedAssistants = new Set<Message>()
  const strandedToolUseIds = new Set<string>()

  for (const message of messages) {
    if (message?.type !== 'assistant') continue
    const content = (message as AssistantMessage).message.content
    if (!Array.isArray(content)) continue
    // Check if this assistant message has any tool uses without results
    const hasIncompleteToolCall = content.some(
      block =>
        block.type === 'tool_use' &&
        block.id &&
        !toolUseIdsWithResults.has(block.id),
    )
    if (!hasIncompleteToolCall) continue
    droppedAssistants.add(message)
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        strandedToolUseIds.add(block.id)
      }
    }
  }

  // Drop those assistant messages, and the results they stranded. Leaving the
  // results behind only survives on the Anthropic path, which repairs pairing
  // at request time (ensureToolResultPairing in claude.ts); the Codex path does
  // not, and translateMessages turns each orphan into a function_call_output
  // with no call to match it.
  const filtered: Message[] = []
  for (const message of messages) {
    if (droppedAssistants.has(message)) continue

    if (message?.type === 'user' && strandedToolUseIds.size > 0) {
      const content = (message as UserMessage).message.content
      if (Array.isArray(content)) {
        const keptBlocks = content.filter(
          block =>
            !(
              block.type === 'tool_result' &&
              block.tool_use_id &&
              strandedToolUseIds.has(block.tool_use_id)
            ),
        )
        if (keptBlocks.length !== content.length) {
          // A message stripped down to nothing is dropped rather than sent with
          // an empty content array, which neither provider accepts.
          if (keptBlocks.length > 0) {
            filtered.push({
              ...message,
              message: { ...message.message, content: keptBlocks },
            } as Message)
          }
          continue
        }
      }
    }

    // Keep all other messages, and assistant messages without incomplete calls
    filtered.push(message)
  }

  return filtered
}

async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
  workerName?: string,
): Promise<string[]> {
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  let agentPrompt: string
  try {
    agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
  } catch (error) {
    logForDebugging(
      `Failed to get system prompt for agent ${agentDefinition.agentType}: ${errorMessage(error)}`,
    )
    agentPrompt = getDefaultAgentPrompt(
      resolveRequestProvider(
        resolvedAgentModel,
        toolUseContext.options.mainLoopProvider,
      ),
    )
  }

  const promptInjections = isBuiltInAgent(agentDefinition)
    ? await getAgentModePromptInjections(agentDefinition.agentType)
    : []

  const prompts = [
    agentPrompt,
    ...promptInjections,
  ]

  return enhanceSystemPromptWithEnvDetails(
    prompts,
    resolvedAgentModel,
    additionalWorkingDirectories,
    enabledToolNames,
    resolveRequestProvider(
      resolvedAgentModel,
      toolUseContext.options.mainLoopProvider,
    ),
  )
}

/**
 * Resolve a skill name from agent frontmatter to a registered command name.
 *
 * Plugin skills are registered with namespaced names (e.g., "my-plugin:my-skill")
 * but agents reference them with bare names (e.g., "my-skill"). This function
 * tries multiple resolution strategies:
 *
 * 1. Exact match via hasCommand (name, userFacingName, aliases)
 * 2. Prefix with agent's plugin name (e.g., "my-skill" → "my-plugin:my-skill")
 * 3. Suffix match — find any command whose name ends with ":skillName"
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 1. Direct match
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 2. Try prefixing with the agent's plugin name
  // Plugin agents have agentType like "pluginName:agentName"
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 3. Suffix match — find a skill whose name ends with ":skillName"
  const suffix = `:${skillName}`
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  return null
}
