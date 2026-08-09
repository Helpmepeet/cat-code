/**
 * Restored nested subagent history.
 *
 * A subagent's conversation is persisted to its OWN transcript file, routed
 * there by `appendEntry`'s sidechain branch (`isSidechain && agentId` →
 * `getAgentTranscriptPath`, `src/utils/sessionStorage.ts:1676`). The parent
 * session's transcript therefore never contained those messages, and restore
 * reads only the parent file — so a restored Agent card came back with no
 * child rows, no tool count, and an empty body.
 *
 * The join key is the meta sidecar's `parentToolUseId`
 * (`src/tools/AgentTool/runAgent.ts:824`), written from the spawning Agent
 * tool_use block's id. That is the same id `selectNestedTranscriptRows`
 * already groups on (`app/renderer/src/transcriptProjector.ts` — children are
 * collected by `parentToolUseId`), so stamping restored subagent frames with
 * it rebuilds the tree with no renderer change.
 *
 * Read-only, engine-owned readers only: `listAgentMetadataForSession` and
 * `getAgentTranscriptForSession` are the engine's own accessors (§8 rule 10 —
 * never re-walk the transcript directory here).
 *
 * Eager at restore rather than lazy on card expand: a lazy fetch needs a new
 * renderer→sidecar request, and a new inbound frame kind is exactly what the
 * security baseline makes expensive. Eager is paid for instead by never
 * reading a branch whose parent is absent, by the frame budget below, and by
 * `sendHistoryReplay`'s own caps.
 */
import type { SDKMessage } from '../../src/entrypoints/agentSdkTypes.js'
import {
  getAgentTranscriptForSession,
  listAgentMetadataForSession,
} from '../../src/utils/sessionStorage.js'

import { MAX_HISTORY_REPLAY_FRAMES } from '../shared/limits.js'
import { projectResumedHistory } from './historyProjection.js'

/** One subagent's restored frames, already stamped with their parent id. */
export type SubagentBranch = {
  parentToolUseId: string
  frames: SDKMessage[]
}

/** A subagent worth reading: metadata that actually carries the join key. */
type BranchCandidate = {
  agentId: Parameters<typeof getAgentTranscriptForSession>[1]
  parentToolUseId: string
  agentName: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The tool_use block ids an assistant frame spawned. Runtime-narrowed because
 * the snapshot types `message.content` as `unknown[]`.
 */
function toolUseIdsOf(message: SDKMessage): string[] {
  if (message.type !== 'assistant') return []
  const content = message.message.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      block.id.length > 0
    ) {
      ids.push(block.id)
    }
  }
  return ids
}

function collectToolUseIds(history: readonly SDKMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of history) {
    for (const id of toolUseIdsOf(message)) ids.add(id)
  }
  return ids
}

function collectUuids(history: readonly SDKMessage[]): Set<string> {
  const uuids = new Set<string>()
  for (const message of history) {
    if (typeof message.uuid === 'string') uuids.add(message.uuid)
  }
  return uuids
}

/**
 * A subagent transcript's frames, ready to splice.
 *
 * Only assistant and user frames survive. Everything else — in practice a
 * subagent's own `compact_boundary` — has nowhere to carry
 * `parent_tool_use_id` (`src/utils/messages/mappers.ts:229` emits it without
 * one), so splicing it would drop an unparented row into the MAIN transcript,
 * telling the operator the parent session compacted when it was the worker.
 * The projector routes any row with no resolvable parent to top level, which
 * is the interleaving this nesting exists to prevent.
 *
 * `seenUuids` drops frames the parent transcript already has: a fork agent's
 * inherited context is written into its sidechain with the SAME uuids as the
 * parent (`src/utils/sessionStorage.ts:1681` documents why dedupe is skipped
 * on that write). The renderer would discard them at projection anyway, but
 * only after they had consumed the replay budget.
 */
export function projectBranchFrames(
  messages: Parameters<typeof projectResumedHistory>[0],
  parentToolUseId: string,
  agentName: string | undefined,
  seenUuids: ReadonlySet<string> = new Set(),
): SDKMessage[] {
  const frames: SDKMessage[] = []
  for (const frame of projectResumedHistory(messages)) {
    if (frame.type !== 'assistant' && frame.type !== 'user') continue
    if (typeof frame.uuid === 'string' && seenUuids.has(frame.uuid)) continue
    frames.push({
      ...frame,
      parent_tool_use_id: parentToolUseId,
      ...(agentName !== undefined ? { agent_name: agentName } : {}),
    })
  }
  return frames
}

/**
 * Splice each branch in directly AFTER the assistant frame that spawned it.
 *
 * Position matters twice. The replay cap walks newest → oldest and keeps a
 * contiguous tail (`sidecarServer.ts` `sendHistoryReplay`), so appending
 * branches at the end would make a subagent's chatter outrank the parent's own
 * recent turns. And a branch whose parent frame is absent from the restored
 * window is DROPPED rather than appended: the projector keeps an orphaned
 * child at top level, which would interleave subagent rows into the main
 * transcript.
 */
