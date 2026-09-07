import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import type { BetaJSONOutputFormat } from '@anthropic-ai/sdk/resources/index.mjs'
import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  ASYNC_AGENT_EXPLICIT_GRANT_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
  PROVIDER_FILE_EDIT_TOOL_ALIASES,
} from '../../constants/tools.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { snapshotLeaseAccount, type CodexLeaseAccount } from '../../services/api/codexAccountLeaseManager.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import { recordWorkerSessionTerminal } from '../../utils/workerState.js'
import type { AppState } from '../../state/AppState.js'
import type {
  Tool,
  ToolPermissionContext,
  Tools,
  ToolUseContext,
} from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import {
  completeAgentTask as completeAsyncAgent,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  type ProgressTracker,
  updateAgentProgress as updateAsyncAgentProgress,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import type { Message as MessageType } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { resolveRequestProvider } from '../../utils/model/providers.js'
import { isInProtectedNamespace } from '../../utils/envUtils.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import {
  buildTranscriptForClassifier,
  classifyYoloAction,
} from '../../utils/permissions/yoloClassifier.js'
import { emitTaskProgress as emitTaskProgressEvent } from '../../utils/task/sdkProgress.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_PATCH_TOOL_NAME } from '../FilePatchTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { appendSubagentTerminal } from '../../utils/sessionStorage.js'
import { unregisterActiveSubagent } from '../../utils/cleanupRegistry.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import {
  getForkWorkerResultJsonSchema,
  parseForkWorkerResult,
  serializeForkWorkerResultForClaude,
  serializeForkWorkerResultForOpenAI,
} from '../../contracts/orchestration.js'
import { safeParseJSON } from '../../utils/json.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../ExitPlanModeTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../ResumeAgentTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
export type ResolvedAgentTools = {
  hasWildcard: boolean
  validTools: string[]
  invalidTools: string[]
  resolvedTools: Tools
  allowedAgentTypes?: string[]
}

/**
 * Explicit tool-pool environment for filtering/resolution. `'default'` is the
 * ordinary async-subagent case. `'in-process-teammate'` and `'main-thread'`
 * are explicit rather than derived from AsyncLocalStorage (isInProcessTeammate())
 * so a caller that resolves tools BEFORE the teammate's ALS context exists
 * (inProcessRunner building its initial system prompt) gets the same answer
 * as a caller resolving tools from inside it (Task 5: prompt/tool-pool
 * consistency — see docs/superpowers/plans/2026-07-12-agent-control-routing-hardening-plan.md).
 */
export type AgentToolEnvironment =
  | 'default'
  | 'in-process-teammate'
  | 'main-thread'

export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
  environment = 'default',
  explicitlyRequestedTools,
}: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
  environment?: AgentToolEnvironment
  /** Tool names the agent definition names in its own `tools` list (never
   * `['*']`). Passing this set opts into grant-only enforcement: a member of
   * ASYNC_AGENT_EXPLICIT_GRANT_TOOLS survives only if the definition named it.
   * ALL_AGENT_DISALLOWED_TOOLS stays absolute either way. Callers that ask
   * "which tools COULD a definition select" (the agent-creation tool picker)
   * omit it, so grantable tools stay pickable there. */
  explicitlyRequestedTools?: ReadonlySet<string>
}): Tools {
  return tools.filter(tool => {
    // Allow MCP tools for all agents
    if (tool.name.startsWith('mcp__')) {
      return true
    }
    // Allow ExitPlanMode for agents in plan mode (e.g., in-process teammates)
    // This bypasses both the ALL_AGENT_DISALLOWED_TOOLS and async tool filters
    if (
      toolMatchesName(tool, EXIT_PLAN_MODE_V2_TOOL_NAME) &&
      permissionMode === 'plan'
    ) {
      return true
    }
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    // Grant-only tools (Skill) are withheld from EVERY worker unless its own
    // definition named the tool — foreground and background must not differ,
    // or the worker tool policy is true for one spawn shape and false for
    // the other (owner decision 2026-07-30, C10). Enforced only when the
    // caller supplies the definition's own list; see the field doc above.
    if (
      explicitlyRequestedTools !== undefined &&
      ASYNC_AGENT_EXPLICIT_GRANT_TOOLS.has(tool.name) &&
      !explicitlyRequestedTools.has(tool.name)
    ) {
      return false
    }
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      // Default-off but explicitly grantable (Skill): the role's own
      // definition asked for it by name, so honor that. Reached only after
      // the absolute disallow lists above.
      if (
        ASYNC_AGENT_EXPLICIT_GRANT_TOOLS.has(tool.name) &&
        explicitlyRequestedTools?.has(tool.name)
      ) {
        return true
      }
      if (isAgentSwarmsEnabled() && environment === 'in-process-teammate') {
        // Allow AgentTool for in-process teammates to spawn sync subagents.
        // Validation in AgentTool.call() prevents background agents and teammate spawning.
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) {
          return true
        }
        // Allow task tools for in-process teammates to coordinate via shared task list
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) {
          return true
        }
      }
      return false
    }
    return true
  })
}

