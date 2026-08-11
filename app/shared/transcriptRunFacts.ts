/**
 * Run facts read straight from a session's transcript JSONL.
 *
 * In `shared/` because it has TWO callers in different trust domains and must
 * stay ONE implementation: the PL-B backfill worker (which injects the engine's
 * real window resolver) and main's close/park/crash persist path (which injects
 * none — see below). A second copy would be free to drift into writing a header
 * the other half cannot honour, which is exactly the failure this closes.
 *
 * It is not part of the worker module for two further reasons: the worker
 * invokes `main()` at import time (so importing it from a test would start a
 * real backfill run), and this function touches nothing but the filesystem, so
 * it is worth testing without the engine graph the worker pulls in.
 *
 * `node:fs` in `shared/` follows `transcriptBackfill.ts` (`node:path`): these
 * are the main/sidecar-side shared modules. The renderer imports neither.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'

import type { TranscriptRunFacts } from './protocol.js'
import { MAX_HISTORY_REPLAY_BYTES } from './limits.js'

// Match the display-history reader's bounded tail window. Run facts are a
// best-effort preview enhancement, never a reason to materialize an arbitrary
// transcript on Electron's main thread during close/park.
export const MAX_RUN_FACTS_READ_BYTES = MAX_HISTORY_REPLAY_BYTES * 2

/**
 * Derive a session's run facts by scanning its transcript JSONL directly.
 *
 * Two tiers, in order. AUTHORITATIVE: a `system`/`run_facts` record, which the
 * engine writes per main-thread turn (deduplicated on change) carrying model,
 * permission mode, effort and the context window it actually ran with. The
 * newest one wins as a UNIT, because its value is that the four coexisted in one
 * request. LEGACY: every transcript written before that record existed, which is
 * every session already on disk, so the byproduct scan below is not dead code
 * and cannot be deleted.
 *
 * The legacy tier is deliberately independent of the engine's message pipeline.
 * Each fact lives on a different record shape, verified against real transcripts
 * (2026-07-28):
 *   - model             `.message.model` on an `assistant` record
 *   - permissionMode    `.permissionMode`, which rides USER records
 *   - effort            `.effort` on a `system`/`codex_send_path` record
 *   - context tokens    `.message.usage` on an `assistant` record, summed the
 *                       same way the live composer donut sums it
 * Newest wins for each, independently, because a session can change model,
 * escalate its mode, or switch effort part-way through.
 *
 * The context WINDOW is the one fact no record carries. The live donut reads it
 * off `modelUsage[model].contextWindow` on a `result` frame (`contextUsage.ts`),
 * and a `result` is a runtime frame that is never persisted: across all 167
 * transcripts on this machine (~40k records, 2026-07-28) there are zero `result`
 * records and zero structural `modelUsage`/`contextWindow` keys. So the window
 * is RESOLVED FROM the newest model instead of read, via `resolveContextWindow`
 * — which the worker binds to the engine's own `getContextWindowForModel`, the
 * very function whose output the live path consumes (`src/cost-tracker.ts:107`).
 *
 * Same function; its two inputs are believed equivalent today but are not the
 * same objects, so do not read this as a guarantee. (1) The model string here is
 * the transcript's echoed `.message.model`, where the live donut keys off the
 * run-controls main-loop model. (2) Betas: the worker's `getSdkBetas()` is
 * structurally undefined, since nothing in `app/` ever sets it. Both differences
 * are unreachable while `app/` exposes no `[1m]` model, and both fail toward the
 * old default rather than a wrong larger window — but enabling 1M on the desktop
 * means revisiting this.
 *
 * The resolver is REQUIRED, not optional: a caller that could silently omit it
 * would reproduce the exact defect this closes, a field declared and never
 * populated with nothing failing. Pass `() => null` to deliberately claim no
 * window and leave the renderer its fallback.
 *
 * Main's close path passes exactly that, because main is engine-free and has no
 * resolver to give. It is not a degradation there: the `run_facts` record
 * carries the window the run ACTUALLY used, and a session with no such record
 * fails main's completeness gate and is left to the frame fallback rather than
 * written with a guessed window (`transcriptCache.ts` `resolveCacheRunFacts`).
 *
 * Best-effort by construction: an unreadable or malformed transcript yields all
 * nulls rather than failing the backfill, since the transcript FRAMES are the
 * artifact that matters and these are a display detail on top.
 */
