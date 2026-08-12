import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { readSessionState } from '../../agent-mode/sessionState.js'
import { getSessionId, markPostCompaction } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  StreamEvent,
} from '../../types/message.js'
import {
  createAttachmentMessage,
  getAgentListingDeltaAttachment,
  getDeferredToolsDeltaAttachment,
  getMcpInstructionsDeltaAttachment,
} from '../../utils/attachments.js'
import { logForDebugging } from '../../utils/debug.js'
import { cacheToObject } from '../../utils/fileStateCache.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import {
  executePostCompactHooks,
  executePreCompactHooks,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  getAssistantMessageText,
  getMessagesAfterCompactBoundary,
  isCompactBoundaryMessage,
} from '../../utils/messages.js'
import { resolveRequestProvider } from '../../utils/model/providers.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  cleanMessagesForLogging,
  getTranscriptPath,
  reAppendSessionMetadata,
} from '../../utils/sessionStorage.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { extractDiscoveredToolNames } from '../../utils/toolSearch.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  getPromptTooLongTokenGap,
  isMediaSizeErrorMessage,
  isPromptTooLongMessage,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  startsWithApiErrorPrefix,
} from '../api/errors.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import { isAutoCompactEnabled } from './autoCompact.js'
import {
  annotateBoundaryWithPreservedSegment,
  type CompactionResult,
  createAsyncAgentAttachmentsIfNeeded,
  createPlanAttachmentIfNeeded,
  createPlanModeAttachmentIfNeeded,
  createPostCompactFileAttachments,
  createSkillAttachmentIfNeeded,
  ERROR_MESSAGE_USER_ABORT,
  mergeHookInstructions,
  POST_COMPACT_MAX_FILES_TO_RESTORE,
  streamCompactSummary,
  stripImagesFromMessages,
} from './compact.js'
import { suppressCompactWarning } from './compactWarningState.js'
import { groupMessagesByApiRound } from './grouping.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import {
  getCompactPrompt,
  getCompactUserSummaryMessage,
  toAgentModeCompactState,
} from './prompt.js'
import { adjustIndexToPreserveAPIInvariants } from './sessionMemoryCompact.js'

/**
 * Reactive prefix compaction: summarize an older prefix, keep the newest
 * complete API rounds verbatim, and hand the caller a CompactionResult it can
 * feed straight back into the interrupted turn.
 *
 * This is the NORMAL path for all three triggers: the autocompact threshold
 * (autoCompact.ts), manual /compact, and recovery after the API has already
 * rejected a request (prompt-too-long or media-size). Traditional full
 * compaction (compactConversation) is the fallback, taken only when this
 * module reports that a prefix split is impossible ('too_few_groups' — a
 * single round cannot be halved, and full compaction has no such requirement).
 *
 * Two properties are load-bearing and easy to break:
 *   - The summary fork keeps the parent's ENTIRE tool set. The prompt-cache key
 *     is system+tools+model+prefix, so shrinking the request by dropping tools
 *     destroys the cache reuse it depends on. streamCompactSummary owns that;
 *     do not route around it. Only tool EXECUTION is blocked
 *     (createCompactCanUseTool).
 *   - Every preserved message must be reachable from the boundary metadata
 *     annotateBoundaryWithPreservedSegment writes. Live usage walks skip that
 *     range (tokens.ts getUsageWalkBounds) and resume relinks and zeroes it
 *     (sessionStorage.ts applyPreservedSegmentRelinks). Preserving messages the
 *     boundary does not name sends the next turn straight back into autocompact.
 */

// Each retry is a real API call against a conversation that already exceeds the
// window, so the ladder is short: one initial attempt plus three widenings of
// the preserved suffix. Mirrors MAX_PTL_RETRIES on the proactive path.
const MAX_REACTIVE_SUMMARY_ATTEMPTS = 4

export type ReactiveCompactFailureReason =
  | 'too_few_groups'
  | 'aborted'
  | 'exhausted'
  | 'error'
  | 'media_unstrippable'

/**
 * Deliberately ONE object rather than an `ok: true | false` discriminated
 * union. The root tsconfig sets `strict: false`, and without strictNullChecks
 * TypeScript does not narrow a union by a boolean discriminant, so the /compact
 * call site's `if (!outcome.ok) { switch (outcome.reason) … }` followed by
 * `outcome.result` would not compile against a union. `result` is present iff
 * `ok`; `reason` is present iff not.
 */