/**
 * Resolves and validates agent tools against available tools
 * Handles wildcard expansion and validation in one place
 */
export function resolveAgentTools(
  agentDefinition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  >,
  availableTools: Tools,
  isAsync = false,
  environment: AgentToolEnvironment = 'default',
): ResolvedAgentTools {
  const {
    tools: agentTools,
    disallowedTools,
    source,
    permissionMode,
  } = agentDefinition
  const isMainThread = environment === 'main-thread'
  // If tools is undefined or ['*'], allow all tools (after filtering disallowed)
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')
  // Parsed once and reused by the resolution loop below: resolveAgentTools runs
  // on every spawn and inside REPL render memos, so parsing each spec twice is
  // work this path does not need.
  const parsedSpecs =
    hasWildcard || agentTools === undefined
      ? []
      : agentTools.map(spec => ({
          spec,
          ...permissionRuleValueFromString(spec),
        }))
  // A wildcard is not an explicit grant — it means "whatever policy allows".
  // Only a definition that names a default-off tool (Skill) keeps it.
  const explicitlyRequestedTools = new Set(
    parsedSpecs.map(parsed => parsed.toolName),
  )
  // When isMainThread is true, skip filterToolsForAgent entirely — the main
  // thread's tool pool is already properly assembled by useMergedTools(), so
  // the sub-agent disallow lists shouldn't apply.
  const filteredAvailableTools = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn: source === 'built-in',
        isAsync,
        permissionMode,
        environment,
        explicitlyRequestedTools,
      })

  // Create a set of disallowed tool names for quick lookup
  const disallowedToolSet = new Set(
    disallowedTools?.map(toolSpec => {
      const { toolName } = permissionRuleValueFromString(toolSpec)
      return toolName
    }) ?? [],
  )

  // The two file-edit aliases are one capability, so denying either denies
  // both. Without this, a role that disallows Edit (Explore, Plan, the
  // verifiers) receives Apply_patch on the OpenAI path, where the pool swaps
  // the alias — a provider swap must not grant a read-only role write access
  // (owner decision 2026-07-30, C11).
  if (
    PROVIDER_FILE_EDIT_TOOL_ALIASES.some(name => disallowedToolSet.has(name))
  ) {
    for (const name of PROVIDER_FILE_EDIT_TOOL_ALIASES) {
      disallowedToolSet.add(name)
    }
  }

  // Filter available tools based on disallowed list
  const allowedAvailableTools = filteredAvailableTools.filter(
    tool => !disallowedToolSet.has(tool.name),
  )

  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools,
    }
  }

  const availableToolMap = new Map<string, Tool>()
  for (const tool of allowedAvailableTools) {
    availableToolMap.set(tool.name, tool)
  }

  const validTools: string[] = []
  const invalidTools: string[] = []
  const resolved: Tool[] = []
  const resolvedToolsSet = new Set<Tool>()
  let allowedAgentTypes: string[] | undefined

  for (const { spec: toolSpec, toolName, ruleContent } of parsedSpecs) {
    // Special case: Agent tool carries allowedAgentTypes metadata in its spec
    if (toolName === AGENT_TOOL_NAME) {
      if (ruleContent) {
        // Parse comma-separated agent types: "worker, researcher" → ["worker", "researcher"]
        allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
      }
      // For sub-agents, Agent is excluded by filterToolsForAgent — mark the spec
      // valid for allowedAgentTypes tracking but skip tool resolution.
      if (!isMainThread) {
        validTools.push(toolSpec)
        continue
      }
      // For main thread, filtering was skipped so Agent is in availableToolMap —
      // fall through to normal resolution below.
    }

    // The two file-edit aliases are one capability under two provider names, so
    // a definition that asks for either gets whichever one this pool carries.
    // Without this, an agent whose `tools` list says Edit resolves to nothing on
    // the OpenAI path and silently loses the ability to edit at all — the same
    // defect the async allowlist had, one layer down.
    const aliasSibling = PROVIDER_FILE_EDIT_TOOL_ALIASES.includes(
      toolName as (typeof PROVIDER_FILE_EDIT_TOOL_ALIASES)[number],
    )
      ? PROVIDER_FILE_EDIT_TOOL_ALIASES.find(name => name !== toolName)
      : undefined
    const tool =
      availableToolMap.get(toolName) ??
      (aliasSibling ? availableToolMap.get(aliasSibling) : undefined)
    if (tool) {
      validTools.push(toolSpec)
      if (!resolvedToolsSet.has(tool)) {
        resolved.push(tool)
        resolvedToolsSet.add(tool)
      }
    } else {
      invalidTools.push(toolSpec)
    }
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools: resolved,
    allowedAgentTypes,
  }
}

