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
 * Deliberately independent of the engine's message pipeline. Each fact lives on
 * a different record shape, verified against real transcripts (2026-07-28):
 *   - model             `.message.model` on an `assistant` record
 *   - permissionMode    `.permissionMode`, which rides USER records
 *   - effort            `.effort` on a `system`/`codex_send_path` record
 *   - context tokens    `.message.usage` on an `assistant` record, summed the
 *                       same way the live composer donut sums it
 * Newest wins for each, independently, because a session can change model,
 * escalate its mode, or switch effort part-way through.
 *
 * Best-effort by construction: an unreadable or malformed transcript yields all
 * nulls rather than failing the backfill, since the transcript FRAMES are the
 * artifact that matters and these are a display detail on top.
 */
export function readTranscriptRunFacts(path: string): TranscriptRunFacts {
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
      facts.usedTokens !== null
    ) {
      break
    }
  }
  return facts
}

/** The live donut's sum (`contextUsage.ts`): input + both cache buckets. */
function readUsedTokens(usage: unknown): number | null {
  if (!isRecord(usage)) return null
  const total =
    readNumber(usage.input_tokens) +
    readNumber(usage.cache_read_input_tokens) +
    readNumber(usage.cache_creation_input_tokens)
  // A turn that reported all zeros carries no information about context, and a
  // 0-token reading would render as an empty donut on a session that plainly
  // used context. Keep scanning for a turn that actually reported.
  return total > 0 ? total : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
