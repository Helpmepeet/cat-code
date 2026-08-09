/**
 * Transcript cache — the at-rest "instant session open" artifact + codec (M1 of
 * docs/migration/specs/2026-07-14-instant-session-open-design.md; file-level
 * scoping in the companion implementation-plan, IS-A).
 *
 * On session close/quit, main distills a session's replay-buffer frames to a
 * transcript-only `TranscriptCache`, enriches the header with the run facts the
 * frames cannot carry (`buildClosedSessionCache`), and persists it here; the
 * renderer fetches one by id over the read-only `previewSession` bridge method
 * to render a dead session's transcript instantly, before any sidecar spawn.
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
 *     the cache is discarded AND the file deleted. The re-scan walks the FRAMES,
 *     not the header: the header is a closed set of scalars, schema-validated
 *     field by field on every read and holding nothing the key-name guard could
 *     match, but it is NOT guarded, so a new header field must be judged on that
 *     basis rather than assumed covered. The read-time re-scan closes
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
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { TranscriptRunFactsRead } from '../shared/transcriptRunFacts.js'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionId,
  type TranscriptCache,
  type TranscriptCacheHeader,
  type TranscriptRunFacts,
} from '../shared/protocol.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import { DEFAULT_MAX_BUFFERED_BYTES, isReplayTruncationFrame } from './replayBuffer.js'
import { parseTranscriptRunFacts } from '../shared/transcriptBackfill.js'

/**
 * Guard-drift fast-path stamp. This is a NEW constant main OWNS (there is no
 * engine `guardVersion` to mirror — design Q3): bump it whenever `SECRET_KEYS` in
 * `app/shared/secretGuard.ts` changes, so an old cache written under the previous
 * guard is discarded on read even before the read-time re-scan runs.
 */
export const TRANSCRIPT_CACHE_GUARD_VERSION = 1

/**
 * Which generation of run-facts derivation this build writes. Bump whenever
 * `readTranscriptRunFacts` learns to derive a NEW fact, so caches carrying the
 * older, thinner facts are refreshed instead of counting as done.
 *
 * Unlike `TRANSCRIPT_CACHE_GUARD_VERSION`, a bump here never discards a cache:
 * it only re-reads the transcript to enrich the header. That is the whole point
 * of a separate stamp.
 *
 * 1: model, permissionMode, effort, usedTokens, contextWindow.
 */
export const TRANSCRIPT_CACHE_RUN_FACTS_VERSION = 1

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
  if (frame.kind === 'event') {
    const event: unknown = frame.event
    if (!isRecord(event) || event.type !== 'message') return false
    const message = event.message
    return isRecord(message) && typeof message.type === 'string'
  }
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
  /**
   * Supplied by whichever writer read the raw transcript: the PL-B worker, or
   * the close path via `buildClosedSessionCache`. Omitted when neither could
   * derive a COMPLETE set, and the renderer then falls back to reading what the
   * FRAMES still carry (model, mode, usage, and the exact window off a live
   * `result`).
   *
   * The frames are not structurally incapable of naming an effort:
   * `selectRunFactsFromFrames` reads one off a `system`/`codex_send_path`
   * message, and the distill allowlist keeps those. They just very often do not
   * have one — it rides Codex WS completions only, and the bounded replay buffer
   * may have dropped it. The cache behind the reported defect held zero such
   * records against a transcript that recorded `effort: high`.
   */
  runFacts?: TranscriptRunFacts,
): TranscriptCache {
  return {
    header: {
      appSessionId,
      engineSessionId,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: TRANSCRIPT_CACHE_APP_VERSION,
      guardVersion: TRANSCRIPT_CACHE_GUARD_VERSION,
      writtenAt: Date.now(),
      ...(runFacts
        ? { runFacts, runFactsVersion: TRANSCRIPT_CACHE_RUN_FACTS_VERSION }
        : {}),
    },
    frames,
  }
}

