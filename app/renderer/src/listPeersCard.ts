/**
 * The ListPeers card's model, read back from the tool result the model saw.
 *
 * The result is the sidecar's JSON roster (`listPeersTool.ts`
 * `mapToolResultToToolResultBlockParam`) with `&`, `<` and `>` entity-escaped
 * by `quoteAsData`. The card shows open sessions only (operator, 2026-10-17):
 * closed rows, model, effort, activity times and the model-facing notes stay in
 * the result for the agent and off the screen.
 *
 * Anything that does not narrow returns null, and the card falls back to the
 * raw result rather than drawing a roster that silently dropped a row.
 */

import { formatRunTime } from './scheduledTasksModel.js'

export type ListPeersState = 'running' | 'needs_user' | 'idle' | 'parked' | 'starting'

export type ListPeersNotice = {
  doing: string
  touches: string[]
  note: string | null
  postedAt: number
}

export type ListPeersRow = {
  name: string
  title: string | null
  state: ListPeersState
  notice: ListPeersNotice | null
}

function unescapeData(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNotice(value: unknown): ListPeersNotice | null | undefined {
  if (value === undefined) return null
  if (!isRecord(value)) return undefined
  const { doing, touches, note, postedAt } = value
  if (typeof doing !== 'string' || typeof postedAt !== 'string') return undefined
  const at = Date.parse(postedAt)
  if (Number.isNaN(at)) return undefined
  if (touches !== undefined && !(Array.isArray(touches) && touches.every(entry => typeof entry === 'string'))) {
    return undefined
  }
  if (note !== undefined && typeof note !== 'string') return undefined
  return {
    doing: unescapeData(doing),
    touches: (touches ?? []).map(unescapeData),
    note: note === undefined ? null : unescapeData(note),
    postedAt: at,
  }
}

function readState(status: unknown, presence: unknown): ListPeersState | 'closed' | null {
  switch (status) {
    case 'closed':
      return 'closed'
    case 'parked':
      return 'parked'
    case 'live':
      switch (presence) {
        case 'running':
        case 'needs_user':
        case 'idle':
          return presence
        case undefined:
          return 'starting'
        default:
          return null
      }
    default:
      return null
  }
}

/** The open sessions in a ListPeers result, or null when it is not a roster. */
export function parseListPeersResult(content: string): { peers: ListPeersRow[]; nextCursor?: string; remainingPeers?: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.peers)) return null
  if (parsed.nextCursor !== undefined && (typeof parsed.nextCursor !== 'string' || !parsed.nextCursor.length
    || !Number.isSafeInteger(parsed.remainingPeers) || (parsed.remainingPeers as number) < 0)) return null
  if (parsed.nextCursor === undefined && parsed.remainingPeers !== undefined) return null
  const rows: ListPeersRow[] = []
  for (const peer of parsed.peers) {
    if (!isRecord(peer) || typeof peer.name !== 'string' || peer.name.length === 0) return null
    const state = readState(peer.status, peer.presence)
    if (state === null) return null
    if (state === 'closed') continue
    const notice = readNotice(peer.notice)
    if (notice === undefined) return null
    const title = typeof peer.title === 'string' && peer.title.length > 0 ? unescapeData(peer.title) : null
    rows.push({ name: unescapeData(peer.name), title, state, notice })
  }
  return {
    peers: rows,
    ...(typeof parsed.nextCursor === 'string' ? {
      nextCursor: unescapeData(parsed.nextCursor),
      remainingPeers: parsed.remainingPeers as number,
    } : {}),
  }
}

/** Wall time of a notice; today's notices carry no day label. */
export function formatNoticePostedAt(postedAt: number, now: number, timeZone?: string): string {
  const label = formatRunTime(postedAt, now, timeZone)
  return label.startsWith('Today ') ? label.slice('Today '.length) : label
}

/** Accessible name for a row's state dot; parked rows draw no dot. */
export const LIST_PEERS_STATE_LABEL: Readonly<Record<ListPeersState, string>> = {
  running: 'Running',
  needs_user: 'Waiting on the user',
  idle: 'Idle',
  parked: 'Parked',
  starting: 'Starting',
}
