import type { ServerFrame } from '../shared/protocol.js'

const MAX_IDENTITIES = 50_000
const MAX_COMMITS = 50_000
type Identity = { traceId: string; sequence: number; sessionId: string; generation: number }
type Commit = { atMs: number; frames: Omit<Identity, 'generation'>[]; rawMessageCount: number }

const lineage = new WeakMap<object, readonly Identity[]>()
const committed = new Set<string>()
const commits: Commit[] = []
let dispatchCount = 0
let noRawStateChangeCount = 0
let generation = 0
let overflowed = false
let layoutCommitCount = 0

export function benchmarkObserveBatch(frames: readonly ServerFrame[]): void {
  dispatchCount++
  if (frames.length > MAX_IDENTITIES) overflowed = true
}

export function benchmarkWrapRawReducer<S>(reducer: (state: S, frame: ServerFrame) => S) {
  return (state: S, frame: ServerFrame): S => {
    const next = reducer(state, frame)
    const identity = identityOf(frame)
    if (next === state) {
      if (identity) noRawStateChangeCount++
      return next
    }
    if (next && typeof next === 'object') {
      const prior = state && typeof state === 'object' ? lineage.get(state as object) ?? [] : []
      const additions = identity ? [identity] : []
      const combined = [...prior.filter(item => item.generation === generation && !committed.has(item.traceId)), ...additions]
      if (combined.length > MAX_IDENTITIES) overflowed = true
      else lineage.set(next as object, combined)
    }
    return next
  }
}

/** Layout-phase endpoint: only identities in this exact committed state lineage qualify. */
export function benchmarkObserveCommit(atMs: number, state?: unknown): void {
  layoutCommitCount++
  if (!state || typeof state !== 'object') return
  const frames = (lineage.get(state as object) ?? []).filter(item => item.generation === generation && !committed.has(item.traceId))
  if (frames.length === 0) return
  if (commits.length >= MAX_COMMITS || committed.size + frames.length > MAX_IDENTITIES) {
    overflowed = true
    return
  }
  for (const frame of frames) committed.add(frame.traceId)
  commits.push({ atMs, rawMessageCount: countRawMessages(state), frames: frames.map(({ generation: _generation, ...frame }) => frame) })
}

export function benchmarkObserverSnapshot() {
  return {
    dispatchCount,
    commitCount: commits.length,
    commits: commits.map(commit => ({ ...commit, frames: commit.frames.map(frame => ({ ...frame })) })),
    committedFrameCount: committed.size,
    noRawStateChangeCount,
    overflowed,
    layoutCommitCount,
  }
}

export type BenchmarkObserverSnapshot = ReturnType<typeof benchmarkObserverSnapshot>

/** Exact completion: incomplete, overflowed, and over-counted samples all fail. */
export function benchmarkCoverageComplete(snapshot: BenchmarkObserverSnapshot, expected: number): boolean {
  return Number.isSafeInteger(expected) && expected >= 0 && !snapshot.overflowed && snapshot.committedFrameCount === expected
}

export function resetBenchmarkObserver(): void {
  generation++
  committed.clear()
  commits.length = 0
  dispatchCount = 0
  noRawStateChangeCount = 0
  overflowed = false
  layoutCommitCount = 0
}

declare global {
  interface Window {
    __CATCODE_STREAMING_BENCHMARK__?: { snapshot: typeof benchmarkObserverSnapshot; reset: typeof resetBenchmarkObserver }
  }
}
if (typeof window !== 'undefined') window.__CATCODE_STREAMING_BENCHMARK__ = { snapshot: benchmarkObserverSnapshot, reset: resetBenchmarkObserver }

function identityOf(frame: ServerFrame): Identity | null {
  const trace = frame.deliveryTrace
  return trace ? { traceId: trace.traceId, sequence: trace.sequence, sessionId: frame.sessionId, generation } : null
}
function countRawMessages(value: unknown): number {
  const sessions = value && typeof value === 'object' ? (value as { sessions?: unknown }).sessions : null
  if (!sessions || typeof sessions !== 'object') return -1
  return Object.values(sessions).reduce((count, session) => {
    const messages = session && typeof session === 'object' ? (session as { messages?: unknown }).messages : null
    return count + (Array.isArray(messages) ? messages.length : 0)
  }, 0)
}