/**
 * Which continuation tools the CURRENT invoker of Agent can actually call —
 * derived from the exact resolved tool array used to build this invocation's
 * prompt/API tool definitions (never the unfiltered parent pool). Drives
 * both prompt guidance (getPrompt) and result-trailer wording
 * (mapToolResultToToolResultBlockParam) so neither ever advertises a tool
 * this context doesn't have.
 */
export type AgentContinuationCapabilities = {
  canSendMessage: boolean
  canResumeAgent: boolean
  canSpawnAgent: boolean
  canStopTask: boolean
}

export function getAgentContinuationCapabilities(
  tools: Tools,
): AgentContinuationCapabilities {
  return {
    canSendMessage: tools.some(tool =>
      toolMatchesName(tool, SEND_MESSAGE_TOOL_NAME),
    ),
    canResumeAgent: tools.some(tool =>
      toolMatchesName(tool, RESUME_AGENT_TOOL_NAME),
    ),
    canSpawnAgent: tools.some(tool => toolMatchesName(tool, AGENT_TOOL_NAME)),
    canStopTask: tools.some(tool =>
      toolMatchesName(tool, TASK_STOP_TOOL_NAME),
    ),
  }
}

/**
 * Intersected onto synchronous and asynchronous local-agent result types.
 * Optional so historical (already-persisted) results without the field
 * render conservatively — no continuation call literal — rather than
 * guessing capability from context that no longer exists.
 */
export type AgentContinuationMetadata = {
  continuationCapabilities?: AgentContinuationCapabilities
}

export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    // Optional: older persisted sessions won't have this (resume replays
    // results verbatim without re-validation). Used to gate the sync
    // result trailer — one-shot built-ins skip the SendMessage hint.
    agentType: z.string().optional(),
    // Optional friendly name for the subagent. Prefer this for user-facing
    // continuation hints; raw agentId remains the durable fallback.
    agentName: z.string().optional(),
    // Optional: the resolved model name used by the subagent. Older
    // persisted sessions won't have this field.
    model: z.string().optional(),
    // Optional: the Codex account this subagent leased, captured while the
    // lease was still alive. A live read of the lease plane cannot answer this
    // after the fact — `releaseCodexLease` deletes the entry at every terminal —
    // so the account is carried here or it is unknowable. Absent for an
    // Anthropic-path subagent (no lease exists) and for sessions persisted
    // before this field.
    account: z
      .object({ accountId: z.string(), accountAlias: z.string().nullable() })
      .optional(),
    changedFiles: z
      .array(
        z.object({
          path: z.string(),
          op: z.string(),
          ok: z.boolean(),
          error: z.string().optional(),
        }),
      )
      .optional(),
    changedFilesTruncated: z.number().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    // Set when the subagent's final assistant message was a synthetic API
    // error (e.g. prompt-too-long from query.ts blocking-limit preempt).
    // Surfaces the failure to the AgentTool sync/async paths so they can
    // record `failed`/`completed_with_error` instead of `completed`.
    error: z.string().optional(),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    usage: z
      .object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_creation_input_tokens: z.number().nullable(),
        cache_read_input_tokens: z.number().nullable(),
        server_tool_use: z
          .object({
            web_search_requests: z.number(),
            web_fetch_requests: z.number(),
          })
          .nullable(),
        service_tier: z.enum(['standard', 'priority', 'batch']).nullable(),
        cache_creation: z
          .object({
            ephemeral_1h_input_tokens: z.number(),
            ephemeral_5m_input_tokens: z.number(),
          })
          .nullable(),
      })
      .optional(),
  }),
)

export type AgentToolResult = z.input<
  ReturnType<typeof agentToolResultSchema>
> &
  AgentContinuationMetadata

export function getForkWorkerResultOutputFormat(): BetaJSONOutputFormat {
  return {
    type: 'json_schema',
    schema: getForkWorkerResultJsonSchema(),
  }
}

export function formatForkWorkerResultForNotification(text: string, provider: string): string {
  const parsed = parseForkWorkerResult(safeParseJSON(text.trim()))
  return provider === 'openai'
    ? serializeForkWorkerResultForOpenAI(parsed)
    : serializeForkWorkerResultForClaude(parsed)
}

