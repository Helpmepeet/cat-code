import { stat } from 'fs/promises'
import { getSessionId } from '../../bootstrap/state.js'
import { resolveWorkerAgentTarget } from '../../agent-mode/sessionState.js'
import type { AppState } from '../../state/AppStateStore.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { asAgentId, toAgentId } from '../../types/ids.js'
import {
  getAgentTranscriptPath,
  listAgentMetadataForSession,
  readAgentMetadata,
  readAgentMetadataForSession,
} from '../../utils/sessionStorage.js'

export type ResolvedAgentTarget = {
  agentId: string
  sourceSessionId: string
  displayName: string
}

type DisplayNameOptions = {
  agentId: string
  appState: Pick<AppState, 'agentNameRegistry' | 'tasks'>
  sourceSessionId?: string
}

function shortAgentId(agentId: string): string {
  return agentId.length <= 12 ? agentId : `${agentId.slice(0, 12)}...`
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
    return {
      agentId: registered,
      sourceSessionId: sessionId,
      displayName: await displayNameForAgent({
        agentId: registered,
        appState,
        sourceSessionId: sessionId,
      }),
    }
  }

  const durableTarget = await resolveWorkerAgentTarget(sessionId, target)
  if (durableTarget) {
    return {
      agentId: durableTarget.agentId,
      sourceSessionId: durableTarget.originSessionId,
      displayName: await displayNameForAgent({
        agentId: durableTarget.agentId,
        appState,
        sourceSessionId: durableTarget.originSessionId,
      }),
    }
  }

  const metadataMatches = (await listAgentMetadataForSession(sessionId)).filter(
    entry => entry.metadata.agentName === target,
  )
  if (metadataMatches.length > 1) return null
  const metadataTarget = metadataMatches[0]
  if (metadataTarget) {
    return {
      agentId: metadataTarget.agentId,
      sourceSessionId: sessionId,
      displayName: await displayNameForAgent({
        agentId: metadataTarget.agentId,
        appState,
        sourceSessionId: sessionId,
      }),
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

  return {
    agentId: rawAgentId,
    sourceSessionId: sessionId,
    displayName: await displayNameForAgent({
      agentId: rawAgentId,
      appState,
      sourceSessionId: sessionId,
    }),
  }
}