export type ReactiveCompactOutcome = {
  ok: boolean
  result?: CompactionResult
  reason?: ReactiveCompactFailureReason
}

/**
 * Remote kill-switch for prefix compaction as a whole (default ON), not an
 * opt-in: the module only exists in builds that compiled REACTIVE_COMPACT in.
 * Flipping it off returns every path to full replacement.
 */
function isPrefixCompactionKillSwitchOn(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_reactive_compact', true)
}

/**
 * Is reactive compaction allowed to act on an AUTOMATIC trigger — the
 * threshold in autoCompactIfNeeded, and 413/media recovery in the query loop?
 *
 * Consults isAutoCompactEnabled directly rather than shouldAutoCompact: the
 * suppression gates layered into shouldAutoCompact (context collapse) exist to
 * hand the headroom problem to a recovery path, so reading them here would
 * switch this path off exactly when it is the last one left. DISABLE_COMPACT /
 * DISABLE_AUTO_COMPACT / the user's autoCompactEnabled setting all still win,
 * because a user who asked for no automatic compaction gets none.
 */
export function isReactiveCompactEnabled(): boolean {
  if (!isAutoCompactEnabled()) {
    return false
  }
  return isPrefixCompactionKillSwitchOn()
}

/**
 * Is prefix compaction the algorithm for a MANUAL /compact?
 *
 * Deliberately does NOT consult isAutoCompactEnabled. That setting decides
 * whether compaction happens on its own, not how an explicitly requested
 * compaction summarizes, and the users most likely to turn automatic
 * compaction off are the ones who run /compact by hand — tying the two would
 * hand exactly them the full-replacement path. DISABLE_COMPACT still wins: it
 * removes the command (commands/compact/index.ts isEnabled).
 */
export function isReactiveManualCompactEnabled(): boolean {
  return isPrefixCompactionKillSwitchOn()
}

/**
 * Withholding predicates. Both are PURE — no feature-flag read — because
 * query.ts decides withholding per streamed message and recovery once after
 * the stream. A predicate that consulted a CACHED_MAY_BE_STALE flag could
 * answer differently across those two points and either swallow the error or
 * yield it twice (query.ts recomputes the 413 case itself at :1171-1174).
 */
export function isWithheldPromptTooLong(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return (
    msg?.type === 'assistant' &&
    msg.isApiErrorMessage === true &&
    // The Message union's assistant member is generic over its content blocks;
    // the predicates only read `type`/`text`, so the widened block type is not
    // a real mismatch.
    isPromptTooLongMessage(msg as AssistantMessage)
  )
}

export function isWithheldMediaSizeError(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return (
    msg?.type === 'assistant' &&
    isMediaSizeErrorMessage(msg as AssistantMessage)
  )
}

/**
 * How many additional trailing groups to preserve after a prompt-too-long on
 * the summary request itself. Preserving a group removes it from the summarize
 * set, so closing a reported gap means peeling groups off the NEW end of that
 * set until their estimated size covers it. Without a parsed gap (Vertex and
 * Bedrock wordings) we advance one group at a time.
 */
function groupsToCloseGap(
  groups: Message[][],
  preservedGroups: number,
  tokenGap: number | undefined,
): number {
  if (tokenGap === undefined) {
    return 1
  }
  let accumulated = 0
  let advanced = 0
  for (let i = groups.length - preservedGroups - 1; i >= 0; i--) {
    accumulated += roughTokenCountEstimationForMessages(groups[i]!)
    advanced++
    if (accumulated >= tokenGap) {
      break
    }
  }
  return Math.max(1, advanced)
}

/**
 * Messages the post-compact array keeps verbatim. Old boundaries and old
 * summaries must go: this compaction's summary sits BEFORE the preserved tail,
 * so a stale boundary inside it wins findLastCompactBoundaryIndex's backward
 * scan and drops the new summary. Same rule partialCompactConversation applies
 * to its 'up_to' direction.
 */
function selectMessagesToKeep(active: Message[], pivot: number): Message[] {
  return active
    .slice(pivot)
    .filter(
      message =>
        message.type !== 'progress' &&
        !isCompactBoundaryMessage(message) &&
        !(message.type === 'user' && message.isCompactSummary),
    )
}