/**
 * The run facts a close/park/crash write should carry, or `undefined` to write
 * no header at all.
 *
 * ## Why a gate rather than "write whatever we derived"
 *
 * The renderer trusts a header WHOLESALE: `selectPreviewRunFacts` returns the
 * header's five fields and never consults the frames again
 * (`previewTranscriptState.ts`). That is correct — a header is one coherent
 * snapshot and merging a frame-derived value into it rebuilds the incoherence
 * the snapshot exists to remove — but it means a THIN header is worse than no
 * header. An on-close cache's frames still carry a live `result`, so the
 * fallback can name the model, the permission mode, the usage AND the exact
 * context window the run reported. Writing `{effort}` with the rest null would
 * trade all four of those for one, and swap a real 372k window for the 200k
 * default.
 *
 * So the header is written only when it is complete on every field the frame
 * fallback could otherwise supply: model, permissionMode, usedTokens,
 * contextWindow. `effort` is deliberately NOT required — it is null for every
 * provider-default (non-Codex) session, and it is the one fact frames can never
 * recover, which is the whole reason this path exists.
 *
 * ## Why an existing cache is an input
 *
 * A close must not flatten a cache the backfill worker already enriched. That
 * worker had the engine's window resolver; main does not. So a legacy
 * transcript (no `run_facts` record, hence no recorded window) re-derived at
 * close would fail the gate and drop back to a headerless write, losing the
 * effort and window a previous launch had already established. Existing facts
 * fill the gaps instead — but only when they describe the SAME model, since
 * that is what makes the window they carry the right one, and only from the
 * current derivation version.
 *
 * So the guarantee is narrower than "a close never flattens an enriched cache":
 * a legacy transcript whose model CHANGED since that cache was written still
 * writes a headerless one. It degrades safely (the frame fallback answers, and
 * `cacheHasCurrentRunFacts` then queues the row for re-backfill on the next
 * launch), but it is a real gap, not a covered case.
 */
export function resolveCacheRunFacts(
  derived: TranscriptRunFacts,
  existing: TranscriptRunFacts | null,
  /**
   * The derivation found a `system`/`run_facts` snapshot, so its fields are one
   * coherent request and NOTHING may be patched into them. Above all `effort`:
   * on this tier `null` means the run used the provider default, and borrowing
   * a cached `high` over it reports an effort that run never used. Only the
   * legacy byproduct tier, where `null` really does mean "no record said",
   * permits the fill-the-gaps merge below.
   */
  authoritative = false,
): TranscriptRunFacts | undefined {
  // A POSITIVE model match, never merely "the derivation said nothing".
  //
  // Allowing a null derived model to borrow was wrong in a way the renderer
  // makes expensive: with the transcript unreadable or its row gone, EVERY
  // field came from the prior header, so a complete-looking one was written
  // whose `usedTokens` predates the cache's own frames — and the renderer
  // trusts a header wholesale, so the donut would report a count older than the
  // transcript beside it. With no evidence, write no header and let the frame
  // fallback answer; it is derived from those very frames.
  const prior =
    !authoritative &&
    existing !== null &&
    derived.model !== null &&
    derived.model === existing.model
      ? existing
      : null
  const merged: TranscriptRunFacts = {
    model: derived.model ?? prior?.model ?? null,
    permissionMode: derived.permissionMode ?? prior?.permissionMode ?? null,
    effort: derived.effort ?? prior?.effort ?? null,
    usedTokens: derived.usedTokens ?? prior?.usedTokens ?? null,
    contextWindow: derived.contextWindow ?? prior?.contextWindow ?? null,
  }
  const complete =
    merged.model !== null &&
    merged.permissionMode !== null &&
    merged.usedTokens !== null &&
    merged.contextWindow !== null
  return complete ? merged : undefined
}

/**
 * Build the cache a close/park/crash persist should write, or null when there
 * is nothing worth writing.
 *
 * The pure half of main's `persistTranscriptCache`, extracted so the run-facts
 * decision is testable without Electron. Same order every eviction point uses:
 * distill the snapshot, then enrich the header from the session's own transcript
 * on disk.
 *
 * Reading that transcript is a synchronous full-file scan, on a path that
 * includes the quit sequence. Measured 2026-08-09 on this machine: 1.9 ms for a
 * 1.1 MB transcript, 22.9 ms for the largest one present (13 MB). That is the
 * budget being spent, and it buys a cache that is complete the moment it is
 * written rather than one that stays thin until the next launch's backfill.
 *
 * Main stays engine-free: the resolver the worker injects is deliberately
 * absent here, so a window is only ever a number the ENGINE already recorded
 * (`run_facts`) or one an enriched cache already holds.
 */
export function buildClosedSessionCache(
  deps: {
    /** The session's engine transcript, or null when its path is unknowable. */
    transcriptPath: (engineSessionId: string) => string | null
    readRunFacts: (transcriptPath: string) => TranscriptRunFactsRead
    readCachedRunFacts: (
      appSessionId: SessionId,
      engineSessionId: string | null,
    ) => TranscriptRunFacts | null
  },
  frames: ServerFrame[],
): TranscriptCache | null {
  const base = distill(frames)
  // Never restorable without an engineSessionId, so a cache would never be
  // served for it.
  if (base.header.engineSessionId === null) return null
  // The pre-distill snapshot always has a head plus state snapshots, so a frame
  // count taken before distilling never catches a session closed before its
  // first turn. Distilling drops all of those, and a cache with no transcript
  // frames is worse than no cache: the renderer treats a readable cache as a
  // preview and shows a loading placeholder for a transcript that never arrives.
  if (base.frames.length === 0) return null

  const path = deps.transcriptPath(base.header.engineSessionId)
  const read =
    path === null
      ? { facts: EMPTY_RUN_FACTS, authoritative: false }
      : deps.readRunFacts(path)
  const runFacts = resolveCacheRunFacts(
    read.facts,
    deps.readCachedRunFacts(base.header.appSessionId, base.header.engineSessionId),
    read.authoritative,
  )
  if (!runFacts) return base
  return createTranscriptCache(
    base.header.appSessionId,
    base.header.engineSessionId,
    base.frames,
    runFacts,
  )
}

