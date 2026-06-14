import { stat } from 'fs/promises'
import { getSdkBetas, getSessionId } from '../../bootstrap/state.js'
import { resolveWorkerAgentTarget } from '../../agent-mode/sessionState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import type { Message } from '../../types/message.js'
import { asAgentId, toAgentId } from '../../types/ids.js'
import { getContextWindowForModel } from '../../utils/context.js'
import {
  getAgentTranscript,
  getAgentTranscriptForSession,
  getAgentTranscriptPath,
  listAgentMetadataForSession,
  readAgentMetadata,
  readAgentMetadataForSession,
} from '../../utils/sessionStorage.js'
import { getTokenCountFromUsage, getTokenUsage } from '../../utils/tokens.js'

export type ResolvedAgentTarget = {
  agentId: string
  sourceSessionId: string
  displayName: string
  // Best-effort current context size of the target, in tokens. Read from live
  // task progress when the agent is still in memory, else recomputed from the
  // last API response in its on-disk transcript. undefined when neither is
  // available.
  contextTokens?: number
  // Best-effort max context window for the model that produced contextTokens.
  // Lets callers render context size as a comparable fraction when available.
  contextWindowTokens?: number
}

type DisplayNameOptions = {
  agentId: string
  appState: Pick<AppState, 'agentNameRegistry' | 'tasks'>
  sourceSessionId?: string
}

function shortAgentId(agentId: string): string {
  return agentId.length <= 12 ? agentId : `${agentId.slice(0, 12)}...`
}

const HINT_FLOOR_TOKENS = 1000

function shouldRenderContextSize(contextTokens: number | undefined): boolean {
  if (typeof contextTokens !== 'number' || contextTokens < HINT_FLOOR_TOKENS) {
    return false
  }
  return true
}

function formatKTokens(tokens: number, approximate: boolean): string {
  return `${approximate ? '~' : ''}${Math.round(tokens / 1000)}k`
}

function formatContextSize(
  contextTokens: number,
  contextWindowTokens: number | undefined,
): string {
  const used = formatKTokens(contextTokens, true)
  if (typeof contextWindowTokens === 'number' && contextWindowTokens > 0) {
    const max = formatKTokens(contextWindowTokens, false)
    const percent = Math.round((contextTokens / contextWindowTokens) * 100)
    return `${used} / ${max} tokens (${percent}%)`
  }
  return `${used} tokens`
}

/**
 * Render a resolved target's context size as a short pre-action decision hint.
 * Empty string when the size is unknown OR small enough not to matter, so the
 * hint only fires when context size is actually decision-relevant and callers
 * can append it unconditionally.
 */
export function formatContextSizeHint(
  contextTokens: number | undefined,
  contextWindowTokens?: number,
): string {
  // Below this, replaying the transcript is cheap and the size shouldn't sway
  // resume-vs-spawn — surfacing "~2 tokens" would be noise, not signal.
  if (!shouldRenderContextSize(contextTokens)) return ''
  return ` Its context was ${formatContextSize(contextTokens, contextWindowTokens)}; if that's already large, a fresh agent may be cheaper than resuming.`
}

/**
 * Render a neutral post-action context note after ResumeAgent has already
 * scheduled the background run.
 */
export function formatResumedContextNotice(
  contextTokens: number | undefined,
  contextWindowTokens?: number,
): string {
  if (!shouldRenderContextSize(contextTokens)) return ''
  return ` Previous context: ${formatContextSize(contextTokens, contextWindowTokens)}.`
}

function normalizeAgentTarget(input: string): string {
  const trimmed = input.trim()
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
}

export async function displayNameForAgent({
  agentId,
  appState,
  sourceSessionId,
}: DisplayNameOptions): Promise<string> {
  for (const [name, id] of appState.agentNameRegistry) {
    if (id === agentId) return `@${name}`
  }

  const currentSessionId = getSessionId()
  const metadata =
    sourceSessionId && sourceSessionId !== currentSessionId
      ? await readAgentMetadataForSession(sourceSessionId, asAgentId(agentId))
      : await readAgentMetadata(asAgentId(agentId))
  if (metadata?.agentName) return `@${metadata.agentName}`
  if (metadata?.description) return metadata.description

  const task = appState.tasks[agentId]
  if (task && 'description' in task && typeof task.description === 'string') {
    return task.description
  }

  return shortAgentId(agentId)
}

type ContextStats = {
  contextTokens?: number
  contextWindowTokens?: number
}

function contextWindowTokensForModel(model: string | undefined): number | undefined {
  if (!model || model === 'inherit') return undefined
  const contextWindow = getContextWindowForModel(model, getSdkBetas())
  return contextWindow > 0 ? contextWindow : undefined
}

