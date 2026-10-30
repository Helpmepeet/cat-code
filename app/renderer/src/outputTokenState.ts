import type { ServerFrame } from '../../shared/protocol.js'

export type OutputTokenReading = Readonly<{
  tokens: number
  quality: 'reported' | 'estimated' | 'unavailable'
}>
export const UNAVAILABLE_OUTPUT_TOKENS: OutputTokenReading = Object.freeze({ tokens: 0, quality: 'unavailable' })

const MAX_RESPONSES = 4096
const MAX_ASSISTANT_FRAMES = 8192
const MAX_BLOCKS = 1024
const MAX_ID = 256
const MAX_RECENT_STREAM_IDS = 256

type Response = {
  streamOwned: boolean
  streamChars: number
  assistantChars: number
  open: boolean
  started: boolean
  finalDelta: number | null
  streamFinal: number | null
  assistantFinal: number | null
}
type Session = {
  engineId: string | null
  ready: boolean
  active: boolean | null
  known: boolean
  epoch: number
  subtotal: number
  responses: Map<string, Response>
  assistantIds: Set<string>
  deliveryEpoch: string | null
  deliverySequence: number
  recentStreamIds: Set<string>
  blocks: Map<number, number>
  current: string | null
  reading: OutputTokenReading
}
export type OutputTokenState = { sessions: ReadonlyMap<string, Session> }
export type OutputTokenAction =
  | { type: 'frames'; frames: readonly ServerFrame[]; baseline?: boolean }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'session-reset'; sessionId: string }

