import { createHash } from 'node:crypto'
import type { ServerFrame, EventFrame } from '../../../app/shared/protocol.js'

// Synthetic inputs only. These intervals are declared workload assumptions,
// not rates observed from the user's provider or private sessions.
export const manifest = {
  version: 1,
  seed: 'streaming-2026-09-12-v1',
  warmupMs: 1_000,
  durationMs: 4_000,
  repetitions: 3,
  policies: ['original', '0', '8', '16'],
  workloads: [
    { id: 'sparse-1', sessions: 1, intervalMs: 100, history: 0, burst: 1, barrierEvery: 0 },
    { id: 'paced-4', sessions: 4, intervalMs: 20, history: 0, burst: 1, barrierEvery: 0 },
    { id: 'paced-8', sessions: 8, intervalMs: 20, history: 0, burst: 1, barrierEvery: 0 },
    { id: 'long-history-8', sessions: 8, intervalMs: 20, history: 1_200, burst: 1, barrierEvery: 0 },
    { id: 'burst-4', sessions: 4, intervalMs: 100, history: 0, burst: 5, barrierEvery: 0 },
    { id: 'barriers-4', sessions: 4, intervalMs: 20, history: 0, burst: 1, barrierEvery: 10 },
  ],
  historyTextCharacters: 400,
  deltaText: 'sample text ภาษาไทย ',
  aggregation: 'Report every sample and per-policy medians; compare identical workload hashes. Rotate policy order by repetition. No app-wide CPU/commit/battery claim from the headless tier.',
} as const

export type Workload = typeof manifest.workloads[number]
export type Arrival = { atMs: number; frame: ServerFrame; barrier: boolean }
type FixtureMessage = Extract<EventFrame['event'], { type: 'message' }>['message']
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function createFixture(workload: Workload, durationMs = manifest.durationMs) {
  const initial: ServerFrame[] = []
  const arrivals: Arrival[] = []
  let sequence = 0
  const sessionSequences = new Map<string, number>()
  const trace = (frame: ServerFrame): ServerFrame => {
    const sessionSequence = (sessionSequences.get(frame.sessionId) ?? 0) + 1
    sessionSequences.set(frame.sessionId, sessionSequence)
    sequence++
    return { ...frame, deliveryTrace: {
    streamEpoch: `epoch-${frame.sessionId}`,
    sequence: sessionSequence,
    traceId: `trace-${sequence}`,
    deliveryAttempt: 1,
    replay: false,
    sourceProcessInstanceId: `process-${frame.sessionId}`,
    sourceWallTimestamp: '2026-09-12T00:00:00.000Z',
    sourceMonotonicTimestampMs: 0,
    connectionEpoch: 1,
    } }
  }
  const event = (sessionId: string, value: EventFrame['event']): ServerFrame => trace({
    kind: 'event', protocolVersion: 1, sessionId, event: value,
  })
  const stream = (sessionId: string, value: unknown): ServerFrame => event(sessionId, {
    type: 'message',
    // Deliberately minimal synthetic SDK data, matching the projector fixtures.
    message: { type: 'stream_event', event: value, uuid: `message-${sequence + 1}` } as FixtureMessage,
  })
  for (let s = 0; s < workload.sessions; s++) {
    const sessionId = `benchmark-session-${s}`
    initial.push(trace({ kind: 'ready', protocolVersion: 1, sessionId,
      engineSessionId: `benchmark-engine-${s}`, payload: {
        type: 'app.ready', protocolVersion: 1, inputEnabled: false,
        activeTurn: true, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [],
      },
    }))
    for (let i = 0; i < workload.history; i++) initial.push(event(sessionId, {
      type: 'message', message: {
        type: 'assistant', uuid: `history-${s}-${i}`, parent_tool_use_id: null,
        session_id: sessionId, message: {
          id: `history-${s}-${i}`, role: 'assistant',
          content: [{ type: 'text', text: String(i).padEnd(manifest.historyTextCharacters, '.') }],
        },
      } as FixtureMessage,
    }))
    initial.push(stream(sessionId, { type: 'message_start', message: { id: `stream-${s}` } }))
    initial.push(stream(sessionId, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    initial.push(stream(sessionId, { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }))
    let ordinal = 0
    const phase = s * workload.intervalMs / workload.sessions
    for (let atMs = phase; atMs < durationMs; atMs += workload.intervalMs) {
      for (let b = 0; b < workload.burst; b++) {
        const thinking = (++ordinal % 5) === 0
        arrivals.push({ atMs: atMs + b * 0.2, barrier: false, frame: stream(sessionId, {
          type: 'content_block_delta', index: thinking ? 1 : 0,
          delta: thinking ? { type: 'thinking_delta', thinking: manifest.deltaText } : { type: 'text_delta', text: manifest.deltaText },
        }) })
      }
      if (workload.barrierEvery > 0 && ordinal % workload.barrierEvery === 0) {
        const request = { requestId: `permission-${s}-${ordinal}`, request: {
          subtype: 'can_use_tool' as const, tool_name: 'Bash',
          input: { command: 'synthetic command; never executed' }, tool_use_id: `tool-${s}-${ordinal}`,
        } }
        arrivals.push({ atMs: atMs + 0.3, barrier: true, frame: event(sessionId, { type: 'permission.requested', request }) })
        arrivals.push({ atMs: atMs + 1, barrier: true, frame: event(sessionId, { type: 'permission.resolved', request,
          response: { behavior: 'deny', message: 'Synthetic benchmark response' },
        }) })
      }
    }
    arrivals.push({ atMs: durationMs + s * 0.1, barrier: true, frame: stream(sessionId, { type: 'content_block_stop', index: 0 }) })
    arrivals.push({ atMs: durationMs + s * 0.1, barrier: true, frame: stream(sessionId, { type: 'content_block_stop', index: 1 }) })
    arrivals.push({ atMs: durationMs + s * 0.1, barrier: true, frame: event(sessionId, { type: 'turn.status', activeTurn: false }) })
  }
  arrivals.sort((a, b) => a.atMs - b.atMs)
  return { initial, arrivals, hash: digest({ initial, arrivals }) }
}
