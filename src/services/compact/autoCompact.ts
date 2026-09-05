import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'
import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas, getSessionId } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  formatContextWindowProvenance,
  resolveContextWindowPolicy,
} from '../../utils/contextWindowPolicy.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage, isAbortError } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { executePreCompactHooks } from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { roughTokenCountEstimationForContent } from '../tokenEstimation.js'
import { getCodexLeaseExhaustedMessage } from '../api/codexAccountLeaseManager.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_USER_ABORT,
  mergeHookInstructions,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

/**
 * The window every threshold below is derived from: the model's advertised
 * window, narrowed by the account's long-context entitlement, then by operator
 * configuration, then by the output capacity a summary response needs.
 *
 * `resolveContextWindowPolicy` owns the four notions and the reason for each
 * step between them (`utils/contextWindowPolicy.ts`). Read the policy directly
 * when you need to say WHY a session's budget is what it is; this returns only
 * the number.
 */
export function getEffectiveContextWindowSize(model: string): number {
  return resolveContextWindowPolicy(model, getSdkBetas()).effective
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used as a circuit breaker to stop retrying when the context is
  // irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
}

/**
 * Codex's own recommended auto-compact limit for GPT-5.6 Sol
 * (`model_auto_compact_token_limit = 900000`, paired with its 1M window).
 *
 * This is a CEILING, never a floor. The buffer math below lands near 927,000 at
 * a full 1M window, so Sol normally compacts here instead; but any narrower
 * effective window — an operator ceiling, CLAUDE_CODE_AUTO_COMPACT_WINDOW, a
 * latched entitlement refusal — still wins, because a threshold above the
 * window a session can actually spend would never fire.
 */
export const GPT_5_6_SOL_AUTOCOMPACT_THRESHOLD = 900_000

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
export const MIN_AUTOCOMPACT_RECOVERY_WINDOW_TOKENS =
  AUTOCOMPACT_BUFFER_TOKENS - MANUAL_COMPACT_BUFFER_TOKENS
export const AUTOCOMPACT_RECOVERY_WINDOW_PERCENTAGE = 0.08
export const MAX_AUTOCOMPACT_RECOVERY_WINDOW_TOKENS = 50_000

// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

function getAutoCompactScopeId(toolUseContext: ToolUseContext): string {
  return toolUseContext.agentId ?? getSessionId()
}

export function getPersistedAutoCompactTracking(
  toolUseContext: ToolUseContext,
): AutoCompactTrackingState | undefined {
  const failuresByScope =
    toolUseContext.getAppState().autoCompactConsecutiveFailuresByScope ??
    new Map<string, number>()
  const consecutiveFailures =
    failuresByScope.get(getAutoCompactScopeId(toolUseContext))

  if (consecutiveFailures === undefined) {
    return undefined
  }

  return {
    compacted: false,
    turnCounter: 0,
    turnId: '',
    consecutiveFailures,
  }
}

export function setPersistedAutoCompactConsecutiveFailures(
  toolUseContext: ToolUseContext,
  consecutiveFailures: number | undefined,
): void {
  const setAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const scopeId = getAutoCompactScopeId(toolUseContext)
  const normalizedFailures =
    consecutiveFailures !== undefined && consecutiveFailures > 0
      ? consecutiveFailures
      : undefined

  setAppState(prev => {
    const prevFailuresByScope =
      prev.autoCompactConsecutiveFailuresByScope ?? new Map<string, number>()
    const prevFailures = prevFailuresByScope.get(scopeId)

    if (prevFailures === normalizedFailures) {
      return prev
    }

    const nextFailuresByScope = new Map(prevFailuresByScope)

    if (normalizedFailures === undefined) {
      nextFailuresByScope.delete(scopeId)
    } else {
      nextFailuresByScope.set(scopeId, normalizedFailures)
    }

    return {
      ...prev,
      autoCompactConsecutiveFailuresByScope: nextFailuresByScope,
    }
  })
}