export function createOutputTokenState(): OutputTokenState { return { sessions: new Map() } }
export function selectOutputTokens(state: OutputTokenState, sessionId: string | null): OutputTokenReading {
  return (sessionId && state.sessions.get(sessionId)?.reading) || UNAVAILABLE_OUTPUT_TOKENS
}
function fresh(): Session {
  return { engineId: null, ready: false, active: null, known: false, epoch: 0, subtotal: 0,
    responses: new Map(), assistantIds: new Set(), deliveryEpoch: null, deliverySequence: 0, recentStreamIds: new Set(),
    blocks: new Map(), current: null, reading: UNAVAILABLE_OUTPUT_TOKENS }
}
function clear(s: Session, known: boolean) {
  s.known = known
  s.subtotal = 0
  s.responses.clear()
  s.assistantIds.clear()
  s.recentStreamIds.clear()
  s.blocks.clear()
  s.current = null
}
function invalidate(s: Session) {
  // Keep a numeric diagnostic subtotal, but never expose a partial count.
  if (s.known) {
    let subtotal = 0
    for (const r of s.responses.values()) {
      const count = r.streamOwned ? r.streamChars : r.assistantChars
      const final = r.streamFinal ?? r.assistantFinal
      subtotal += final !== null && !(final === 0 && count > 0) ? final : count / 4
    }
    if (Number.isSafeInteger(Math.ceil(subtotal))) s.subtotal = Math.ceil(subtotal)
  }
  s.known = false
  s.responses.clear()
  s.assistantIds.clear()
  s.recentStreamIds.clear()
  s.blocks.clear()
  s.current = null
  s.reading = UNAVAILABLE_OUTPUT_TOKENS
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID }
function usage(value: unknown): number | null {
  const n = record(value)?.output_tokens
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null
}
function length(value: unknown): number { return typeof value === 'string' ? value.length : 0 }
function chars(block: Record<string, unknown> | null): number {
  if (block?.type === 'text') return length(block.text)
  if (block?.type === 'thinking') return length(block.thinking)
  return 0
}
function eligible(message: Record<string, unknown>, body: Record<string, unknown> | null): boolean {
  return (message.parent_tool_use_id == null || message.parent_tool_use_id === '') &&
    !message.error && message.isApiErrorMessage !== true && body?.model !== '<synthetic>'
}
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded'])
function response(s: Session, id: unknown): Response | null {
  if (!identifier(id)) { invalidate(s); return null }
  const prior = s.responses.get(id)
  if (prior) return prior
  if (s.responses.size >= MAX_RESPONSES) { invalidate(s); return null }
  const next: Response = { streamOwned: false, streamChars: 0, assistantChars: 0, open: false, started: false,
    finalDelta: null, streamFinal: null, assistantFinal: null }
  s.responses.set(id, next)
  return next
}
function refresh(s: Session) {
  if (!s.known) { s.reading = UNAVAILABLE_OUTPUT_TOKENS; return }
  let total = 0
  let estimated = false
  for (const r of s.responses.values()) {
    const count = r.streamOwned ? r.streamChars : r.assistantChars
    const final = r.streamFinal ?? r.assistantFinal
    if (final !== null && !(final === 0 && count > 0)) total += final
    else { total += count / 4; estimated = true }
    if (r.open) estimated = true
  }
  if (!Number.isSafeInteger(Math.ceil(total))) { invalidate(s); return }
  s.subtotal = Math.ceil(total)
  const quality = estimated ? 'estimated' : 'reported'
  if (s.reading.tokens !== s.subtotal || s.reading.quality !== quality) s.reading = { tokens: s.subtotal, quality }
}
function addChars(s: Session, r: Response, amount: number) {
  if (amount === 0) return
  r.streamOwned = true
  r.assistantChars = 0
  r.streamChars += amount
  if (!Number.isSafeInteger(r.streamChars)) invalidate(s)
}
function message(s: Session, m: Record<string, unknown>, frame: ServerFrame) {
  const e = record(m.event)
  const body = m.type === 'stream_event' ? record(e?.message) : record(m.message)
  if (!eligible(m, body)) {
    if ((m.parent_tool_use_id == null || m.parent_tool_use_id === '') &&
      m.type === 'stream_event' && e?.type === 'message_start') { s.current = null; s.blocks.clear() }
    return
  }
  if (m.type === 'assistant') {
    if (!body) return
    if (!identifier(m.uuid)) { invalidate(s); return }
    if (s.assistantIds.has(m.uuid)) return
    if (s.assistantIds.size >= MAX_ASSISTANT_FRAMES) { invalidate(s); return }
    const r = response(s, body.id)
    if (!r) return
    s.assistantIds.add(m.uuid)
    if (!r.streamOwned && Array.isArray(body.content)) {
      for (const block of body.content) {
        const b = record(block)
        r.assistantChars += chars(b)
        if (b?.type === 'tool_use') {
          // Serialization is transient; only its numeric size is retained.
          try { r.assistantChars += JSON.stringify(b.input ?? {}).length } catch { invalidate(s); return }
        }
      }
    }
    const n = usage(body.usage)
    if (n !== null && typeof body.stop_reason === 'string' && STOP_REASONS.has(body.stop_reason)) {
      r.assistantFinal = n
      if (s.current !== body.id) r.open = false
    }
    return
  }
  if (m.type !== 'stream_event' || !e) return
  // Compatibility deliveries without tracing rely on ordered live transport.
  // Keep recent UUIDs only; desktop redelivery uses the sequence cursor below.
  if (!frame.deliveryTrace && m.uuid !== undefined) {
    if (!identifier(m.uuid)) { invalidate(s); return }
    if (s.recentStreamIds.has(m.uuid)) return
    if (s.recentStreamIds.size === MAX_RECENT_STREAM_IDS) s.recentStreamIds.delete(s.recentStreamIds.values().next().value!)
    s.recentStreamIds.add(m.uuid)
  }
  if (e.type === 'message_start') {
    const r = response(s, body?.id)
    if (!r || !body) return
    // Re-delivery of a start must not reopen a completed response or lose blocks.
    if (s.current === body.id) {
      if (!frame.deliveryTrace) invalidate(s)
      return
    }
    if (r.started) {
      // A completed response may be re-delivered, but resuming an abandoned
      // response has no trustworthy delta boundary.
      invalidate(s)
      return
    }
    s.current = body.id as string
    s.blocks.clear()
    r.open = true
    r.started = true
    return
  }
  if (!s.current) {
    if (e.type === 'content_block_start' || e.type === 'content_block_delta' || e.type === 'message_delta') invalidate(s)
    return
  }
  const r = s.responses.get(s.current)
  if (!r) { invalidate(s); return }
  if (e.type === 'message_delta') {
    const n = usage(e.usage)
    // Delta usage is cumulative. It becomes final only at message_stop.
    if ('usage' in e) r.finalDelta = n
  } else if (e.type === 'message_stop') {
    r.streamFinal = r.finalDelta
    r.open = false
    s.current = null
    s.blocks.clear()
  } else if (e.type === 'content_block_start') {
    if (!Number.isSafeInteger(e.index) || (e.index as number) < 0) { invalidate(s); return }
    const index = e.index as number
    if (s.blocks.has(index)) return
    if (s.blocks.size >= MAX_BLOCKS) { invalidate(s); return }
    const b = record(e.content_block)
    // Keep all open indexes, but only numeric countable-kind tags.
    const kind = b?.type === 'text' ? 1 : b?.type === 'thinking' ? 2 : b?.type === 'tool_use' ? 3 : 0
    s.blocks.set(index, kind)
    if (kind) addChars(s, r, chars(b))
  } else if (e.type === 'content_block_delta') {
    const kind = s.blocks.get(e.index as number)
    const d = record(e.delta)
    if (kind === undefined && ['text_delta', 'thinking_delta', 'input_json_delta'].includes(String(d?.type))) {
      invalidate(s)
      return
    }
    if (kind === 1 && d?.type === 'text_delta') addChars(s, r, length(d.text))
    if (kind === 2 && d?.type === 'thinking_delta') addChars(s, r, length(d.thinking))
    if (kind === 3 && d?.type === 'input_json_delta') addChars(s, r, length(d.partial_json))
  } else if (e.type === 'content_block_stop') {
    s.blocks.delete(e.index as number)
  }
}