/**
 * Group 0 is whatever precedes the first assistant response, so it is a
 * preamble rather than a round. One round cannot be split into "summarize" and
 * "preserve" halves — preserving the only answer while summarizing away the
 * prompt that produced it is worse than a full compaction.
 */
function hasCompleteRoundsToSplit(groups: Message[][]): boolean {
  return groups.filter(group => group[0]?.type === 'assistant').length >= 2
}

/**
 * Can this conversation be prefix-compacted at all?
 *
 * Both callers consult this BEFORE running PreCompact hooks or emitting
 * compaction progress, because the fallback they take when it answers false
 * (compactConversation) runs PreCompact hooks itself — and a user's PreCompact
 * hook must not fire twice for one compaction. Cheap and side-effect free: no
 * flag read, no API call, just the grouping.
 */
export function canPrefixCompact(messages: Message[]): boolean {
  return hasCompleteRoundsToSplit(
    groupMessagesByApiRound(getMessagesAfterCompactBoundary(messages)),
  )
}

/**
 * Split point for a given number of preserved trailing groups, expressed as an
 * index into `active`. Returns null when nothing would be left to summarize.
 *
 * The group boundary is already an API-safe split (a new assistant message.id
 * means the previous round's tool_uses were all resolved), but resumed or
 * truncated transcripts can carry a dangling tool_use, and thinking blocks from
 * one API response are split across several assistant records sharing one id.
 * adjustIndexToPreserveAPIInvariants only ever moves the pivot EARLIER, so it
 * can repair those without shrinking the preserved suffix.
 */
export function planReactiveSplit(
  active: Message[],
  groups: Message[][],
  preservedGroups: number,
): number | null {
  if (preservedGroups >= groups.length) {
    return null
  }
  let start = 0
  for (let i = 0; i < groups.length - preservedGroups; i++) {
    start += groups[i]!.length
  }
  const pivot = adjustIndexToPreserveAPIInvariants(active, start)
  return pivot > 0 ? pivot : null
}