export function countToolUses(messages: MessageType[]): number {
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') {
          count++
        }
      }
    }
  }
  return count
}

const MAX_CHANGED_FILE_ENTRIES = 200
const EDITING_TOOL_NAMES = new Set([
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_PATCH_TOOL_NAME,
])

type ChangedFileEntry = {
  path: string
  op: string
  ok: boolean
  error?: string
}

type ToolResultInfo = {
  isError: boolean
  text?: string
}

const MAX_CHANGED_FILE_ERROR_LENGTH = 160

function summarizeChangedFileError(text: string | undefined): string {
  if (!text) return 'tool returned an error'
  const summary = text.split('\n')[0]!.replace(/\s+/g, ' ').trim()
  if (!summary) return 'tool returned an error'
  return summary.length > MAX_CHANGED_FILE_ERROR_LENGTH
    ? `${summary.slice(0, MAX_CHANGED_FILE_ERROR_LENGTH - 1)}…`
    : summary
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined

  const text = content
    .map(block => {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return block.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')

  return text || undefined
}

function collectToolResults(messages: MessageType[]): Map<string, ToolResultInfo> {
  const results = new Map<string, ToolResultInfo>()
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue
      results.set(block.tool_use_id, {
        isError: block.is_error === true,
        text: toolResultText(block.content),
      })
    }
  }
  return results
}

function pathsForEditingTool(toolName: string, input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []

  if (toolName === FILE_EDIT_TOOL_NAME || toolName === FILE_WRITE_TOOL_NAME) {
    const filePath = (input as { file_path?: unknown }).file_path
    return typeof filePath === 'string' ? [filePath] : []
  }

  if (toolName !== FILE_PATCH_TOOL_NAME) return []

  const patchInput = input as {
    ops?: Array<{ path?: unknown; moveTo?: unknown }>
    input?: unknown
  }
  if (Array.isArray(patchInput.ops)) {
    const paths: string[] = []
    for (const op of patchInput.ops) {
      if (typeof op.path === 'string') paths.push(op.path)
      if (typeof op.moveTo === 'string') paths.push(op.moveTo)
    }
    return paths
  }

  if (typeof patchInput.input !== 'string') return []
  const paths: string[] = []
  for (const match of patchInput.input.matchAll(
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
  )) {
    const path = match[1]?.trim()
    if (path) paths.push(path)
  }
  for (const match of patchInput.input.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
    const path = match[1]?.trim()
    if (path) paths.push(path)
  }
  return paths
}

function collectChangedFiles(messages: MessageType[]): {
  changedFiles: ChangedFileEntry[]
  changedFilesTruncated?: number
} {
  const toolResults = collectToolResults(messages)
  const entries: ChangedFileEntry[] = []
  let omitted = 0

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_use' || !EDITING_TOOL_NAMES.has(block.name)) {
        continue
      }

      const paths = pathsForEditingTool(block.name, block.input)
      const result = toolResults.get(block.id)
      const ok = result ? !result.isError : false
      const error = result
        ? result.isError
          ? summarizeChangedFileError(result.text)
          : undefined
        : 'tool did not return a result'

      for (const path of paths) {
        if (entries.length >= MAX_CHANGED_FILE_ENTRIES) {
          omitted++
          continue
        }
        entries.push({
          path,
          op: block.name,
          ok,
          ...(error ? { error } : {}),
        })
      }
    }
  }

  return {
    changedFiles: entries,
    ...(omitted > 0 ? { changedFilesTruncated: omitted } : {}),
  }
}

/**
 * Returns the failure text for a run that exhausted its turn budget, or
 * undefined if it did not. Narrows at runtime: AttachmentMessage.attachment is
 * typed `unknown`, so the shape is checked rather than asserted.
 */
function findMaxTurnsReached(agentMessages: MessageType[]): string | undefined {
  for (const message of agentMessages) {
    if (message?.type !== 'attachment') continue
    const attachment = message.attachment
    if (
      typeof attachment !== 'object' ||
      attachment === null ||
      (attachment as { type?: unknown }).type !== 'max_turns_reached'
    ) {
      continue
    }
    const maxTurns = (attachment as { maxTurns?: unknown }).maxTurns
    return `Reached maximum number of turns (${typeof maxTurns === 'number' ? maxTurns : 'unknown'})`
  }
  return undefined
}