function isTransientAutoCompactFailure(error: unknown): boolean {
  if (
    isAbortError(error) ||
    hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT) ||
    hasExactErrorMessage(error, ERROR_MESSAGE_INCOMPLETE_RESPONSE)
  ) {
    return true
  }

  if (
    error instanceof APIConnectionTimeoutError ||
    error instanceof APIConnectionError
  ) {
    return true
  }

  if (error instanceof APIError) {
    if (
      error.status === 429 ||
      error.status === 529 ||
      (error.status !== undefined && error.status >= 500)
    ) {
      return true
    }

    if (error.message?.includes('"type":"overloaded_error"')) {
      return true
    }
  }

  return (
    error instanceof Error &&
    error.message.includes(getCodexLeaseExhaustedMessage())
  )
}

function notifyAutoCompactCircuitBreaker(toolUseContext: ToolUseContext): void {
  const text =
    'Auto-compact failed repeatedly and stopped retrying automatically. Run /compact manually if context keeps growing.'

  toolUseContext.addNotification?.({
    key: 'autocompact-circuit-breaker',
    text,
    color: 'warning',
    priority: 'immediate',
    timeoutMs: 12000,
  })
}

export function getAutoCompactRecoveryWindowTokens(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const scaledWindow = Math.floor(
    effectiveContextWindow * AUTOCOMPACT_RECOVERY_WINDOW_PERCENTAGE,
  )
  return Math.max(
    MIN_AUTOCOMPACT_RECOVERY_WINDOW_TOKENS,
    Math.min(MAX_AUTOCOMPACT_RECOVERY_WINDOW_TOKENS, scaledWindow),
  )
}

export function getAutoCompactBufferTokens(model: string): number {
  return (
    MANUAL_COMPACT_BUFFER_TOKENS + getAutoCompactRecoveryWindowTokens(model)
  )
}

/**
 * The model's own recommended compaction limit, or Infinity when it has none.
 * Keyed on canonical identity so a dated or provider-prefixed Sol id resolves
 * the same way, and so no display label can decide a token budget.
 */
function getModelAutoCompactCeiling(model: string): number {
  return getCanonicalName(model) === 'gpt-5.6-sol'
    ? GPT_5_6_SOL_AUTOCOMPACT_THRESHOLD
    : Number.POSITIVE_INFINITY
}

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  const autocompactThreshold = Math.min(
    effectiveContextWindow - getAutoCompactBufferTokens(model),
    getModelAutoCompactCeiling(model),
  )

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