export async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  options: {
    customInstructions?: string
    trigger: 'manual' | 'auto'
    querySource?: QuerySource
  },
): Promise<ReactiveCompactOutcome> {
  const context = cacheSafeParams.toolUseContext
  // Anything before the last boundary is already summarized, and preserving
  // across it would leave the resume walk a chain with a hole in it.
  const active = getMessagesAfterCompactBoundary(messages)
  const groups = groupMessagesByApiRound(active)
  // Callers pre-check this with canPrefixCompact so they can fall back before
  // running PreCompact hooks; repeated here so the function is safe on its own.
  if (!hasCompleteRoundsToSplit(groups)) {
    return { ok: false, reason: 'too_few_groups' }
  }

  const preCompactTokenCount = tokenCountWithEstimation(messages)
  const appState = context.getAppState()
  const sessionState = context.agentId
    ? null
    : await readSessionState(getSessionId())
  const provider = resolveRequestProvider(
    context.options.mainLoopModel,
    context.options.mainLoopProvider,
  )
  const summaryRequest = createUserMessage({
    content: getCompactPrompt(
      options.customInstructions,
      provider,
      !!sessionState,
    ),
  })

  let preservedGroups = 1
  let mediaStripped = false
  let pivot: number | null = null
  let summary: string | null = null
  let summaryResponse: AssistantMessage | undefined

  for (let attempt = 1; attempt <= MAX_REACTIVE_SUMMARY_ATTEMPTS; attempt++) {
    if (context.abortController.signal.aborted) {
      return { ok: false, reason: 'aborted' }
    }
    pivot = planReactiveSplit(active, groups, preservedGroups)
    if (pivot === null) {
      return { ok: false, reason: 'exhausted' }
    }
    const prefix = active.slice(0, pivot)
    const toSummarize = mediaStripped ? stripImagesFromMessages(prefix) : prefix

    try {
      summaryResponse = await streamCompactSummary({
        messages: toSummarize,
        summaryRequest,
        appState,
        context,
        preCompactTokenCount,
        // The forked path reads forkContextMessages, not `messages` — a retry
        // that only narrowed one of them would send the old prefix.
        cacheSafeParams: {
          ...cacheSafeParams,
          forkContextMessages: toSummarize,
        },
      })
    } catch (error) {
      if (context.abortController.signal.aborted) {
        return { ok: false, reason: 'aborted' }
      }
      logError(error)
      return { ok: false, reason: 'error' }
    }

    summary = getAssistantMessageText(summaryResponse)

    if (
      isPromptTooLongMessage(summaryResponse) ||
      summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)
    ) {
      const advance = groupsToCloseGap(
        groups,
        preservedGroups,
        getPromptTooLongTokenGap(summaryResponse),
      )
      preservedGroups += advance
      summary = null
      logForDebugging(
        `reactive compact: summary request too long, preserving ${preservedGroups}/${groups.length} rounds (attempt ${attempt})`,
      )
      logEvent('tengu_reactive_compact_retry', {
        attempt,
        preservedGroups,
        totalGroups: groups.length,
        isMediaRetry: false,
      })
      continue
    }

    if (isMediaSizeErrorMessage(summaryResponse)) {
      // Media the summarizer cannot carry is worth one strip-and-retry; a
      // second failure means the rejection is not about images at all.
      if (mediaStripped) {
        return { ok: false, reason: 'media_unstrippable' }
      }
      mediaStripped = true
      summary = null
      logEvent('tengu_reactive_compact_retry', {
        attempt,
        preservedGroups,
        totalGroups: groups.length,
        isMediaRetry: true,
      })
      continue
    }

    break
  }

  if (!summaryResponse || !summary) {
    return {
      ok: false,
      reason: context.abortController.signal.aborted ? 'aborted' : 'exhausted',
    }
  }
  if (startsWithApiErrorPrefix(summary)) {
    return {
      ok: false,
      reason: summary.startsWith(ERROR_MESSAGE_USER_ABORT) ? 'aborted' : 'error',
    }
  }

  const messagesToKeep = selectMessagesToKeep(active, pivot!)
  const summarized = active.slice(0, pivot!)

  // Same order the other two compaction paths use: snapshot the read-file
  // state, clear it, then rebuild attachments from the snapshot.
  const preCompactReadFileState = cacheToObject(context.readFileState)
  context.readFileState.clear()
  context.loadedNestedMemoryPaths?.clear()

  const [fileAttachments, asyncAgentAttachments] = await Promise.all([
    createPostCompactFileAttachments(
      preCompactReadFileState,
      context,
      POST_COMPACT_MAX_FILES_TO_RESTORE,
      messagesToKeep,
    ),
    createAsyncAgentAttachmentsIfNeeded(context),
  ])

  const attachments: AttachmentMessage[] = [
    ...fileAttachments,
    ...asyncAgentAttachments,
  ]
  const planAttachment = createPlanAttachmentIfNeeded(context.agentId)
  if (planAttachment) {
    attachments.push(planAttachment)
  }
  const planModeAttachment = await createPlanModeAttachmentIfNeeded(context)
  if (planModeAttachment) {
    attachments.push(planModeAttachment)
  }
  const skillAttachment = createSkillAttachmentIfNeeded(context.agentId)
  if (skillAttachment) {
    attachments.push(skillAttachment)
  }

  // Re-announce only what the summarized prefix took away — the preserved tail
  // is scanned, so anything still visible there is skipped.
  for (const attachment of getDeferredToolsDeltaAttachment(
    context.options.tools,
    context.options.mainLoopModel,
    messagesToKeep,
    { callSite: 'reactive_compact', querySource: options.querySource },
  )) {
    attachments.push(createAttachmentMessage(attachment))
  }
  for (const attachment of getAgentListingDeltaAttachment(
    context,
    messagesToKeep,
  )) {
    attachments.push(createAttachmentMessage(attachment))
  }
  for (const attachment of getMcpInstructionsDeltaAttachment(
    context.options.mcpClients,
    context.options.tools,
    context.options.mainLoopModel,
    messagesToKeep,
  )) {
    attachments.push(createAttachmentMessage(attachment))
  }

  context.onCompactProgress?.({
    type: 'hooks_start',
    hookType: 'session_start',
  })
  const hookResults = await processSessionStartHooks('compact', {
    model: context.options.mainLoopModel,
  })

  // logicalParentUuid names the last persisted message of the summarized
  // prefix: that is what preceded the boundary in the on-disk chain.
  const lastPreCompactUuid = cleanMessagesForLogging(
    [...summarized],
    active,
  ).at(-1)?.uuid as UUID | undefined
  const boundaryMarker = createCompactBoundaryMessage(
    options.trigger,
    preCompactTokenCount,
    lastPreCompactUuid,
    undefined,
    summarized.length,
  )
  // The summary carries no tool_reference blocks, so already-loaded deferred
  // tool schemas would stop being sent without this.
  const preCompactDiscovered = extractDiscoveredToolNames(messages)
  if (preCompactDiscovered.size > 0) {
    boundaryMarker.compactMetadata.preCompactDiscoveredTools = [
      ...preCompactDiscovered,
    ].sort()
  }

  const summaryMessages = [
    createUserMessage({
      content: getCompactUserSummaryMessage(
        summary,
        options.trigger === 'auto',
        getTranscriptPath(),
        messagesToKeep.length > 0,
        provider,
        toAgentModeCompactState(sessionState),
      ),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
  ]

  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    notifyCompaction(
      options.querySource ?? context.options.querySource ?? 'compact',
      context.agentId,
    )
  }
  markPostCompaction()
  reAppendSessionMetadata()

  context.onCompactProgress?.({ type: 'hooks_start', hookType: 'post_compact' })
  const postCompactHookResult = await executePostCompactHooks(
    { trigger: options.trigger, compactSummary: summary },
    context.abortController.signal,
  )

  logEvent('tengu_reactive_compact', {
    preCompactTokenCount,
    messagesKept: messagesToKeep.length,
    messagesSummarized: summarized.length,
    preservedGroups,
    totalGroups: groups.length,
    mediaStripped,
    isAutoTrigger: options.trigger === 'auto',
  })

  return {
    ok: true,
    result: {
      // Suffix-preserving: the preserved head hangs off the LAST summary
      // message, not off the boundary.
      boundaryMarker: annotateBoundaryWithPreservedSegment(
        boundaryMarker,
        summaryMessages.at(-1)!.uuid as UUID,
        messagesToKeep,
        active,
      ),
      summaryMessages,
      messagesToKeep,
      attachments,
      hookResults,
      userDisplayMessage: postCompactHookResult.userDisplayMessage,
      preCompactTokenCount,
    },
  }
}