export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    agentName?: string
    isAsync: boolean
    totalTokensOverride?: number
    continuationCapabilities?: AgentContinuationCapabilities
    /**
     * The Codex account this run leased, snapshotted by the caller while the
     * lease was alive. Passed in rather than read here: by the time a result is
     * finalized the lease is already released on some paths, so only the caller
     * knows a moment at which the answer still exists.
     */
    account?: CodexLeaseAccount
  },
): AgentToolResult {
  const {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent,
    startTime,
    agentType,
    agentName,
    isAsync,
    totalTokensOverride,
    continuationCapabilities,
    account,
  } = metadata

  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }

  // Detect synthetic API-error terminals (e.g. blocking-limit preempt in
  // query.ts:682-687, which yields an isApiErrorMessage assistant and
  // returns reason='blocking_limit'). Without this check, the synthetic
  // "Prompt is too long" text would become the subagent's apparent output
  // and the tool result would surface as a normal completion.
  const isApiErrorTerminal = lastAssistantMessage.isApiErrorMessage === true
  const apiErrorText = isApiErrorTerminal
    ? extractTextContent(lastAssistantMessage.message.content, '\n')
    : undefined

  // A run that burned its turn budget stopped short of its objective, so it is
  // a failure even though the last assistant message looks ordinary. query.ts
  // signals this with a max_turns_reached attachment; QueryEngine.ts turns the
  // same signal into subtype:'error_max_turns'. Reported as `error` (the only
  // failure discriminator callers have) while keeping the partial text as
  // content, so the parent still sees how far the agent got.
  const maxTurnsText = findMaxTurnsReached(agentMessages)
  const terminalError = apiErrorText ?? maxTurnsText

  // Extract text content from the agent's response. If the final assistant
  // message is a pure tool_use block (loop exited mid-turn), fall back to
  // the most recent assistant message that has text content. When the
  // terminal is a synthetic API error, skip it entirely (and skip any
  // earlier API-error messages too) so partial work from the subagent's
  // real turns is what's reported, not the error string.
  let content = isApiErrorTerminal
    ? []
    : lastAssistantMessage.message.content.filter(_ => _.type === 'text')
  if (content.length === 0) {
    for (let i = agentMessages.length - 1; i >= 0; i--) {
      const m = agentMessages[i]!
      if (m.type !== 'assistant') continue
      if (m.isApiErrorMessage === true) continue
      const textBlocks = m.message.content.filter(_ => _.type === 'text')
      if (textBlocks.length > 0) {
        content = textBlocks
        break
      }
    }
  }

  // Report 3.5 instrumentation: usage is written back by mutation after
  // content_block_stop (see src/services/api/claude.ts:2332-2350). If finalize
  // fires in that window the message exists with no usage and the downstream
  // getDisplayedTokenCountFromUsage call hits `undefined is not an object
  // (evaluating 'O.input_tokens')`. Log before the access so we know which
  // callsite fired during an incident.
  if (!lastAssistantMessage.message.usage) {
    const contentTypes = lastAssistantMessage.message.content
      .map(c => c.type)
      .join(',')
    logForDebugging(
      `[agent-tool] finalize_missing_usage agent_type=${agentType} ` +
      `last_msg_stop_reason=${lastAssistantMessage.message.stop_reason ?? 'null'} ` +
      `content_types=${contentTypes} total_msgs=${agentMessages.length}`,
      { level: 'warn' },
    )
  }
  const totalTokens = lastAssistantMessage.message.usage
    ? getTokenCountFromUsage(lastAssistantMessage.message.usage)
    : (totalTokensOverride ?? 0)
  const totalToolUseCount = countToolUses(agentMessages)
  const { changedFiles, changedFilesTruncated } = collectChangedFiles(agentMessages)

  logEvent('tengu_agent_tool_completed', {
    agent_type:
      agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_char_count: prompt.length,
    response_char_count: content.length,
    assistant_message_count: agentMessages.length,
    total_tool_uses: totalToolUseCount,
    duration_ms: Date.now() - startTime,
    total_tokens: totalTokens,
    is_built_in_agent: isBuiltInAgent,
    is_async: isAsync,
  })

  // Signal to inference that this subagent's cache chain can be evicted.
  const lastRequestId = lastAssistantMessage.requestId
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'subagent_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  return {
    agentId,
    agentType,
    ...(agentName ? { agentName } : {}),
    ...(continuationCapabilities ? { continuationCapabilities } : {}),
    model: resolvedAgentModel,
    ...(account ? { account } : {}),
    changedFiles,
    ...(changedFilesTruncated !== undefined ? { changedFilesTruncated } : {}),
    content,
    ...(terminalError !== undefined ? { error: terminalError } : {}),
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    totalToolUseCount,
    usage: lastAssistantMessage.message.usage,
  }
}

/**
 * Returns the name of the last tool_use block in an assistant message,
 * or undefined if the message is not an assistant message with tool_use.
 */
