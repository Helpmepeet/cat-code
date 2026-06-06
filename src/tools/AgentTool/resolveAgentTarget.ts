import { stat } from 'fs/promises'
import { getSessionId } from '../../bootstrap/state.js'
import { resolveWorkerAgentTarget } from '../../agent-mode/sessionState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { asAgentId, toAgentId } from '../../types/ids.js'
import {
  getAgentTranscript,
  getAgentTranscriptForSession,
  getAgentTranscriptPath,
  listAgentMetadataForSession,
  readAgentMetadata,
  readAgentMetadataForSession,
} from '../../utils/sessionStorage.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'

export type ResolvedAgentTarget = {
  agentId: string
  sourceSessionId: string
  displayName: string
  // Best-effort current context size of the target, in tokens. Read from live
  // task progress when the agent is still in memory, else recomputed from the
  // last API response in its on-disk transcript. undefined when neither is
  // available. Lets the caller weigh resume (replays this context) vs. spawning
  // a fresh agent.
  contextTokens?: number
}

type DisplayNameOptions = {
  agentId: string
  appState: Pick<AppState, 'agentNameRegistry' | 'tasks'>
  sourceSessionId?: string
}

function shortAgentId(agentId: string): string {
  return agentId.length <= 12 ? agentId : `${agentId.slice(0, 12)}...`
}

/**
 * Render a resolved target's context size as a short trailing clause for
 * model-facing messages, e.g. " Its context was ~148k tokens at last checkpoint."
 * Empty string when the size is unknown OR small enough not to matter, so the
 * hint only fires when context size is actually decision-relevant and callers
 * can append it unconditionally.
 */
export function formatContextSizeHint(
  contextTokens: number | undefined,
): string {
  // Below this, replaying the transcript is cheap and the size shouldn't sway
  // resume-vs-spawn — surfacing "~2 tokens" would be noise, not signal.
  const HINT_FLOOR_TOKENS = 1000
  if (typeof contextTokens !== 'number' || contextTokens < HINT_FLOOR_TOKENS) {
    return ''
  }
  return ` Its context was ~${Math.round(contextTokens / 1000)}k tokens at last checkpoint; if that's already large, a fresh agent may be cheaper than resuming.`
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

/**
 * Best-effort current context size of an agent, in tokens. Prefers the live
 * task's progress counter (already in memory, no I/O); falls back to the last
 * API response in the on-disk transcript for evicted/terminated agents. Never
 * throws — returns undefined when the size can't be determined.
 */
async function contextTokensForAgent({
  agentId,
  appState,
  sourceSessionId,
}: DisplayNameOptions): Promise<number | undefined> {
  const task = appState.tasks[agentId]
  if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
    // Full context size (input + cache + output of the last response) — the
    // amount that would be replayed on resume. NOT progress.tokenCount, which
    // is a display-oriented counter (drops cache reads, sums all output) and
    // can diverge ~2x from real context size.
    const tokens = task.progress?.contextTokenCount
    if (typeof tokens === 'number' && tokens > 0) return tokens
  }

  try {
    const currentSessionId = getSessionId()
    const transcript =
      sourceSessionId && sourceSessionId !== currentSessionId
        ? await getAgentTranscriptForSession(sourceSessionId, asAgentId(agentId))
        : await getAgentTranscript(asAgentId(agentId))
    if (!transcript) return undefined
    const tokens = tokenCountFromLastAPIResponse(transcript.messages)
    return tokens > 0 ? tokens : undefined
  } catch {
    return undefined
  }
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
    const [displayName, contextTokens] = await Promise.all([
      displayNameForAgent(opts),
      contextTokensForAgent(opts),
    ])
    return { agentId: registered, sourceSessionId: sessionId, displayName, contextTokens }
  }

  const durableTarget = await resolveWorkerAgentTarget(sessionId, target)
  if (durableTarget) {
    const opts = {
      agentId: durableTarget.agentId,
      appState,
      sourceSessionId: durableTarget.originSessionId,
    }
    const [displayName, contextTokens] = await Promise.all([
      displayNameForAgent(opts),
      contextTokensForAgent(opts),
    ])
    return {
      agentId: durableTarget.agentId,
      sourceSessionId: durableTarget.originSessionId,
      displayName,
      contextTokens,
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
    const [displayName, contextTokens] = await Promise.all([
      displayNameForAgent(opts),
      contextTokensForAgent(opts),
    ])
    return {
      agentId: metadataTarget.agentId,
      sourceSessionId: sessionId,
      displayName,
      contextTokens,
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
  const [displayName, contextTokens] = await Promise.all([
    displayNameForAgent(opts),
    contextTokensForAgent(opts),
  ])
  return { agentId: rawAgentId, sourceSessionId: sessionId, displayName, contextTokens }
}