export function readTranscriptRunFacts(
  path: string,
  resolveContextWindow: (model: string) => number | null,
): TranscriptRunFactsRead {
  const empty: TranscriptRunFacts = {
    model: null,
    permissionMode: null,
    effort: null,
    usedTokens: null,
    contextWindow: null,
  }
  // Two independent bounds, both load-bearing. This runs synchronously on
  // Electron's main thread at every close, park, crash and quit, and a
  // transcript is append-only with a size driven by model and tool output,
  // which the threat model treats as attacker-influenceable
  // (SECURITY-MINIMUM), so an unbounded read is an availability hole on the
  // process that owns the window.
  //   OUTER — over MAX_RUN_FACTS_TRANSCRIPT_BYTES we decline outright: no
  //   facts, no header, and the renderer's frame fallback answers as it always
  //   did. A file that large is pathological, not a long session.
  //   INNER — below it we still read only a newline-aligned tail, so the
  //   allocation stays at MAX_RUN_FACTS_READ_BYTES rather than the whole file.
  try {
    if (statSync(path).size > MAX_RUN_FACTS_TRANSCRIPT_BYTES) {
      return { facts: empty, authoritative: false }
    }
  } catch {
    return { facts: empty, authoritative: false }
  }
  const lines = readBoundedTranscriptLines(path)
  if (lines === null) return { facts: empty, authoritative: false }

  const facts = { ...empty }
  let snapshot: RunFactsSnapshot | null = null
  // COMPACTION — usage is stale on BOTH sides of a boundary, and the newest
  // assistant record is on the wrong side of it more often than not.
  //
  // `contextUsage.ts` documents the two halves and this must reproduce them, or
  // a close writes a pre-compaction token count into a header the renderer
  // trusts wholesale — a number its own frame fallback would have refused:
  //   BELOW the boundary, records measure a context that no longer exists.
  //   ABOVE it, the engine splices the PRESERVED originals back in carrying
  //   their ORIGINAL usage, so a plain "newest wins" scan lands on one of them.
  // Resolved in one pass here: `compaction` gives the floor and the preserved
  // index range, and the usage scan below skips both.
  const compaction = findCompactionRange(lines)
  for (let i = lines.length - 1; i >= compaction.floor; i--) {
    const line = lines[i]
    if (!line) continue
    // Parse only what can still contribute.
    //
    // A `run_facts` snapshot is authoritative for model/mode/effort. Once it
    // and the only independent measurement (used tokens) are known, no older
    // record can improve the result. Legacy transcripts still scan the bounded
    // tail for their independent newest facts.
    const needsByproducts =
      facts.model === null ||
      facts.permissionMode === null ||
      facts.effort === null ||
      facts.usedTokens === null
    if (!needsByproducts && !line.includes(RUN_FACTS_MARKER)) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(record)) continue

    if (
      snapshot === null &&
      record.type === 'system' &&
      record.subtype === 'run_facts'
    ) {
      snapshot = {
        model: readString(record.model),
        permissionMode: readString(record.permissionMode),
        effort: readString(record.effort),
        contextWindow: readPositiveNumber(record.contextWindow),
      }
      continue
    }

    facts.permissionMode ??= readString(record.permissionMode)
    if (record.type === 'system' && record.subtype === 'codex_send_path') {
      facts.effort ??= readString(record.effort)
    }
    if (record.type === 'assistant' && isRecord(record.message)) {
      // The MODEL is safe to read from a preserved record — it is the model
      // that turn ran on either way. Only the token count is invalidated by
      // compaction, so only that read is range-gated.
      facts.model ??= readString(record.message.model)
      if (facts.usedTokens === null && !inPreservedRange(compaction, i)) {
        facts.usedTokens = readUsedTokens(record.message.usage)
      }
    }
    if (snapshot !== null && facts.usedTokens !== null) {
      break
    }
  }

  if (snapshot !== null) {
    // Wholesale, not field-by-field: the point of the snapshot is that its four
    // values coexisted in one request. Merging a newer byproduct record over it
    // would rebuild the incoherence it exists to remove. Cost: a mode change
    // made after the last main-thread turn is missed until the next turn writes
    // a fresh snapshot, which is a bounded staleness, not a wrong pairing.
    facts.model = snapshot.model
    facts.permissionMode = snapshot.permissionMode
    facts.effort = snapshot.effort
  }
  // Deliberately NOT part of the early-exit above: the window is derived from
  // `facts.model`, which the exit condition already requires, so an exit can
  // never skip it. Resolving here rather than per-record also means one lookup
  // per transcript instead of one per assistant record.
  //
  // The snapshot's own window is preferred because the engine captured it AT RUN
  // TIME. Resolving instead reads today's environment (1M betas, capability
  // data, overrides), which for a historic run reports a window that was never
  // in force. The resolver stays as the tier for transcripts written before the
  // engine recorded run facts, which is every session already on disk.
  facts.contextWindow =
    snapshot?.contextWindow ??
    (facts.model !== null
      ? readContextWindow(facts.model, resolveContextWindow)
      : null)
  return { facts, authoritative: snapshot !== null }
}