function acceptDelivery(s: Session, frame: ServerFrame): boolean {
  const trace = frame.deliveryTrace
  // The sidecar mints one increasing sequence per process stream. Attachment
  // replay preserves epoch/sequence and only changes deliveryAttempt/replay.
  // UUIDs alone cannot deduplicate an arbitrarily long stream in bounded space.
  if (!trace || !identifier(trace.streamEpoch) ||
    !Number.isSafeInteger(trace.sequence) || trace.sequence < 1) {
    invalidate(s)
    return false
  }
  if (s.known && s.deliveryEpoch !== null && s.deliveryEpoch !== trace.streamEpoch) {
    invalidate(s)
    return false
  }
  if (s.deliveryEpoch === trace.streamEpoch && trace.sequence <= s.deliverySequence) return false
  s.deliveryEpoch = trace.streamEpoch
  s.deliverySequence = trace.sequence
  return true
}

/** Original wire order is authoritative. Bootstrap only seeds lifecycle, never output. */
export function reduceOutputTokenState(state: OutputTokenState, action: OutputTokenAction): OutputTokenState {
  const sessions = new Map(state.sessions)
  if (action.type === 'session-removed') { sessions.delete(action.sessionId); return { sessions } }
  if (action.type === 'session-reset') {
    const old = sessions.get(action.sessionId)
    if (old) {
      const s = fresh()
      s.engineId = old.engineId
      s.ready = old.ready
      s.deliveryEpoch = old.deliveryEpoch
      s.deliverySequence = old.deliverySequence
      // An idle connection can establish the next edge; an active one cannot.
      s.active = old.active
      sessions.set(action.sessionId, s)
    }
    return { sessions }
  }
  const owned = new Set<string>()
  for (const frame of action.frames) {
    if (!('sessionId' in frame) || !identifier(frame.sessionId)) continue
    const id = frame.sessionId
    let s = sessions.get(id)
    if (!owned.has(id)) {
      s = s ? { ...s, responses: new Map([...s.responses].map(([key, r]) => [key, { ...r }])),
        assistantIds: new Set(s.assistantIds), recentStreamIds: new Set(s.recentStreamIds), blocks: new Map(s.blocks) } : fresh()
      sessions.set(id, s)
      owned.add(id)
    }
    if (!s) continue
    // Fold even bootstrap/history/inactive deliveries into the cursor. Otherwise
    // an old delta could be accepted after the next live turn boundary.
    if (frame.kind === 'event' && frame.deliveryTrace && !acceptDelivery(s, frame)) continue
    if (frame.kind === 'ready') {
      if (!s.ready || s.engineId !== frame.engineSessionId) {
        clear(s, false)
        s.engineId = identifier(frame.engineSessionId) ? frame.engineSessionId : null
        s.active = frame.payload.activeTurn
        s.ready = s.engineId !== null
        s.deliveryEpoch = null
        s.deliverySequence = 0
        if (frame.deliveryTrace) acceptDelivery(s, frame)
      }
    } else if (frame.kind === 'lifecycle' || (frame.kind === 'error' &&
      ['session_not_ready', 'session_not_found', 'session_disconnected'].includes(frame.code ?? ''))) {
      invalidate(s)
      s.ready = false
      s.active = null
    } else if (frame.kind === 'transcript.reset') {
      invalidate(s)
    } else if (frame.kind === 'event' && !frame.replay && !frame.recovered) {
      if (frame.event.type === 'turn.status') {
        const active = frame.event.activeTurn
        if (active && s.active === false && s.ready && !action.baseline) {
          clear(s, true)
          s.epoch++
        }
        s.active = active
        if (!active) { s.current = null; s.blocks.clear() }
      } else if (!action.baseline && s.ready && s.active && s.known && frame.event.type === 'message') {
        const m = record(frame.event.message)
        if (m) message(s, m, frame)
      }
    }
    if (action.baseline) invalidate(s)
  }
  for (const id of owned) refresh(sessions.get(id)!)
  return { sessions }
}
