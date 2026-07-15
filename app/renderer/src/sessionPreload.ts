import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId, TranscriptCache } from '../../shared/protocol.js'
import {
  projectPreviewTranscriptCache,
  type PreviewTranscriptEntry,
  type PreviewTranscriptState,
} from './previewTranscriptState.js'

/**
 * Independent startup guards. Twelve reads bound main-thread cache validation;
 * 64 MiB bounds the projected renderer objects (not cache-file bytes). The
 * per-cache disk cap is 8 MiB, while projected strings and row objects expand
 * in memory, so the RAM limit intentionally admits fewer worst-case caches.
 */
export const STARTUP_PRELOAD_MAX_SESSIONS = 12
export const STARTUP_PRELOAD_MAX_PROJECTED_BYTES = 64 * 1024 * 1024
export const STARTUP_PRELOAD_THROTTLE_MS = 50

export type StartupPreloadResult = {
  eligible: number
  considered: number
  overScanBudget: number
  requested: number
  loaded: number
  misses: number
  stale: number
  overRamBudget: number
  failures: number
  projectedBytes: number
}

export type StartupPreloadCapacity = {
  retainedSessions: number
  retainedBytes: number
  remainingSessions: number
  remainingBytes: number
}

type StartupPreloadOptions = {
  descriptors: readonly SessionDescriptor[]
  previewSession: (sessionId: SessionId) => Promise<TranscriptCache | null>
  onLoad: (cache: TranscriptCache, projected: PreviewTranscriptEntry) => void
  isEligible: (sessionId: SessionId) => boolean
  isAlreadyLoaded: (sessionId: SessionId) => boolean
  isCancelled: () => boolean
  maxSessions?: number
  maxProjectedBytes?: number
  throttleMs?: number
  wait?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/** Most-recent-first is a preload policy only; it never mutates shell order. */
export function selectStartupPreloadCandidates(
  descriptors: readonly SessionDescriptor[],
  maxSessions = STARTUP_PRELOAD_MAX_SESSIONS,
): SessionDescriptor[] {
  return descriptors
    .filter(descriptor => descriptor.restorable)
    .slice()
    .sort((a, b) => b.lastAttachedAt - a.lastAttachedAt)
    .slice(0, Math.max(0, maxSessions))
}

/**
 * Approximate the heap retained by a projected preview. This walks the actual
 * TranscriptState graph and charges UTF-16 strings, object/array headers, and
 * reference slots. It deliberately does not use serialized cache bytes.
 */
export function estimateProjectedPreviewBytes(
  entry: PreviewTranscriptEntry,
): number {
  const seen = new WeakSet<object>()

  function estimate(value: unknown): number {
    if (value === null || value === undefined) return 0
    if (typeof value === 'boolean') return 4
    if (typeof value === 'number') return 8
    if (typeof value === 'string') return 16 + value.length * 2
    if (typeof value !== 'object') return 0
    if (seen.has(value)) return 0
    seen.add(value)

    if (Array.isArray(value)) {
      return (
        24 +
        value.length * 8 +
        value.reduce((sum, item) => sum + estimate(item), 0)
      )
    }

    let bytes = 32
    for (const [key, item] of Object.entries(value)) {
      bytes += 8 + 16 + key.length * 2 + estimate(item)
    }
    return bytes
  }

  return estimate(entry)
}

/** Current retained preview heap, used to keep late backfill admission bounded. */
export function estimateProjectedPreviewStateBytes(
  state: PreviewTranscriptState,
): number {
  return Object.values(state.bySession).reduce(
    (total, entry) => total + estimateProjectedPreviewBytes(entry),
    0,
  )
}

/**
 * Global PL-A/PL-B capacity, including entries dispatched but not yet visible
 * in React state. Reservations are keyed so a committed entry is never charged
 * twice when the next serialized preload job starts.
 */
export function calculateStartupPreloadCapacity(
  state: PreviewTranscriptState,
  reservations: ReadonlyMap<SessionId, number>,
  maxSessions = STARTUP_PRELOAD_MAX_SESSIONS,
  maxProjectedBytes = STARTUP_PRELOAD_MAX_PROJECTED_BYTES,
): StartupPreloadCapacity {
  const retainedIds = new Set(Object.keys(state.bySession))
  let retainedBytes = estimateProjectedPreviewStateBytes(state)
  for (const [sessionId, bytes] of reservations) {
    if (!retainedIds.has(sessionId)) {
      retainedIds.add(sessionId)
      retainedBytes += bytes
    }
  }
  return {
    retainedSessions: retainedIds.size,
    retainedBytes,
    remainingSessions: Math.max(0, maxSessions - retainedIds.size),
    remainingBytes: Math.max(0, maxProjectedBytes - retainedBytes),
  }
}

/**
 * Sequentially read existing caches after launch paint. Each call retains the
 * existing previewSession boundary and is separated by a yield so recursive
 * secret scans do not arrive as one launch-time main-thread burst.
 */
export async function runStartupTranscriptPreload(
  options: StartupPreloadOptions,
): Promise<StartupPreloadResult> {
  const maxSessions = options.maxSessions ?? STARTUP_PRELOAD_MAX_SESSIONS
  const maxProjectedBytes =
    options.maxProjectedBytes ?? STARTUP_PRELOAD_MAX_PROJECTED_BYTES
  const throttleMs = options.throttleMs ?? STARTUP_PRELOAD_THROTTLE_MS
  const wait =
    options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const log = options.log ?? (message => console.info(message))
  const candidates = selectStartupPreloadCandidates(
    options.descriptors,
    maxSessions,
  )
  const eligible = options.descriptors.filter(
    descriptor => descriptor.restorable,
  ).length
  const result: StartupPreloadResult = {
    eligible,
    considered: candidates.length,
    overScanBudget: Math.max(0, eligible - candidates.length),
    requested: 0,
    loaded: 0,
    misses: 0,
    stale: 0,
    overRamBudget: 0,
    failures: 0,
    projectedBytes: 0,
  }

  log(
    `[session-preload] start: newest-first, eligible=${eligible}, scan cap=${maxSessions}, scan overflow=${result.overScanBudget}, projected RAM cap=${maxProjectedBytes} bytes, throttle=${throttleMs}ms`,
  )

  for (const [index, descriptor] of candidates.entries()) {
    if (options.isCancelled()) break
    if (index > 0 && throttleMs > 0) await wait(throttleMs)
    if (options.isCancelled()) break
    const sessionId = descriptor.appSessionId
    if (!options.isEligible(sessionId) || options.isAlreadyLoaded(sessionId)) {
      result.stale += 1
      continue
    }

    result.requested += 1
    let cache: TranscriptCache | null
    try {
      cache = await options.previewSession(sessionId)
    } catch {
      result.failures += 1
      continue
    }
    if (options.isCancelled()) break
    if (!options.isEligible(sessionId) || options.isAlreadyLoaded(sessionId)) {
      result.stale += 1
      continue
    }
    if (!cache) {
      result.misses += 1
      continue
    }

    try {
      const projected = projectPreviewTranscriptCache(cache)
      const projectedBytes = estimateProjectedPreviewBytes(projected)
      if (result.projectedBytes + projectedBytes > maxProjectedBytes) {
        result.overRamBudget += 1
        continue
      }
      options.onLoad(cache, projected)
      result.loaded += 1
      result.projectedBytes += projectedBytes
    } catch {
      result.failures += 1
    }
  }

  log(
    `[session-preload] complete: loaded=${result.loaded}/${result.considered}, requested=${result.requested}, misses=${result.misses}, stale=${result.stale}, overRamBudget=${result.overRamBudget}, failures=${result.failures}, projectedBytes=${result.projectedBytes}`,
  )
  return result
}
