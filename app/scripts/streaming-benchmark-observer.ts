import type { ServerFrame } from '../shared/protocol.js'

type Identity = { traceId: string; sequence: number; sessionId: string }
type Commit = { atMs: number; frames: Identity[]; rawMessageCount: number }

const pending: Identity[] = []
const commits: Commit[] = []
let dispatchCount = 0

export function benchmarkObserveBatch(frames: readonly ServerFrame[]): void {
  dispatchCount++
  for (const frame of frames) {
    const trace = frame.deliveryTrace
    if (!trace) continue
    pending.push({ traceId: trace.traceId, sequence: trace.sequence, sessionId: frame.sessionId })
  }
}

/** Called from an App layout effect whose dependency is the committed raw-log state. */
export function benchmarkObserveCommit(atMs: number, state?: unknown): void {
  if (pending.length === 0) return
  commits.push({ atMs, frames: pending.splice(0), rawMessageCount: countRawMessages(state) })
}

export function benchmarkObserverSnapshot() {
  return {
    dispatchCount,
    commitCount: commits.length,
    commits: commits.map(commit => ({ atMs: commit.atMs, rawMessageCount: commit.rawMessageCount, frames: commit.frames.map(frame => ({ ...frame })) })),
    pending: pending.map(frame => ({ ...frame })),
  }
}

export function resetBenchmarkObserver(): void {
  pending.length = 0
  commits.length = 0
  dispatchCount = 0
}

declare global {
  interface Window {
    __CATCODE_STREAMING_BENCHMARK__?: { snapshot: typeof benchmarkObserverSnapshot; reset: typeof resetBenchmarkObserver }
  }
}

if (typeof window !== 'undefined') {
  window.__CATCODE_STREAMING_BENCHMARK__ = { snapshot: benchmarkObserverSnapshot, reset: resetBenchmarkObserver }
}

function countRawMessages(value: unknown): number {
  if (!value || typeof value !== 'object') return -1
  const sessions = (value as { sessions?: unknown }).sessions
  if (!sessions || typeof sessions !== 'object') return -1
  let count = 0
  for (const session of Object.values(sessions)) {
    const messages = session && typeof session === 'object' ? (session as { messages?: unknown }).messages : null
    if (Array.isArray(messages)) count += messages.length
  }
  return count
}
