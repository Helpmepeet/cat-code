/**
 * Transcript cache — the at-rest "instant session open" artifact + codec (M1 of
 * docs/migration/specs/2026-07-14-instant-session-open-design.md; file-level
 * scoping in the companion implementation-plan, IS-A).
 *
 * On session close/quit, main distills a session's replay-buffer frames to a
 * transcript-only `TranscriptCache` and persists it here; the renderer fetches
 * one by id over the read-only `previewSession` bridge method to render a dead
 * session's transcript instantly, before any sidecar spawn.
 *
 * Security posture (approved 2026-07-14; SECURITY-MINIMUM trust-domain parity
 * with the transcript JSONL already at rest engine-side):
 *   - Content is an ALLOWLIST: only message `event` frames + the truncation-
 *     boundary error frame survive `distill`. `ready`, permission frames, and
 *     every operational snapshot (accounts/settings/tasks/goals/agent-config/
 *     extensions/diagnostics) are dropped, so cache hydration can mark nothing
 *     connected/input-enabled and resurrect no stale actionable prompt
 *     (`app/renderer/src/serverFrameBatch.ts` fan-out rationale).
 *   - Writes are atomic (temp file + fsync + rename) with 0700 dir / 0600 file
 *     (the `registry.ts:896` `atomicWriteJson` idiom), synchronous so the quit
 *     path (`host.shutdownAll` — synchronous) can persist before the process exits.
 *   - Reads are FAIL-CLOSED: size-bounded BEFORE parse, runtime schema-validated,
 *     then re-scanned with the CURRENT `scanForSecrets` (`app/shared/secretGuard.ts`).
 *     Any oversize / corruption / schema drift / version mismatch / secret hit ⇒
 *     the cache is discarded AND the file deleted. The read-time re-scan closes
 *     guard-drift completely (design Q3 resolution): a frame the current guard
 *     would block can never replay from an old cache, with no engine import (main
 *     stays engine-free — `scanForSecrets` is a pure shared-layer module).
 *   - The id is a UUID-shaped filename component; a malformed id never reaches the
 *     filesystem (path-traversal defense in depth), independent of the host's
 *     `canPreview` gate main applies before calling `readCache`.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionId,
  type TranscriptCache,
} from '../shared/protocol.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import { DEFAULT_MAX_BUFFERED_BYTES, isReplayTruncationFrame } from './replayBuffer.js'

/**
 * Guard-drift fast-path stamp. This is a NEW constant main OWNS (there is no
 * engine `guardVersion` to mirror — design Q3): bump it whenever `SECRET_KEYS` in
 * `app/shared/secretGuard.ts` changes, so an old cache written under the previous
 * guard is discarded on read even before the read-time re-scan runs.
 */
export const TRANSCRIPT_CACHE_GUARD_VERSION = 1

/**
 * Stamped for diagnostics only — reads gate on `protocolVersion` + `guardVersion`,
 * never on this (transcript frames are protocol-versioned, and an app update must
 * not silently nuke every cached transcript). Matches `app/package.json` version.
 */
const TRANSCRIPT_CACHE_APP_VERSION = '0.0.0'

/**
 * Read size cap: the distilled cache is a SUBSET of one session's replay buffer
 * (≤ `DEFAULT_MAX_BUFFERED_BYTES`), plus the JSON envelope + header. Reject any
 * file larger than this BEFORE parsing (parse-DoS defense).
 */
export const MAX_TRANSCRIPT_CACHE_BYTES = DEFAULT_MAX_BUFFERED_BYTES + 256 * 1024

/** Cache files live beside the registry: `<registryDir>/transcript-cache`. */
export const TRANSCRIPT_CACHE_SUBDIR = 'transcript-cache'

const CACHE_FILE_SUFFIX = '.json'