export function getLastToolUseName(message: MessageType): string | undefined {
  if (message.type !== 'assistant') return undefined
  const block = message.message.content.findLast(b => b.type === 'tool_use')
  return block?.type === 'tool_use' ? block.name : undefined
}

export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string,
): void {
  const progress = getProgressUpdate(tracker)
  emitTaskProgressEvent({
    taskId,
    toolUseId,
    description: progress.lastActivity?.activityDescription ?? description,
    startTime,
    totalTokens: progress.tokenCount,
    toolUses: progress.toolUseCount,
    lastToolName,
  })
}

export async function classifyHandoffIfNeeded({
  agentMessages,
  tools,
  toolPermissionContext,
  abortSignal,
  subagentType,
  totalToolUseCount,
}: {
  agentMessages: MessageType[]
  tools: Tools
  toolPermissionContext: AppState['toolPermissionContext']
  abortSignal: AbortSignal
  subagentType: string
  totalToolUseCount: number
}): Promise<string | null> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (toolPermissionContext.mode !== 'auto') return null

    const agentTranscript = buildTranscriptForClassifier(agentMessages, tools)
    if (!agentTranscript) return null

    const classifierResult = await classifyYoloAction(
      agentMessages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: "Sub-agent has finished and is handing back control to the main agent. Review the sub-agent's work based on the block rules and let the main agent know if any file is dangerous (the main agent will see the reason).",
          },
        ],
      },
      tools,
      toolPermissionContext as ToolPermissionContext,
      abortSignal,
    )

    const handoffDecision = classifierResult.unavailable
      ? 'unavailable'
      : classifierResult.shouldBlock
        ? 'blocked'
        : 'allowed'
    logEvent('tengu_auto_mode_decision', {
      decision:
        handoffDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName:
        // Use legacy name for analytics continuity across the Task→Agent rename
        LEGACY_AGENT_TOOL_NAME as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inProtectedNamespace: isInProtectedNamespace(),
      classifierModel:
        classifierResult.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agentType:
        subagentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolUseCount: totalToolUseCount,
      isHandoff: true,
      // For handoff, the relevant agent completion is the subagent's final
      // assistant message — the last thing the classifier transcript shows
      // before the handoff review prompt.
      agentMsgId: getLastAssistantMessage(agentMessages)?.message
        .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage:
        classifierResult.stage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1RequestId:
        classifierResult.stage1RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1MsgId:
        classifierResult.stage1MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2RequestId:
        classifierResult.stage2RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2MsgId:
        classifierResult.stage2MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    if (classifierResult.shouldBlock) {
      // When classifier is unavailable, still propagate the sub-agent's
      // results but with a warning so the parent agent can verify the work.
      if (classifierResult.unavailable) {
        logForDebugging(
          'Handoff classifier unavailable, allowing sub-agent output with warning',
          { level: 'warn' },
        )
        return `Note: The safety classifier was unavailable when reviewing this sub-agent's work. Please carefully verify the sub-agent's actions and output before acting on them.`
      }

      logForDebugging(
        `Handoff classifier flagged sub-agent output: ${classifierResult.reason}`,
        { level: 'warn' },
      )
      return `SECURITY WARNING: This sub-agent performed actions that may violate security policy. Reason: ${classifierResult.reason}. Review the sub-agent's actions carefully before acting on its output.`
    }
  }

  return null
}

/**
 * Extract a partial result string from an agent's accumulated messages.
 * Used when an async agent is killed to preserve what it accomplished.
 * Returns undefined if no text content is found.
 */
export function extractPartialResult(
  messages: MessageType[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const text = extractTextContent(m.message.content, '\n')
    if (text) {
      return text
    }
  }
  return undefined
}

type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * Drives a background agent from spawn to terminal notification.
 * Shared between AgentTool's async-from-start path and resumeAgentBackground.
 */