/**
 * Whether a facts object says ANYTHING. The floor both writers share.
 *
 * An all-null header is pure loss: it can beat no frame fallback anywhere, and
 * the renderer stops consulting frames the moment a header exists. It is
 * reachable — an unreadable transcript yields exactly this — so it is refused
 * rather than stamped current.
 */
export function hasAnyRunFact(facts: TranscriptRunFacts): boolean {
  return (
    facts.model !== null ||
    facts.permissionMode !== null ||
    facts.effort !== null ||
    facts.usedTokens !== null ||
    facts.contextWindow !== null
  )
}

const EMPTY_RUN_FACTS: TranscriptRunFacts = {
  model: null,
  permissionMode: null,
  effort: null,
  usedTokens: null,
  contextWindow: null,
}

/**
 * Whether a cache carries CURRENT run facts.
 *
 * Backfill discovery uses this to REFRESH a cache whose facts predate the
 * current derivation, instead of discarding it: an old cache still previews
 * correctly, so destroying it to gain a display detail would be a strictly
 * worse trade. (Bumping `TRANSCRIPT_CACHE_GUARD_VERSION` would do exactly that
 * destroying, since `readCache` discards on guard mismatch. Never use it here.)
 *
 * Version, not presence. Presence was the bug: adding `contextWindow` to run
 * facts left 30 of 44 live caches permanently null, because each already had a
 * `runFacts` object and so was never re-read.
 */
export function cacheHasCurrentRunFacts(dir: string, id: SessionId): boolean {
  const header = readCachedHeader(dir, id)
  if (header === null) return false
  // `>=`, so a cache written by a NEWER build is not churned by an older one.
  return (header.runFactsVersion ?? 0) >= TRANSCRIPT_CACHE_RUN_FACTS_VERSION
}

/**
 * The run facts an existing cache already carries, or null when it has none at
 * the CURRENT version.
 *
 * This is the "do not downgrade an enriched cache" input to the close path: a
 * cache the backfill worker enriched (engine-resolved window, effort read from
 * the raw transcript) must not be flattened by a later close that re-derives
 * less. Version-gated for the same reason discovery is — facts from an older
 * derivation are not a floor worth defending.
 */
export function readCachedRunFacts(
  dir: string,
  id: SessionId,
  /**
   * The engine transcript the CURRENT facts describe. An app session is re-keyed
   * when it resumes into a new transcript, and an older cache for the same app
   * id then describes a different run — borrowing from it would relabel that
   * run's effort and window as this one's.
   */
  engineSessionId: string | null,
): TranscriptRunFacts | null {
  const header = readCachedHeader(dir, id)
  if (header === null) return null
  if (header.engineSessionId !== engineSessionId) return null
  // The same three gates `readCache` applies, because this value is about to be
  // COPIED into a freshly written header: facts from a cache the current guard
  // or protocol would reject must not outlive it by being carried forward, and
  // a file served under the wrong id speaks for a different session.
  if (
    header.appSessionId !== id ||
    header.protocolVersion !== PROTOCOL_VERSION ||
    header.guardVersion !== TRANSCRIPT_CACHE_GUARD_VERSION
  ) {
    return null
  }
  if ((header.runFactsVersion ?? 0) < TRANSCRIPT_CACHE_RUN_FACTS_VERSION) return null
  return header.runFacts ?? null
}

/**
 * When a cache was last written, from the same bounded prefix read. Returns null
 * when the file is missing, unreadable, or the stamp is not in the header window,
 * so an unknown cache is never mistaken for a fresh one.
 *
 * Backfill discovery compares this against the engine transcript's mtime: a
 * session continued outside the desktop app grows its transcript long after its
 * cache was built, and nothing else re-reads a cache that already carries run
 * facts, so without this comparison the preview and the run facts beside it stay
 * pinned to the day the cache was written.
 */
export function cacheWrittenAt(dir: string, id: SessionId): number | null {
  return readCachedHeader(dir, id)?.writtenAt ?? null
}