/** UUID v1–v5 shape — same membership pre-check the host uses (`host.ts:88`). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/**
 * The distill allowlist: keep only transcript-bearing frames. A `ready`,
 * permission, snapshot, pong, lifecycle, result, or session-title frame is
 * DROPPED so a replayed cache can touch nothing but transcript rows.
 */
function isTranscriptCacheFrame(frame: ServerFrame): boolean {
  if (frame.kind === 'event') return true
  // The two visible-lossiness boundary idioms (both error frames): main's own
  // replay-buffer truncation and the sidecar's history-replay truncation. Keeping
  // them preserves the "this transcript is incomplete" marker; every OTHER error
  // frame (session_not_found, bad_request, …) is dropped.
  if (frame.kind === 'error') {
    return (
      isReplayTruncationFrame(frame) ||
      frame.requestId === HISTORY_REPLAY_TRUNCATION_REQUEST_ID
    )
  }
  return false
}

/**
 * Distill one session's replay-buffer frames (as returned by
 * `FrameReplayBuffer.snapshotSession`, which INCLUDES the permanent `ready` head)
 * into a versioned transcript-only cache. The `ready` head is read for the
 * two-id header fields, then dropped by the allowlist. Pure + synchronous.
 */
export function distill(frames: ServerFrame[]): TranscriptCache {
  const ready = frames.find(frame => frame.kind === 'ready')
  const kept = frames.filter(isTranscriptCacheFrame)
  const appSessionId =
    (ready?.sessionId ?? kept[0]?.sessionId ?? frames[0]?.sessionId ?? '')
  const engineSessionId =
    ready && ready.kind === 'ready' ? ready.engineSessionId : null
  return createTranscriptCache(appSessionId, engineSessionId, kept)
}

/**
 * Build the same cache envelope for a transcript-only frame set produced by the
 * PL-B worker. Main calls this only after strict worker-boundary validation and
 * a fresh non-live/restorable race check; keeping envelope construction here
 * makes on-close and backfilled caches round-trip through the exact same codec.
 */
export function createTranscriptCache(
  appSessionId: SessionId,
  engineSessionId: string | null,
  frames: ServerFrame[],
): TranscriptCache {
  return {
    header: {
      appSessionId,
      engineSessionId,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: TRANSCRIPT_CACHE_APP_VERSION,
      guardVersion: TRANSCRIPT_CACHE_GUARD_VERSION,
      writtenAt: Date.now(),
    },
    frames,
  }
}

/** `<registryDir>/transcript-cache` — main passes its real registry dir. */
export function transcriptCacheDir(registryDir: string): string {
  return join(registryDir, TRANSCRIPT_CACHE_SUBDIR)
}

function cacheFilePath(dir: string, id: SessionId): string | null {
  if (!isUuid(id)) return null
  return join(dir, `${id}${CACHE_FILE_SUFFIX}`)
}

/**
 * Persist a cache atomically (temp + fsync + rename, 0700 dir / 0600 file).
 * Synchronous so the synchronous quit path can persist before the process exits.
 * A malformed / never-ready header id is skipped (nothing restorable to serve).
 */
export function writeCache(dir: string, cache: TranscriptCache): void {
  const filePath = cacheFilePath(dir, cache.header.appSessionId)
  if (!filePath) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmpPath = join(
    dir,
    `.${cache.header.appSessionId}.${process.pid}.${randomUUID()}.tmp`,
  )
  const json = JSON.stringify(cache)
  let fd: number | undefined
  try {
    fd = openSync(tmpPath, 'w', 0o600)
    writeFileSync(fd, json, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmpPath, filePath)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    throw error
  }
}

/**
 * Read + validate a cache by id, FAIL-CLOSED. Returns the cache only when every
 * gate passes; on ANY failure it returns null AND deletes the file:
 *   1. id is UUID-shaped (else null, no disk touch);
 *   2. file exists and is ≤ MAX_TRANSCRIPT_CACHE_BYTES (checked BEFORE read);
 *   3. JSON parses to the `TranscriptCache` shape (header + allowlisted frames);
 *   4. header.appSessionId === id, protocolVersion + guardVersion match;
 *   5. `scanForSecrets` finds no known-secret key in the parsed frames.
 */