export async function runAsyncAgentLifecycle({
  taskId,
  abortController,
  makeStream,
  metadata,
  description,
  toolUseContext,
  rootSetAppState,
  agentIdForCleanup,
  enableSummarization,
  getWorktreeResult,
  formatFinalMessage,
  parentTranscriptPath,
  parentSessionId,
  sessionStateTracking,
}: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams: ((p: CacheSafeParams) => void) | undefined,
  ) => AsyncGenerator<MessageType, void>
  metadata: Parameters<typeof finalizeAgentTool>[2]
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
  formatFinalMessage?: (message: string) => string
  /** Parent session transcript path, captured at spawn time. Must be passed
   * explicitly rather than computed lazily via getTranscriptPath() because
   * the async lifecycle runs after bootstrap state may have shifted. */
  parentTranscriptPath: string
  /** Parent session ID captured at spawn time. Must be passed explicitly for
   * the same reason as parentTranscriptPath. */
  parentSessionId: string
  /** Durable coordinator tracking context. When omitted, terminal recording
   * must not create coordinator state for ordinary subagents. */
  sessionStateTracking?: {
    mode: string
    statePath?: string
  }
}): Promise<void> {
  let stopSummarization: (() => void) | undefined
  const agentMessages: MessageType[] = []
  const tracker = createProgressTracker()
  try {
    const resolveActivity = createActivityDescriptionResolver(
      toolUseContext.options.tools,
    )
    const onCacheSafeParams = enableSummarization
      ? (params: CacheSafeParams) => {
          const { stop } = startAgentSummarization(
            taskId,
            asAgentId(taskId),
            params,
            rootSetAppState,
          )
          stopSummarization = stop
        }
      : undefined
    for await (const message of makeStream(onCacheSafeParams)) {
      agentMessages.push(message)
      // Append immediately when UI holds the task (retain). Bootstrap reads
      // disk in parallel and UUID-merges the prefix — disk-write-before-yield
      // means live is always a suffix of disk, so merge is order-correct.
      rootSetAppState(prev => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || !t.retain) return prev
        const base = t.messages ?? []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...t, messages: [...base, message] },
          },
        }
      })
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      updateAsyncAgentProgress(
        taskId,
        getProgressUpdate(tracker),
        rootSetAppState,
      )
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          lastToolName,
        )
      }
    }

    stopSummarization?.()

    // Read while the lease is still alive: `completeAgentTask`/`failAgentTask`
    // below release it, and the release DELETES the entry. Reaches the stored
    // task result (TaskOutput, the resumed-run card), NOT the launch record,
    // whose account was stamped on its acknowledgment at dispatch.
    // Gated on the worker's own model AND its own provider, like every other
    // capture (`reportableAccount`, `registerWorkerCodexLease`). Both arguments
    // are load-bearing: a non-gpt model leaves routing to the base provider,
    // and omitting it falls back to the process-global session provider, which
    // is the PARENT's. A gpt worker's background child runs on
    // mainLoopProvider='openai' with a Claude model while the session sits on
    // Anthropic, so the global answer drops a lease the child really spent.
    // Registration is gated the same way, so an Anthropic worker holds nothing
    // to report; this stays as the gate on the CLAIM, since naming an account
    // the run never touched is the failure that counts.
    const terminalAccount =
      resolveRequestProvider(
        metadata.resolvedAgentModel,
        toolUseContext.options.mainLoopProvider,
      ) === 'openai'
        ? snapshotLeaseAccount(taskId)
        : undefined
    const agentResult = finalizeAgentTool(agentMessages, taskId, {
      ...metadata,
      totalTokensOverride: getTokenCountFromTracker(tracker),
      ...(terminalAccount ? { account: terminalAccount } : {}),
    })

    // Mark task completed FIRST so TaskOutput(block=true) unblocks
    // immediately. classifyHandoffIfNeeded (API call) and getWorktreeResult
    // (git exec) are notification embellishments that can hang — they must
    // not gate the status transition (gh-20236).
    //
    // If the subagent ended with a synthetic API-error terminal (e.g.
    // prompt-too-long blocking-limit preempt), surface it as failed rather
    // than completed so the parent sees what happened and partial work is
    // preserved through the failure notification.
    if (agentResult.error) {
      const apiErrorMsg = agentResult.error
      failAsyncAgent(taskId, apiErrorMsg, rootSetAppState)
      appendSubagentTerminal(parentTranscriptPath, {
        sessionId: parentSessionId,
        agentId: asAgentId(taskId),
        toolUseId: toolUseContext.toolUseId,
        status: 'failed',
        reason: apiErrorMsg,
        durationMs: Date.now() - metadata.startTime,
        endedAt: new Date().toISOString(),
      })
      await recordWorkerSessionTerminal({
        sessionId: parentSessionId,
        agentId: taskId,
        status: 'failed',
        createStateIfMissing: sessionStateTracking,
      }).catch(_err =>
        logForDebugging(`Failed to record worker failure: ${_err}`),
      )
      unregisterActiveSubagent(taskId)

      let finalMessage = extractTextContent(agentResult.content, '\n')
      if (formatFinalMessage && finalMessage.trim()) {
        finalMessage = formatFinalMessage(finalMessage)
      }

      const worktreeResult = await getWorktreeResult()
      enqueueAgentNotification({
        taskId,
        description,
        status: 'failed',
        error: apiErrorMsg,
        setAppState: rootSetAppState,
        finalMessage,
        usage: {
          totalTokens: getTokenCountFromTracker(tracker),
          toolUses: agentResult.totalToolUseCount,
          durationMs: agentResult.totalDurationMs,
        },
        toolUseId: toolUseContext.toolUseId,
        ...worktreeResult,
      })
      return
    }

    completeAsyncAgent(agentResult, rootSetAppState)

    appendSubagentTerminal(parentTranscriptPath, {
      sessionId: parentSessionId,
      agentId: asAgentId(taskId),
      toolUseId: toolUseContext.toolUseId,
      status: 'completed',
      durationMs: Date.now() - metadata.startTime,
      endedAt: new Date().toISOString(),
    })
    await recordWorkerSessionTerminal({
      sessionId: parentSessionId,
      agentId: taskId,
      status: 'completed',
      createStateIfMissing: sessionStateTracking,
    }).catch(_err =>
      logForDebugging(`Failed to record worker completion: ${_err}`),
    )
    unregisterActiveSubagent(taskId)

    let finalMessage = extractTextContent(agentResult.content, '\n')
    if (formatFinalMessage && finalMessage.trim()) {
      finalMessage = formatFinalMessage(finalMessage)
    }

    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const handoffWarning = await classifyHandoffIfNeeded({
        agentMessages,
        tools: toolUseContext.options.tools,
        toolPermissionContext:
          toolUseContext.getAppState().toolPermissionContext,
        abortSignal: abortController.signal,
        subagentType: metadata.agentType,
        totalToolUseCount: agentResult.totalToolUseCount,
      })
      if (handoffWarning) {
        finalMessage = `${handoffWarning}\n\n${finalMessage}`
      }
    }

    const worktreeResult = await getWorktreeResult()

    enqueueAgentNotification({
      taskId,
      description,
      status: 'completed',
      setAppState: rootSetAppState,
      finalMessage,
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: agentResult.totalToolUseCount,
        durationMs: agentResult.totalDurationMs,
      },
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } catch (error) {
    stopSummarization?.()
    if (error instanceof AbortError) {
      // killAsyncAgent is a no-op if TaskStop already set status='killed' —
      // but only this catch handler has agentMessages, so the notification
      // must fire unconditionally. Transition status BEFORE worktree cleanup
      // so TaskOutput unblocks even if git hangs (gh-20236).
      killAsyncAgent(taskId, rootSetAppState)
      logEvent('tengu_agent_tool_terminated', {
        agent_type:
          metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: Date.now() - metadata.startTime,
        is_async: true,
        is_built_in_agent: metadata.isBuiltInAgent,
        reason:
          'user_kill_async' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      appendSubagentTerminal(parentTranscriptPath, {
        sessionId: parentSessionId,
        agentId: asAgentId(taskId),
        toolUseId: toolUseContext.toolUseId,
        status: 'killed',
        durationMs: Date.now() - metadata.startTime,
        endedAt: new Date().toISOString(),
      })
      await recordWorkerSessionTerminal({
        sessionId: parentSessionId,
        agentId: taskId,
        status: 'killed',
        createStateIfMissing: sessionStateTracking,
      }).catch(_err =>
      logForDebugging(`Failed to record worker kill: ${_err}`),
      )
      unregisterActiveSubagent(taskId)
      const worktreeResult = await getWorktreeResult()
      const partialResult = extractPartialResult(agentMessages)
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult,
        usage: {
          totalTokens: getTokenCountFromTracker(tracker),
          toolUses: tracker.toolUseCount,
          durationMs: Date.now() - metadata.startTime,
        },
        ...worktreeResult,
      })
      return
    }
    const msg = errorMessage(error)
    failAsyncAgent(taskId, msg, rootSetAppState)
    appendSubagentTerminal(parentTranscriptPath, {
      sessionId: parentSessionId,
      agentId: asAgentId(taskId),
      toolUseId: toolUseContext.toolUseId,
      status: 'failed',
      reason: msg,
      durationMs: Date.now() - metadata.startTime,
      endedAt: new Date().toISOString(),
    })
    await recordWorkerSessionTerminal({
      sessionId: parentSessionId,
      agentId: taskId,
      status: 'failed',
      createStateIfMissing: sessionStateTracking,
    }).catch(_err =>
      logForDebugging(`Failed to record worker failure: ${_err}`),
    )
    unregisterActiveSubagent(taskId)
    const worktreeResult = await getWorktreeResult()
    const partialResult = extractPartialResult(agentMessages)
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: msg,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
      finalMessage: partialResult,
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: tracker.toolUseCount,
        durationMs: Date.now() - metadata.startTime,
      },
      ...worktreeResult,
    })
  } finally {
    clearInvokedSkillsForAgent(agentIdForCleanup)
    clearDumpState(agentIdForCleanup)
  }
}