/**
 * Parse just the header out of a cache file, from a bounded prefix read.
 *
 * Never `readCache`: discovery and the synchronous close path both run on
 * Electron's main thread for every restorable row, and parsing plus recursively
 * secret-scanning multi-MB caches there is the exact cost this avoids. The
 * header is the FIRST object in the file, so it is inside the probe window or
 * the cache predates the field being asked about.
 *
 * The header object is extracted by brace balance and parsed as real JSON, so
 * every caller reads the same validated shape. (Three field-regexes over a
 * truncated buffer preceded this, and they could not answer a nested question
 * like "what model did those facts describe" at all.) Null on any doubt: an
 * unreadable or malformed header makes callers treat the cache as unknown,
 * which is their existing degradation, and a genuinely broken file still fails
 * the real read.
 */
export function readCachedHeader(
  dir: string,
  id: SessionId,
): TranscriptCacheHeader | null {
  const prefix = readHeaderPrefix(dir, id)
  if (prefix === null) return null
  const text = prefix.toString('utf8')
  const start = text.indexOf(HEADER_KEY)
  if (start === -1) return null
  const open = start + HEADER_KEY.length
  const end = matchingBraceEnd(text, open)
  if (end === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(open, end))
  } catch {
    return null
  }
  return parseTranscriptCacheHeader(parsed)
}

const HEADER_KEY = '"header":'

/**
 * Index just past the object opening at `open`, or null when it does not close
 * inside the probe window. String-aware, so a brace inside a title or cwd
 * cannot end the object early.
 */
function matchingBraceEnd(text: string, open: number): number | null {
  if (text[open] !== '{') return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = open; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return null
}

/**
 * A bounded PREFIX read, never `readCache`: discovery runs on Electron's main
 * thread for every restorable row, and parsing plus recursively secret-scanning
 * multi-MB caches there is the exact cost the enumeration above is written to
 * avoid. The header is the first object in the file, so a header field is inside
 * this window or the cache predates it. Null when the file cannot be read: the
 * row is then re-backfilled rather than silently left stale, and a genuinely
 * broken file fails the real read anyway.
 */
function readHeaderPrefix(dir: string, id: SessionId): Buffer | null {
  const filePath = cacheFilePath(dir, id)
  if (!filePath) return null
  let handle: number | undefined
  try {
    handle = openSync(filePath, 'r')
    const buffer = Buffer.alloc(HEADER_PROBE_BYTES)
    const read = readSync(handle, buffer, 0, HEADER_PROBE_BYTES, 0)
    return buffer.subarray(0, read)
  } catch {
    return null
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        // Best-effort close; the process is not long-lived on this path.
      }
    }
  }
}

/** Header-sized window: the header is the first object of the file. Real
 * headers run ~330 bytes, so the whole object is always inside it. */
const HEADER_PROBE_BYTES = 4096

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
  const frames = value.frames
  if (parseTranscriptCacheHeader(value.header) === null) return null
  if (!Array.isArray(frames)) return null
  for (const frame of frames) {
    // Schema-drift gate: every frame must be a valid ServerFrame that is on the
    // transcript allowlist. A non-allowlisted (or malformed) frame fails the read.
    if (!isRecord(frame) || typeof frame.kind !== 'string') return null
    if (!isTranscriptCacheFrame(frame as unknown as ServerFrame)) return null
  }
  return value as unknown as TranscriptCache
}

/**
 * Runtime-narrow an unknown parse to `TranscriptCacheHeader`, or null.
 * Shared by the full read and the bounded prefix read so a header accepted by
 * one is accepted by the other.
 */
function parseTranscriptCacheHeader(
  value: unknown,
): TranscriptCacheHeader | null {
  if (!isRecord(value)) return null
  if (
    typeof value.appSessionId !== 'string' ||
    !(typeof value.engineSessionId === 'string' || value.engineSessionId === null) ||
    typeof value.protocolVersion !== 'number' ||
    typeof value.appVersion !== 'string' ||
    typeof value.guardVersion !== 'number' ||
    typeof value.writtenAt !== 'number'
  ) {
    return null
  }
  // Optional and additive: absent is a valid pre-field cache. PRESENT but
  // malformed is a corrupt artifact, and fails the read like any other
  // schema drift rather than being silently dropped.
  if (
    value.runFacts !== undefined &&
    parseTranscriptRunFacts(value.runFacts) === null
  ) {
    return null
  }
  if (
    value.runFactsVersion !== undefined &&
    (typeof value.runFactsVersion !== 'number' ||
      !Number.isInteger(value.runFactsVersion) ||
      value.runFactsVersion < 0)
  ) {
    return null
  }
  return value as unknown as TranscriptCacheHeader
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
