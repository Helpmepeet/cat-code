import { MAX_PEER_NOTICE_BYTES, MAX_PEER_NOTICE_TOUCHES } from './limits.js'

export type PeerNoticeInput = {
  doing: string
  touches?: string[]
  note?: string
}

export type PeerNotice = PeerNoticeInput & { postedAt: number }

/** Opaque text only. In particular, touches are never interpreted as paths. */
export function parsePeerNoticeInput(value: unknown): PeerNoticeInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['doing', 'touches', 'note'].includes(key))) return null
  if (typeof input.doing !== 'string' || input.doing.trim() === '' || /[\r\n\u2028\u2029]/.test(input.doing)) return null
  if (input.note !== undefined && typeof input.note !== 'string') return null
  if (input.touches !== undefined && (
    !Array.isArray(input.touches) || input.touches.length > MAX_PEER_NOTICE_TOUCHES ||
    input.touches.some(text => typeof text !== 'string' || text.trim() === '')
  )) return null
  const notice: PeerNoticeInput = {
    doing: input.doing,
    ...(input.touches !== undefined ? { touches: [...input.touches] as string[] } : {}),
    ...(typeof input.note === 'string' ? { note: input.note } : {}),
  }
  return new TextEncoder().encode(JSON.stringify(notice)).byteLength <= MAX_PEER_NOTICE_BYTES ? notice : null
}

export function parsePeerNotice(value: unknown): PeerNotice | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { postedAt, ...input } = value as Record<string, unknown>
  if (typeof postedAt !== 'number' || !Number.isSafeInteger(postedAt) || postedAt < 0 || postedAt > 8.64e15) return null
  const notice = parsePeerNoticeInput(input)
  return notice ? { ...notice, postedAt } : null
}