export function getBlockingLimit(model: string): number {
  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  return !isNaN(parsedOverride) && parsedOverride > 0
    ? parsedOverride
    : defaultBlockingLimit
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  const percentLeft = Math.max(
    0,
    Math.round(((threshold - tokenUsage) / threshold) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const blockingLimit = getBlockingLimit(model)

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

/**
 * Tool schemas reach the wire as dense JSON — {"name":…,"description":…,
 * "input_schema":{…}} — so they take the estimator's structured band rather than
 * its prose default. tokenEstimation.ts's 2026-08-10 calibration measured dense
 * JSON at 3.07-3.64 chars/token and prices structured payloads at 3. The
 * descriptions inside a schema are English prose (5-6 chars/token), so 3 stays
 * on the conservative side of a real schema blob without doubling it the way the
 * JSON file-type ratio (2, bytesPerTokenForFileType) would — and this number
 * only ever pulls autocompact EARLIER, so a 2x overshoot would compact live work
 * away for nothing.
 */
const TOOL_SCHEMA_CHARS_PER_TOKEN = 3

/**
 * Rendered tool schemas are session-stable by design — utils/toolSchemaCache.ts
 * locks their bytes at first render so a mid-session GrowthBook flip cannot bust
 * the prompt cache — so re-serializing every tool on every turn buys nothing.
 * The memo key is the tool set itself, because that is the one thing that does
 * change mid-session: deferred-tool discovery grows `tools`, and MCP reconnects
 * add or drop names. Model and provider are in the key too (openai renames
 * schema properties).
 *
 * A map rather than a single slot because several tool sets are live at once in
 * one process: subagents carry their own, and the compact and session-memory
 * forks run with the parent's. A single slot would be invalidated by every
 * alternation and re-serialize the whole tool block each turn — the opposite of
 * what memoizing is for. The cap keeps a long session with churning MCP servers
 * from growing it without bound; a wipe just costs one re-measurement.
 */
const MAX_TOOL_SCHEMA_TOKEN_MEMO_ENTRIES = 8
const toolSchemaTokensMemo = new Map<string, number>()

export function _resetToolSchemaTokensMemoForTest(): void {
  toolSchemaTokensMemo.clear()
}

/**
 * Rough token count for the tool block this request will carry, built from the
 * same `toolToAPISchema` the request path itself uses (claude.ts:1364-1374) so
 * the bytes counted are the bytes sent.
 *
 * Deferred tools are excluded whenever tool search MIGHT be on: under tool
 * search, claude.ts:1281-1289 sends a deferred tool only once the model has
 * discovered it, so counting the whole MCP pool would invent tens of thousands
 * of tokens in exactly the sessions this measurement exists for. The optimistic
 * gate can say "maybe" where the real gate later says no; over-skipping only
 * drags the measurement back toward NON_MESSAGE_REQUEST_OVERHEAD_TOKENS, which
 * is where this code path started, whereas over-counting compacts for nothing.
 *
 * Imported dynamically: this module is pulled in by StatusLine/REPL-level code,
 * and utils/api.js reaches getTools() and the MCP client at module init.
 */
async function measureToolSchemaTokens(
  toolUseContext: ToolUseContext,
  model: string,
): Promise<number> {
  const { isToolSearchEnabledOptimistic } = await import(
    '../../utils/toolSearch.js'
  )
  const { isDeferredTool } = await import(
    '../../tools/ToolSearchTool/prompt.js'
  )
  const allTools = toolUseContext.options.tools
  const mayDefer = isToolSearchEnabledOptimistic()
  const sentTools = mayDefer
    ? allTools.filter(tool => !isDeferredTool(tool))
    : allTools
  const provider = toolUseContext.options.mainLoopProvider
  const key = `${model}|${provider ?? 'default'}|${mayDefer}|${sentTools.length}|${sentTools
    .map(tool => tool.name)
    .join(',')}`
  const memoized = toolSchemaTokensMemo.get(key)
  if (memoized !== undefined) {
    return memoized
  }

  const { toolToAPISchema } = await import('../../utils/api.js')
  const agentDefinitions = toolUseContext.options.agentDefinitions
  const schemas = await Promise.all(
    sentTools.map(tool =>
      toolToAPISchema(tool, {
        // Same shape the query loop passes at query.ts:723-744.
        getToolPermissionContext: async () =>
          toolUseContext.getAppState().toolPermissionContext,
        // The full list, not the filtered one: ToolSearchTool's own prompt
        // enumerates every available MCP tool (claude.ts:1361-1363).
        tools: allTools,
        agents: agentDefinitions?.activeAgents ?? [],
        allowedAgentTypes: agentDefinitions?.allowedAgentTypes,
        model,
        provider,
      }),
    ),
  )
  const tokens = roughTokenCountEstimationForContent(
    jsonStringify(schemas),
    TOOL_SCHEMA_CHARS_PER_TOKEN,
  )
  if (toolSchemaTokensMemo.size >= MAX_TOOL_SCHEMA_TOKEN_MEMO_ENTRIES) {
    toolSchemaTokensMemo.clear()
  }
  toolSchemaTokensMemo.set(key, tokens)
  return tokens
}

/**
 * Measure the non-message content of the next request: system prompt, the
 * userContext/systemContext blocks, and the serialized tool schemas.
 *
 * This is the value tokenCountWithEstimation's NON_MESSAGE_REQUEST_OVERHEAD_TOKENS
 * floor stands in for when nobody can measure it. Deterministic, no API calls,
 * and bounded: everything but the tool schemas is a character count, and those
 * are memoized per tool set. Returns 0 — i.e. "use the floor" — if anything
 * throws, because a failed measurement must never take autocompact down with it.
 */
export async function measureNonMessageOverheadTokens(params: {
  model: string
  toolUseContext: ToolUseContext
  systemPrompt: readonly string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}): Promise<number> {
  try {
    const toolSchemaTokens = await measureToolSchemaTokens(
      params.toolUseContext,
      params.model,
    )
    // Both blocks are prose (CLAUDE.md files, env descriptions, git status), so
    // they take the estimator's default ratio, with its CJK escalation intact —
    // a Japanese CLAUDE.md is 1.3 chars/token, not 4.
    const systemPromptTokens = roughTokenCountEstimationForContent(
      params.systemPrompt.join('\n'),
    )
    const contextTokens = roughTokenCountEstimationForContent(
      [
        ...Object.entries(params.userContext),
        ...Object.entries(params.systemContext),
      ]
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n'),
    )
    return toolSchemaTokens + systemPromptTokens + contextTokens
  } catch (error) {
    logError(error)
    return 0
  }
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip drops messages and time-based microcompact content-clears old
  // tool_results, but both act on the request array only — the surviving
  // assistant's usage still reflects the pre-shrink context, so
  // tokenCountWithEstimation can't see the savings. Subtract the rough delta
  // those passes already computed.
  preRequestTokensFreed = 0,
  // Measured system prompt + userContext/systemContext + tool schemas for this
  // request, from measureNonMessageOverheadTokens. Only consumed when the count
  // falls back to a pure rough estimate, where it replaces the 20K floor if it
  // is larger. Absent (display callers, tests) keeps the floor.
  nonMessageOverheadTokens?: number,
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  if (!isAutoCompactEnabled()) {
    return false
  }

  // Pass the current request model so tokenCountWithEstimation invalidates a
  // gpt-produced usage anchor on a gpt→claude switch: the anchor reflects the
  // wire-truncated tool outputs the openai server billed, but a Claude request
  // sends the full transcript, so trusting it would fire autocompact late (or
  // let the first Claude call 413). See tokenCountWithEstimation's currentModel.
  const tokenCount =
    tokenCountWithEstimation(messages, model, nonMessageOverheadTokens) -
    preRequestTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const policy = resolveContextWindowPolicy(model, getSdkBetas())

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${policy.effective} ${formatContextWindowProvenance(policy)}${preRequestTokensFreed > 0 ? ` preRequestFreed=${preRequestTokensFreed}` : ''}${nonMessageOverheadTokens !== undefined ? ` nonMessageOverhead=${nonMessageOverheadTokens}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}

/**
 * Threshold-triggered prefix compaction: summarize the older prefix and keep
 * the newest complete API rounds verbatim.
 *
 * This is the NORMAL automatic path. compactConversation's full replacement is
 * the fallback, and the only failure that falls back to it is 'too_few_groups':
 * reactive needs two complete rounds to split, compactConversation needs none.
 * Every other failure means the summary request itself could not be served, and
 * a full compaction sends MORE than the prefix did — so those are thrown for
 * autoCompactIfNeeded's existing classifier to decide whether they burn
 * circuit-breaker budget, rather than paying for a second doomed API call.
 *
 * A preserved tail large enough to exceed the provider limit is rejected on
 * the immediate retry. The query recovery path then sees that the tail cannot
 * be prefix-split and runs full compaction within the same turn.
 *
 * PreCompact hooks run HERE, not inside reactiveCompactOnPromptTooLong: every
 * caller of that function runs them outside so it can merge the PreCompact
 * userDisplayMessage with the PostCompact one the call returns.
 * compactConversation runs its own (compact.ts:433-452), which is why the
 * fallback decision is taken by canPrefixCompact BEFORE any hook runs: a user's
 * PreCompact hook must fire once per compaction, not once per attempted path.
 *
 * require() rather than import: reactiveCompact imports isAutoCompactEnabled
 * from this module.
 */
async function tryReactivePrefixCompaction(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource: QuerySource | undefined,
): Promise<CompactionResult | null> {
  if (!feature('REACTIVE_COMPACT')) {
    return null
  }
  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    canPrefixCompact,
    isReactiveCompactEnabled,
    reactiveCompactOnPromptTooLong,
  } = require('./reactiveCompact.js') as typeof import('./reactiveCompact.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  if (!isReactiveCompactEnabled()) {
    return null
  }
  if (!canPrefixCompact(messages)) {
    logForDebugging(
      'autocompact: conversation too short to split — falling back to full compaction',
    )
    return null
  }

  toolUseContext.setSDKStatus?.('compacting')
  toolUseContext.onCompactProgress?.({
    type: 'hooks_start',
    hookType: 'pre_compact',
  })
  try {
    const hookResult = await executePreCompactHooks(
      { trigger: 'auto', customInstructions: null },
      toolUseContext.abortController.signal,
    )

    toolUseContext.setStreamMode?.('requesting')
    toolUseContext.setResponseLength?.(() => 0)
    toolUseContext.onCompactProgress?.({ type: 'compact_start' })

    const outcome = await reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParams,
      {
        customInstructions: mergeHookInstructions(
          undefined,
          hookResult.newCustomInstructions,
        ),
        trigger: 'auto',
        querySource,
      },
    )

    if (!outcome.ok) {
      // Defensive only: canPrefixCompact above already answered this for the
      // same messages, so reaching here would mean the two disagree.
      if (outcome.reason === 'too_few_groups') {
        return null
      }
      // An abort is the user's doing, so it reuses the message
      // isTransientAutoCompactFailure already classifies and spends no
      // circuit-breaker budget. 'exhausted' is the opposite: a conversation
      // the summary request itself cannot fit is precisely what the breaker
      // exists to stop retrying, so it must NOT be classified transient.
      if (outcome.reason === 'aborted') {
        throw new Error(ERROR_MESSAGE_USER_ABORT)
      }
      throw new Error(`Reactive compaction failed: ${outcome.reason}`)
    }

    const userDisplayMessage =
      [hookResult.userDisplayMessage, outcome.result.userDisplayMessage]
        .filter(Boolean)
        .join('\n') || undefined

    return { ...outcome.result, userDisplayMessage }
  } finally {
    toolUseContext.onCompactProgress?.({ type: 'compact_end' })
    toolUseContext.setSDKStatus?.(null)
  }
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  preRequestTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  // Without this, sessions where context is irrecoverably over the limit
  // hammer the API with doomed compaction attempts on every turn.
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  // The rough-estimate fallback cannot see the system prompt, the context blocks
  // or the tool schemas, and its 20K floor undershoots any session with heavy
  // MCP tooling. Everything needed to measure them is right here.
  const nonMessageOverheadTokens = await measureNonMessageOverheadTokens({
    model,
    toolUseContext,
    systemPrompt: cacheSafeParams.systemPrompt,
    userContext: cacheSafeParams.userContext,
    systemContext: cacheSafeParams.systemContext,
  })
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    preRequestTokensFreed,
    nonMessageOverheadTokens,
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: tracking?.compacted === true,
    turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
    previousCompactTurnId: tracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
    null,
  )
  if (sessionMemoryResult) {
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    // BQ 2026-03-01: missing this made 20% of tengu_prompt_cache_break events
    // false positives (systemPromptChanged=true, timeSinceLastAssistantMsg=-1).
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    // Prefix compaction is the normal path; full replacement is the fallback.
    // null means "reactive is off, or could not split this conversation".
    const reactiveResult = await tryReactivePrefixCompaction(
      messages,
      toolUseContext,
      cacheSafeParams,
      querySource,
    )

    const compactionResult =
      reactiveResult ??
      (await compactConversation(
        messages,
        toolUseContext,
        cacheSafeParams,
        true, // Suppress user questions for autocompact
        undefined, // No custom instructions for autocompact
        true, // isAutoCompact
        recompactionInfo,
      ))

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // Reset failure count on success
      consecutiveFailures: 0,
    }
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    if (isTransientAutoCompactFailure(error)) {
      logForDebugging(
        'autocompact: transient failure — preserving circuit breaker budget',
      )
      return {
        wasCompacted: false,
        consecutiveFailures: tracking?.consecutiveFailures,
      }
    }
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts.
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    if (nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — skipping future automatic attempts until compaction succeeds`,
        { level: 'warn' },
      )
      notifyAutoCompactCircuitBreaker(toolUseContext)
    }
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
