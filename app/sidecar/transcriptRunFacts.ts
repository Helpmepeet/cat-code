/**
 * Run facts read straight from a session's transcript JSONL.
 *
 * Its own module, not part of the worker, for two reasons: the worker invokes
 * `main()` at import time (so importing it from a test would start a real
 * backfill run), and this function touches nothing but the filesystem, so it
 * is worth testing without the engine graph the worker pulls in.
 */

import { readFileSync } from 'node:fs'

import type { TranscriptRunFacts } from '../shared/protocol.js'

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
 * Best-effort by construction: an unreadable or malformed transcript yields all
 * nulls rather than failing the backfill, since the transcript FRAMES are the
 * artifact that matters and these are a display detail on top.
 */
export function readTranscriptRunFacts(
  path: string,
  resolveContextWindow: (model: string) => number | null,
): TranscriptRunFacts {
  const empty: TranscriptRunFacts = {
    model: null,
    permissionMode: null,
    effort: null,
    usedTokens: null,
    contextWindow: null,
  }
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    return empty
  }

  const facts = { ...empty }
  let snapshot: RunFactsSnapshot | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
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
      facts.model ??= readString(record.message.model)
      if (facts.usedTokens === null) {
        facts.usedTokens = readUsedTokens(record.message.usage)
      }
    }
    if (
      facts.model !== null &&
      facts.permissionMode !== null &&
      facts.effort !== null &&
      facts.usedTokens !== null &&
      snapshot !== null
    ) {
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
  return facts
}

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
