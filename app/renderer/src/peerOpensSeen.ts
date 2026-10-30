import type { SessionId } from '../../shared/protocol.js'
import type { DismissalStorage } from './sessionDismissal.js'

/**
 * The `peerOpenedAt` each session last showed the user. A value that differs
 * from the descriptor's means a peer brought the session in since then. Saved
 * so a renderer reload does not lose the mark or raise it again.
 */
export type PeerOpensSeen = Readonly<Record<SessionId, number>>

export const PEER_OPENS_SEEN_KEY = 'cat-code.peer-opens-seen.v1'

export function readPeerOpensSeen(storage: DismissalStorage | null): PeerOpensSeen {
  try {
    const raw = storage?.getItem(PEER_OPENS_SEEN_KEY)
    if (!raw) return {}
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        Object.values(value).some(stamp => typeof stamp !== 'number')) {
      console.warn('Ignoring unreadable peer-opened tab marks.')
      return {}
    }
    return value as PeerOpensSeen
  } catch (error) {
    console.warn('Ignoring unreadable peer-opened tab marks.', error)
    return {}
  }
}

export function writePeerOpensSeen(storage: DismissalStorage | null, seen: PeerOpensSeen): void {
  try {
    storage?.setItem(PEER_OPENS_SEEN_KEY, JSON.stringify(seen))
  } catch (error) {
    // Worst case a tab the user already opened is marked again after a reload.
    console.warn('Could not save peer-opened tab marks.', error)
  }
}
