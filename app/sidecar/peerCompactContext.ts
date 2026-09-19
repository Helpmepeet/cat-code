import type {
  Attachment,
  PeerCoordinationStateAttachment,
} from '../../src/utils/attachments.js'
import type { PostCompactRuntimeAttachmentsInput } from '../../src/Tool.js'
import type { PeerDescriptor } from '../shared/protocol.js'
import {
  requestPeerHost,
  type PeerHostRequester,
} from './peerHostRequester.js'

export const PEER_COMPACT_CONTEXT_TIMEOUT_MS = 2_000
export const MAX_PEER_COMPACT_CONTEXT_PEERS = 32
export const MAX_PEER_COMPACT_CONTEXT_BYTES = 8 * 1024

type PeerCompactContextOptions = {
  appSessionId: string
  requestHost?: PeerHostRequester
}

type PeerCompactContextProvider = (
  input: PostCompactRuntimeAttachmentsInput,
) => Promise<Attachment[]>

function toSnapshotPeer(
  peer: PeerDescriptor,
): PeerCoordinationStateAttachment['peers'][number] {
  return {
    name: peer.name,
    status: peer.status,
    ...(peer.presence !== undefined ? { presence: peer.presence } : {}),
  }
}

function snapshotFits(
  asOf: string,
  peers: PeerCoordinationStateAttachment['peers'],
  omittedCount: number,
): boolean {
  const candidate: PeerCoordinationStateAttachment = {
    type: 'peer_coordination_state',
    asOf,
    peers,
    ...(omittedCount > 0 ? { omittedCount } : {}),
  }
  return (
    new TextEncoder().encode(JSON.stringify(candidate)).byteLength <=
    MAX_PEER_COMPACT_CONTEXT_BYTES
  )
}

function buildSnapshot(
  peers: PeerDescriptor[],
  asOf: string,
): PeerCoordinationStateAttachment | null {
  const ownedPeers = peers.filter(
    peer => peer.createdBy?.appSessionId !== undefined,
  )
  if (ownedPeers.length === 0) return null

  const selected: PeerCoordinationStateAttachment['peers'] = []
  for (const peer of ownedPeers) {
    const omittedCount = ownedPeers.length - selected.length - 1
    if (selected.length >= MAX_PEER_COMPACT_CONTEXT_PEERS) continue

    const candidate = [...selected, toSnapshotPeer(peer)]
    if (snapshotFits(asOf, candidate, omittedCount)) {
      selected.push(toSnapshotPeer(peer))
    }
  }

  if (selected.length === 0) return null

  const omittedCount = ownedPeers.length - selected.length
  return {
    type: 'peer_coordination_state',
    asOf,
    peers: selected,
    ...(omittedCount > 0 ? { omittedCount } : {}),
  }
}

/**
 * Provides a bounded, model-safe peer snapshot after compaction. The app
 * session ID is used only to filter the trusted host response; it never enters
 * the returned attachment.
 */
export function createPeerCompactContext({
  appSessionId,
  requestHost = requestPeerHost,
}: PeerCompactContextOptions): PeerCompactContextProvider {
  return async ({ agentId }) => {
    // A subagent can inherit the parent runtime options. It must not inherit
    // the parent's peer relationships or spend a host request to discover them.
    if (agentId !== undefined) return []

    try {
      const outcome = await requestHost(
        'peers.list',
        {},
        { timeoutMs: PEER_COMPACT_CONTEXT_TIMEOUT_MS },
      )
      if (!outcome.ok) return []

      const ownedPeers = outcome.value.peers.filter(
        peer => peer.createdBy?.appSessionId === appSessionId,
      )
      const snapshot = buildSnapshot(ownedPeers, new Date().toISOString())
      return snapshot ? [snapshot] : []
    } catch {
      // Peer restoration is advisory. Compaction must continue if the host
      // plane is unavailable or a requester fails unexpectedly.
      return []
    }
  }
}
