import type { ToolUseContext } from '../../src/Tool.js'
import type { AppState } from '../../src/state/AppStateStore.js'
import type { Message } from '../../src/types/message.js'
import type { PeerRosterSnapshotAttachment } from '../../src/utils/attachments.js'
import { jsonStringify } from '../../src/utils/slowOperations.js'
import { upgradeWorkspaceJumpState, type WorkspaceJumpState } from '../../src/utils/workspaceJumpState.js'
import { narrowPeerList, PEER_NOTICE_CONTEXT, type PeerView } from './listPeersTool.js'
import { requestPeerHost, requestPeerRoster, type PeerHostRequester } from './peerHostRequester.js'
import { quoteAsData } from './readPeerTool.js'

export const PEER_START_CONTEXT_TIMEOUT_MS = 750
export const MAX_PEER_START_CONTEXT_PEERS = 32
export const MAX_PEER_START_CONTEXT_BYTES = 8 * 1024

type SnapshotPeer = Pick<PeerView, 'name' | 'status' | 'presence' | 'title' | 'notice'>

export type PeerStartSnapshotMode = 'none' | 'fresh' | 'jump'

type PeerStartContextOptions = {
  cwd: string
  mode: PeerStartSnapshotMode
  requestHost?: PeerHostRequester
}

export function getPeerStartSnapshotMode({
  managed,
  cwd,
  initialMessages,
  resumedInitialState,
  workspaceJump,
}: {
  managed: boolean
  cwd: string
  initialMessages?: readonly Message[]
  resumedInitialState?: AppState
  workspaceJump?: WorkspaceJumpState | null
}): PeerStartSnapshotMode {
  if (managed) return 'none'
  if (initialMessages?.some(message => {
    if (message.type !== 'attachment') return false
    const attachment = message.attachment
    return typeof attachment === 'object' && attachment !== null &&
      'type' in attachment && attachment.type === 'peer_roster_snapshot' &&
      'workspace' in attachment && attachment.workspace === cwd
  })) return 'none'
  if (resumedInitialState === undefined) return 'fresh'
  if (!workspaceJump) return 'none'
  try {
    const jump = upgradeWorkspaceJumpState(workspaceJump)
    // The replacement starts before main finishes its ready-controls wait and
    // records destination location. Startup has already validated the target cwd.
    const atDestination = jump.location === 'destination' ||
      (jump.location === 'unknown' && jump.phase === 'moving')
    return atDestination && jump.target.cwd === cwd &&
      (jump.continuation.outcome === 'pending' ||
        (jump.review.required && jump.review.reconciledInputUuid === null))
      ? 'jump'
      : 'none'
  } catch {
    return 'none'
  }
}

function snapshot(
  cwd: string,
  asOf: string,
  peers: SnapshotPeer[],
  omittedCount: number,
): PeerRosterSnapshotAttachment {
  return {
    type: 'peer_roster_snapshot',
    workspace: cwd,
    asOf,
    quotedRoster: quoteAsData(jsonStringify({
      peers,
      ...(peers.some(peer => peer.notice) ? { noticeContext: PEER_NOTICE_CONTEXT } : {}),
    })),
    ...(omittedCount > 0 ? { omittedCount } : {}),
  }
}

/** Jump admission can temporarily refuse peer access before committing input. */
export function createPeerStartContext({
  cwd,
  mode,
  requestHost = requestPeerHost,
}: PeerStartContextOptions): NonNullable<ToolUseContext['getTurnStartRuntimeAttachments']> {
  let pending = mode !== 'none'
  return async ({ agentId }) => {
    if (agentId !== undefined || !pending) return []
    pending = false

    // The host requester normally enforces this deadline. Race it as well so
    // an unavailable or non-cooperating requester cannot delay attachment loading.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        requestPeerRoster(requestHost, { timeoutMs: PEER_START_CONTEXT_TIMEOUT_MS }),
        new Promise<null>(resolve => {
          timer = setTimeout(() => resolve(null), PEER_START_CONTEXT_TIMEOUT_MS)
        }),
      ])
      if (!outcome?.ok) {
        if (mode === 'jump' && outcome?.error.code === 'session_not_found') pending = true
        return []
      }
      const rows = narrowPeerList(outcome.value)
      if (!rows) return []
      const peers: SnapshotPeer[] = rows
        .filter(peer => peer.status === 'live' || peer.status === 'parked')
        .map(peer => ({
          name: peer.name,
          status: peer.status,
          ...(peer.presence !== undefined ? { presence: peer.presence } : {}),
          title: peer.title,
          ...(peer.notice ? { notice: peer.notice } : {}),
        }))
      if (peers.length === 0) return []

      const asOf = new Date().toISOString()
      const selected: SnapshotPeer[] = []
      const encoder = new TextEncoder()
      for (const peer of peers) {
        if (selected.length >= MAX_PEER_START_CONTEXT_PEERS) break
        const candidate = snapshot(cwd, asOf, [...selected, peer], peers.length - selected.length - 1)
        if (encoder.encode(jsonStringify(candidate)).byteLength <= MAX_PEER_START_CONTEXT_BYTES) {
          selected.push(peer)
        }
      }
      if (selected.length === 0) return []
      return [snapshot(cwd, asOf, selected, peers.length - selected.length)]
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}