export function spliceSubagentBranches(
  history: readonly SDKMessage[],
  branches: readonly SubagentBranch[],
): SDKMessage[] {
  if (branches.length === 0) return [...history]
  const byParent = new Map<string, SDKMessage[]>()
  for (const branch of branches) {
    const existing = byParent.get(branch.parentToolUseId)
    if (existing) existing.push(...branch.frames)
    else byParent.set(branch.parentToolUseId, [...branch.frames])
  }
  const spliced: SDKMessage[] = []
  for (const message of history) {
    spliced.push(message)
    for (const toolUseId of toolUseIdsOf(message)) {
      const branchFrames = byParent.get(toolUseId)
      if (branchFrames === undefined) continue
      spliced.push(...branchFrames)
      // One splice per tool_use: a parent frame replayed twice would otherwise
      // duplicate the whole branch.
      byParent.delete(toolUseId)
    }
  }
  return spliced
}

/**
 * Every subagent of a session that carries the join key, in spawn order.
 * Metadata predating `parentToolUseId` (older files lack it) is skipped:
 * without the key its frames could only be interleaved into the main
 * transcript. Field types are re-checked rather than trusted — the engine
 * reader parses the meta file with an unchecked cast
 * (`src/utils/sessionStorage.ts:433`).
 */
async function loadBranchCandidates(
  sessionId: string,
): Promise<BranchCandidate[]> {
  const entries = await listAgentMetadataForSession(sessionId)
  const spawnOrder = [...entries].sort((left, right) =>
    (nonEmptyString(left.metadata.spawnedAt) ?? '').localeCompare(
      nonEmptyString(right.metadata.spawnedAt) ?? '',
    ),
  )
  const candidates: BranchCandidate[] = []
  for (const { agentId, metadata } of spawnOrder) {
    const parentToolUseId = nonEmptyString(metadata.parentToolUseId)
    if (parentToolUseId === undefined) continue
    candidates.push({
      agentId,
      parentToolUseId,
      agentName: nonEmptyString(metadata.agentName),
    })
  }
  return candidates
}

/**
 * Restored history with every locatable subagent branch nested under its Agent
 * card.
 *
 * Loads in waves so a subagent that spawned its OWN subagent still nests: each
 * pass reads only the branches whose parent tool_use is present in what has
 * been assembled so far, then re-scans the frames it just spliced. A branch
 * never reachable from the restored window is never read at all, which is what
 * keeps an eager restore from paying for history the replay cap would discard.
 *
 * Failure is non-fatal by design: restore without nesting is the previous
 * behavior, and losing a whole session's history to one unreadable sidechain
 * file would be a strictly worse trade.
 */
export async function withRestoredSubagentHistory(
  sessionId: string,
  history: readonly SDKMessage[],
  onError?: (message: string) => void,
): Promise<SDKMessage[]> {
  if (history.length === 0) return [...history]
  try {
    let pending = await loadBranchCandidates(sessionId)
    if (pending.length === 0) return [...history]
    let assembled: SDKMessage[] = [...history]
    // The display load already spent this budget down to the wire cap
    // (`index.ts` passes `MAX_HISTORY_REPLAY_FRAMES` as its own `maxMessages`),
    // so branches take only the headroom that is left. Without this the splice
    // pushes the total past the cap and `sendHistoryReplay` drops the OLDEST
    // main-transcript frames to make room for subagent chatter.
    let budget = MAX_HISTORY_REPLAY_FRAMES - assembled.length
    while (pending.length > 0 && budget > 0) {
      const reachable = collectToolUseIds(assembled)
      const matched = pending.filter(candidate =>
        reachable.has(candidate.parentToolUseId),
      )
      if (matched.length === 0) break
      pending = pending.filter(
        candidate => !reachable.has(candidate.parentToolUseId),
      )
      const seenUuids = collectUuids(assembled)
      const loaded = await Promise.all(
        matched.map(async candidate => {
          const transcript = await getAgentTranscriptForSession(
            sessionId,
            candidate.agentId,
          )
          if (transcript === null) return null
          const frames = projectBranchFrames(
            transcript.messages,
            candidate.parentToolUseId,
            candidate.agentName,
            seenUuids,
          )
          return frames.length === 0
            ? null
            : { parentToolUseId: candidate.parentToolUseId, frames }
        }),
      )
      const branches: SubagentBranch[] = []
      for (const branch of loaded) {
        if (branch === null) continue
        if (branch.frames.length > budget) break
        branches.push(branch)
        budget -= branch.frames.length
      }
      if (branches.length === 0) break
      assembled = spliceSubagentBranches(assembled, branches)
    }
    return assembled
  } catch (error) {
    onError?.(
      `[sidecar] subagent history unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return [...history]
  }
}