/**
 * Query-loop entry point: the API rejected the request and the error is being
 * withheld. Returns a CompactionResult the caller replays into the SAME turn,
 * or null to let the withheld error surface.
 */
export async function tryReactiveCompact(params: {
  hasAttempted: boolean
  querySource: QuerySource
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): Promise<CompactionResult | null> {
  const { hasAttempted, querySource, aborted, messages, cacheSafeParams } =
    params
  if (hasAttempted || aborted || !isReactiveCompactEnabled()) {
    return null
  }
  // compact and session_memory are forked agents running on the parent's
  // conversation. Compacting from inside one deadlocks it against itself.
  if (querySource === 'compact' || querySource === 'session_memory') {
    return null
  }

  const context = cacheSafeParams.toolUseContext
  context.setSDKStatus?.('compacting')
  context.onCompactProgress?.({ type: 'hooks_start', hookType: 'pre_compact' })
  try {
    const hookResult = await executePreCompactHooks(
      { trigger: 'auto', customInstructions: null },
      context.abortController.signal,
    )

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })

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
      logForDebugging(
        `reactive compact: no recovery (${outcome.reason}) — surfacing the withheld error`,
        { level: 'warn' },
      )
      logEvent('tengu_reactive_compact_failed', {
        reason:
          outcome.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return null
    }

    // The summary replaces messages the REPL still holds, so the id that
    // pointed into them is stale. runPostCompactCleanup owns the rest
    // (microcompact state, memory-file caches, per-turn permission caches).
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    suppressCompactWarning()

    const userDisplayMessage =
      [hookResult.userDisplayMessage, outcome.result.userDisplayMessage]
        .filter(Boolean)
        .join('\n') || undefined

    return { ...outcome.result, userDisplayMessage }
  } catch (error) {
    logError(error)
    return null
  } finally {
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_end' })
    context.setSDKStatus?.(null)
  }
}