/**
 * The run facts a transcript yields, plus WHERE they came from.
 *
 * `authoritative` means a `system`/`run_facts` snapshot was found: the engine
 * recorded model, permission mode, effort and window as ONE resolved request.
 * Callers must not patch such a result from another source — including an
 * `effort: null`, which on this tier means the run used the provider default
 * and NOT "nothing said". Merging a cached `high` over it reports an effort the
 * run never used.
 */
export type TranscriptRunFactsRead = {
  facts: TranscriptRunFacts
  authoritative: boolean
}

/**
 * Read cap for the synchronous scan. Generous against real transcripts (the
 * largest on the author's machine is 13 MB) and small enough that the string
 * plus line array cannot stall or exhaust the Electron main process.
 */
export const MAX_RUN_FACTS_TRANSCRIPT_BYTES = 64 * 1024 * 1024

/** The newest compaction's stale-record ranges, or the whole-file default. */
type CompactionRange = {
  /** Lowest index whose usage still describes the live context. */
  floor: number
  /** The spliced-back originals above the boundary, or null when absent. */
  preserved: { start: number; end: number } | null
}

const NO_COMPACTION: CompactionRange = { floor: 0, preserved: null }

function inPreservedRange(range: CompactionRange, index: number): boolean {
  return (
    range.preserved !== null &&
    index >= range.preserved.start &&
    index <= range.preserved.end
  )
}

/**
 * Read only a newline-aligned tail of the JSONL file. Transcript records append
 * over time and this reader walks newest-first, so a bounded tail retains the
 * relevant records while preventing a large historical transcript from adding a
 * full-file allocation to the main-process lifecycle path.
 */
function readBoundedTranscriptLines(path: string): string[] | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - MAX_RUN_FACTS_READ_BYTES)
    const bytes = Buffer.allocUnsafe(size - start)
    const bytesRead = readSync(fd, bytes, 0, bytes.length, start)
    let text = bytes.toString('utf8', 0, bytesRead)
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return text.split('\n')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Locate the newest `compact_boundary` and the preserved segment it records.
 *
 * Mirrors `contextUsage.ts` (`newestCompactBoundary` + `preservedTailRange`)
 * against raw JSONL rather than projected messages. Substring-gated so an
 * uncompacted transcript — the common case — pays one `includes` per line and
 * no parse at all.
 */