export function readCache(dir: string, id: SessionId): TranscriptCache | null {
  const filePath = cacheFilePath(dir, id)
  if (!filePath) return null
  if (!existsSync(filePath)) return null

  try {
    if (statSync(filePath).size > MAX_TRANSCRIPT_CACHE_BYTES) {
      return discard(filePath)
    }
    const raw = readFileSync(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const cache = parseTranscriptCache(parsed)
    if (!cache) return discard(filePath)
    if (
      cache.header.appSessionId !== id ||
      cache.header.protocolVersion !== PROTOCOL_VERSION ||
      cache.header.guardVersion !== TRANSCRIPT_CACHE_GUARD_VERSION
    ) {
      return discard(filePath)
    }
    // Guard-drift closer: re-run the CURRENT guard on the parsed frames. A frame
    // the current guard would block never replays from an old cache.
    if (!scanForSecrets(cache.frames).ok) return discard(filePath)
    return cache
  } catch {
    // Corruption (unreadable / non-JSON / stat race): discard fail-closed.
    return discard(filePath)
  }
}

/** Delete a cache file by id (reap / GC). Tolerates a missing file. */
export function deleteCache(dir: string, id: SessionId): void {
  const filePath = cacheFilePath(dir, id)
  if (!filePath) return
  try {
    unlinkSync(filePath)
  } catch {
    // Already gone / never written — nothing to do.
  }
}

/** The appSessionIds with a cache file on disk (startup GC enumeration). */
export function listCachedSessionIds(dir: string): SessionId[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const ids: SessionId[] = []
  for (const name of entries) {
    if (!name.endsWith(CACHE_FILE_SUFFIX)) continue
    const id = name.slice(0, -CACHE_FILE_SUFFIX.length)
    if (isUuid(id)) ids.push(id)
  }
  return ids
}

/**
 * Pure preview orchestration (handler-testable without Electron / disk): the
 * cache is read ONLY for an id the host vouches for as restorable. An
 * unknown / non-restorable / LIVE id returns null WITHOUT touching disk (the
 * boundary-test guarantee — main never reads a cache the host does not vouch for).
 */
export function resolvePreview(
  deps: {
    canPreview: (id: SessionId) => boolean
    readCache: (id: SessionId) => TranscriptCache | null
  },
  id: unknown,
): TranscriptCache | null {
  if (typeof id !== 'string' || id.length === 0) return null
  if (!deps.canPreview(id)) return null
  return deps.readCache(id)
}

function discard(filePath: string): null {
  try {
    unlinkSync(filePath)
  } catch {
    // ignore
  }
  return null
}

/** Runtime-narrow an unknown parse to `TranscriptCache`, or null. Fail-closed. */
function parseTranscriptCache(value: unknown): TranscriptCache | null {
  if (!isRecord(value)) return null
  const header = value.header
  const frames = value.frames
  if (!isRecord(header)) return null
  if (
    typeof header.appSessionId !== 'string' ||
    !(typeof header.engineSessionId === 'string' || header.engineSessionId === null) ||
    typeof header.protocolVersion !== 'number' ||
    typeof header.appVersion !== 'string' ||
    typeof header.guardVersion !== 'number' ||
    typeof header.writtenAt !== 'number'
  ) {
    return null
  }
  if (!Array.isArray(frames)) return null
  for (const frame of frames) {
    // Schema-drift gate: every frame must be a valid ServerFrame that is on the
    // transcript allowlist. A non-allowlisted (or malformed) frame fails the read.
    if (!isRecord(frame) || typeof frame.kind !== 'string') return null
    if (!isTranscriptCacheFrame(frame as unknown as ServerFrame)) return null
  }
  return value as unknown as TranscriptCache
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