function contextStatsFromMessages(messages: Message[]): ContextStats {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    const usage = message ? getTokenUsage(message) : undefined
    if (usage) {
      return {
        contextTokens: getTokenCountFromUsage(usage),
        contextWindowTokens:
          message?.type === 'assistant'
            ? contextWindowTokensForModel(message.message.model)
            : undefined,
      }
    }
    i--
  }
  return {}
}

/**
 * Best-effort current context size of an agent, in tokens. Prefers the live
 * task's progress counter (already in memory, no I/O); falls back to the last
 * API response in the on-disk transcript for evicted/terminated agents. Never
 * throws — returns empty stats when the size can't be determined.
 */
async function contextStatsForAgent({
  agentId,
  appState,
  sourceSessionId,
}: DisplayNameOptions): Promise<ContextStats> {
  const task = appState.tasks[agentId]
  const transcriptStats = async (): Promise<ContextStats> => {
    try {
      const currentSessionId = getSessionId()
      const transcript =
        sourceSessionId && sourceSessionId !== currentSessionId
          ? await getAgentTranscriptForSession(sourceSessionId, asAgentId(agentId))
          : await getAgentTranscript(asAgentId(agentId))
      return transcript ? contextStatsFromMessages(transcript.messages) : {}
    } catch {
      return {}
    }
  }

  if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
    // Full context size (input + cache + output of the last response) — the
    // amount that would be replayed on resume. NOT progress.tokenCount, which
    // is a display-oriented counter (drops cache reads, sums all output) and
    // can diverge ~2x from real context size.
    const tokens = task.progress?.contextTokenCount
    if (typeof tokens === 'number' && tokens > 0) {
      const contextWindowTokens = contextWindowTokensForModel(task.model)
      if (contextWindowTokens) {
        return {
          contextTokens: tokens,
          contextWindowTokens,
        }
      }
      const fallback = await transcriptStats()
      return {
        contextTokens: tokens,
        contextWindowTokens: fallback.contextWindowTokens,
      }
    }
  }

  return await transcriptStats()
}

async function transcriptExistsForCurrentSession(agentId: string): Promise<boolean> {
  try {
    await stat(getAgentTranscriptPath(asAgentId(agentId)))
    return true
  } catch {
    return false
  }
}

export async function resolveAgentTarget({
  input,
  appState,
  sessionId,
}: {
  input: string
  appState: Pick<AppState, 'agentNameRegistry' | 'tasks'>
  sessionId: string
}): Promise<ResolvedAgentTarget | null> {
  const target = normalizeAgentTarget(input)
  if (target.length === 0) return null

  const registered = appState.agentNameRegistry.get(target)
  if (registered) {
    const opts = { agentId: registered, appState, sourceSessionId: sessionId }
    const [displayName, contextStats] = await Promise.all([
      displayNameForAgent(opts),
      contextStatsForAgent(opts),
    ])
    return {
      agentId: registered,
      sourceSessionId: sessionId,
      displayName,
      ...contextStats,
    }
  }

  const durableTarget = await resolveWorkerAgentTarget(sessionId, target)
  if (durableTarget) {
    const opts = {
      agentId: durableTarget.agentId,
      appState,
      sourceSessionId: durableTarget.originSessionId,
    }
    const [displayName, contextStats] = await Promise.all([
      displayNameForAgent(opts),
      contextStatsForAgent(opts),
    ])
    return {
      agentId: durableTarget.agentId,
      sourceSessionId: durableTarget.originSessionId,
      displayName,
      ...contextStats,
    }
  }

  const metadataMatches = (await listAgentMetadataForSession(sessionId)).filter(
    entry => entry.metadata.agentName === target,
  )
  if (metadataMatches.length > 1) return null
  const metadataTarget = metadataMatches[0]
  if (metadataTarget) {
    const opts = {
      agentId: metadataTarget.agentId,
      appState,
      sourceSessionId: sessionId,
    }
    const [displayName, contextStats] = await Promise.all([
      displayNameForAgent(opts),
      contextStatsForAgent(opts),
    ])
    return {
      agentId: metadataTarget.agentId,
      sourceSessionId: sessionId,
      displayName,
      ...contextStats,
    }
  }

  const rawAgentId = toAgentId(target)
  if (!rawAgentId) {
    return null
  }

  const liveTask = appState.tasks[rawAgentId]
  const hasLiveLocalAgentTask =
    isLocalAgentTask(liveTask) && !isMainSessionTask(liveTask)
  if (
    !hasLiveLocalAgentTask &&
    !(await transcriptExistsForCurrentSession(rawAgentId))
  ) {
    return null
  }

  const opts = { agentId: rawAgentId, appState, sourceSessionId: sessionId }
  const [displayName, contextStats] = await Promise.all([
    displayNameForAgent(opts),
    contextStatsForAgent(opts),
  ])
  return {
    agentId: rawAgentId,
    sourceSessionId: sessionId,
    displayName,
    ...contextStats,
  }
}