function findCompactionRange(lines: readonly string[]): CompactionRange {
  let boundary = -1
  let head: string | null = null
  let tail: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes(COMPACT_BOUNDARY_MARKER)) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(record)) continue
    if (record.type !== 'system' || record.subtype !== 'compact_boundary') {
      continue
    }
    boundary = i
    const metadata = isRecord(record.compact_metadata)
      ? record.compact_metadata
      : null
    const segment =
      metadata && isRecord(metadata.preserved_segment)
        ? metadata.preserved_segment
        : null
    head = segment ? readString(segment.head_uuid) : null
    tail = segment ? readString(segment.tail_uuid) : null
    break
  }
  if (boundary === -1) return NO_COMPACTION
  const floor = boundary + 1
  if (head === null || tail === null) return { floor, preserved: null }

  let start = -1
  let end = -1
  for (let i = floor; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    // A uuid is a bare string in the record, so a substring test finds the
    // candidate lines without parsing every one of them.
    if (start === -1 && !line.includes(head)) continue
    if (start !== -1 && !line.includes(tail)) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(record)) continue
    const uuid = readString(record.uuid)
    if (start === -1 && uuid === head) start = i
    if (start !== -1 && uuid === tail) {
      end = i
      break
    }
  }
  return start === -1 || end === -1
    ? { floor, preserved: null }
    : { floor, preserved: { start, end } }
}

/** Matches the boundary record `contextUsage.ts` reads on the projected side. */
const COMPACT_BOUNDARY_MARKER = 'compact_boundary'

/**
 * The cheap pre-test for the authoritative record. Deliberately the SUBTYPE
 * value alone, with no JSON punctuation: `recordRunFacts` writes the object
 * through `JSON.stringify` (`src/utils/sessionStorage.ts`), but a marker that
 * assumed `"subtype":"run_facts"` byte-for-byte would silently stop matching if
 * that writer ever spaced its output differently, and the failure mode is a
 * fact quietly going missing. A false positive only costs one `JSON.parse`.
 */
const RUN_FACTS_MARKER = 'run_facts'

/** One request's coherent facts, as the engine recorded them (`run_facts`). */
type RunFactsSnapshot = {
  model: string | null
  permissionMode: string | null
  effort: string | null
  contextWindow: number | null
}

/**
 * A resolver that throws or answers nonsense costs the donut its exact
 * denominator (the renderer falls back to 200k), never the whole backfill.
 *
 * Defence in depth only: the worker logs the throw at its injection site, where
 * stderr exists. A failure here is never one session's bad data, it is the
 * engine lookup being broken for the whole batch, so it must not be silent.
 */
function readContextWindow(
  model: string,
  resolve: (model: string) => number | null,
): number | null {
  let window: number | null
  try {
    window = resolve(model)
  } catch {
    return null
  }
  return typeof window === 'number' && Number.isFinite(window) && window > 0
    ? window
    : null
}

/** The live donut's sum (`contextUsage.ts`): input + both cache buckets. */
/**
 * The engine's context-size numerator, `getTokenCountFromUsage`
 * (`src/utils/tokens.ts:52-59`): all three input buckets PLUS `output_tokens`.
 * The renderer's live gauge uses the same four fields (`contextUsage.ts`) so a
 * previewed session and a live one cannot disagree. Dropping `output_tokens`
 * here undercounts by one response, since the next request carries it.
 *
 * Reading an ASSISTANT frame is correct on this path and only this path: the
 * transcript on disk was written after the engine's late usage write-back, so
 * these numbers are final. The live wire's assistant frames are not (S1 §4).
 */
function readUsedTokens(usage: unknown): number | null {
  if (!isRecord(usage)) return null
  const total =
    readNumber(usage.input_tokens) +
    readNumber(usage.cache_read_input_tokens) +
    readNumber(usage.cache_creation_input_tokens) +
    readNumber(usage.output_tokens)
  // A turn that reported all zeros carries no information about context, and a
  // 0-token reading would render as an empty donut on a session that plainly
  // used context. Keep scanning for a turn that actually reported.
  return total > 0 ? total : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
