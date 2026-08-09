#!/usr/bin/env bun
/**
 * Freeze a replay corpus for the auto-mode port.
 *
 * The replay gate was not falsifiable while the corpus was a rolling `--days`
 * window: the same 21-day query returned 162 decision denials early on
 * 2026-08-09 and 163 later the same day. A gate whose input moves cannot fail.
 * So the corpus is written once to a file, hashed, and referenced by hash.
 *
 * Two case kinds, and the second is the one that matters:
 *
 *   block  - the classifier judged the action and refused it. Replaying these
 *            answers "did we fix the over-blocking".
 *   allow  - a tool call that ran to completion in a session that started in
 *            auto mode. Replaying these answers "did we break something that
 *            used to work", which a denial-only corpus structurally cannot.
 *
 * Honest limit on `allow`: `permissionMode` is recorded once at session start,
 * not per tool call (verified against the transcripts), and the operator can
 * change mode mid-session. So an allow case means "this work completed and was
 * not objected to", not "the classifier saw this exact call and passed it".
 * That is still the right regression signal: if the ported prompt blocks it, we
 * want to know regardless of who allowed it the first time.
 *
 * Usage:
 *   bun run scripts/auto-mode-corpus.ts --out fixtures/auto-mode-corpus.json
 *                                       [--max-allow N] [--root <dir>]
 */

import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const value = args[i + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

const ROOT = flag('--root') ?? join(homedir(), '.cat-code', 'projects')
const OUT = flag('--out') ?? 'fixtures/auto-mode-corpus.json'
/** Allows are plentiful; blocks are the scarce signal and are never sampled. */
const MAX_ALLOW = Number(flag('--max-allow') ?? 400)
if (!Number.isSafeInteger(MAX_ALLOW) || MAX_ALLOW < 1) {
  throw new Error('--max-allow must be a positive safe integer')
}

const DECISION = 'Permission for this action has been denied. Reason:'
const OUTAGE = 'temporarily unavailable, so auto mode cannot determine'

type Case = {
  id: string
  kind: 'block' | 'allow'
  tool: string
  action: string
  /** Denial reason, block cases only. */
  reason?: string
  transcript: string
}

function* walk(dir: string): Generator<string> {
  const entries = readdirSync(dir)
  for (const entry of entries) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (entry.endsWith('.jsonl')) yield p
  }
}

/** Same per-tool projection the classifier receives, so replay inputs match. */
function actionText(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string | undefined =>
    typeof i[k] === 'string' ? (i[k] as string) : undefined
  switch (tool) {
    case 'Bash':
      return str('command') ?? ''
    case 'Read':
    case 'Write':
    case 'Edit':
      return str('file_path') ?? ''
    case 'Glob':
      return str('pattern') ?? ''
    case 'Grep':
      return `${str('pattern') ?? ''} in ${str('path') ?? '.'}`
    case 'Skill':
      return str('skill') ?? ''
    default:
      return JSON.stringify(input ?? {}).slice(0, 300)
  }
}

function collect(path: string): Case[] {
  const text = readFileSync(path, 'utf-8')
  const transcript = path.split('/').pop()!
  const calls = new Map<string, { name: string; input: unknown }>()
  const denied = new Map<string, string>()
  const completed = new Set<string>()
  let sawAutoMode = false

  for (const line of text.split('\n')) {
    if (!line) continue
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue // torn line: never abort a whole transcript on one bad record
    }
    if (o?.permissionMode === 'auto') sawAutoMode = true
    const content = o?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        calls.set(b.id, { name: b.name, input: b.input })
        continue
      }
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
      const s =
        typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
      if (s.includes(DECISION)) {
        denied.set(
          b.tool_use_id,
          (s.split('Reason:')[1] ?? '').split('. To allow')[0]!.trim(),
        )
      } else if (s.includes(OUTAGE)) {
        // Infrastructure denials carry no verdict, so there is nothing to
        // replay against. Excluded by design, not overlooked.
        denied.set(b.tool_use_id, '')
      } else if (b.is_error !== true) {
        completed.add(b.tool_use_id)
      }
    }
  }

  const cases: Case[] = []
  for (const [id, reason] of denied) {
    if (reason === '') continue
    const call = calls.get(id)
    if (!call) continue
    cases.push({
      id,
      kind: 'block',
      tool: call.name,
      action: actionText(call.name, call.input),
      reason,
      transcript,
    })
  }
  if (sawAutoMode) {
    for (const id of completed) {
      const call = calls.get(id)
      if (!call) continue
      cases.push({
        id,
        kind: 'allow',
        tool: call.name,
        action: actionText(call.name, call.input),
        transcript,
      })
    }
  }
  return cases
}

const all: Case[] = []
for (const file of walk(ROOT)) all.push(...collect(file))

// Deterministic order, so the same inputs always hash the same.
all.sort((a, b) => (a.transcript + a.id).localeCompare(b.transcript + b.id))

const blocks = all.filter(c => c.kind === 'block')
const allowsAll = all.filter(c => c.kind === 'allow')

// Stratify the allow sample by tool so a single chatty tool cannot crowd out
// coverage of the rest. Never silently truncate: the drop is reported.
const byTool = new Map<string, Case[]>()
for (const c of allowsAll) {
  const list = byTool.get(c.tool) ?? []
  list.push(c)
  byTool.set(c.tool, list)
}
const perTool = Math.max(1, Math.floor(MAX_ALLOW / Math.max(1, byTool.size)))
const allows: Case[] = []
for (const list of byTool.values()) allows.push(...list.slice(0, perTool))
const droppedAllows = allowsAll.length - allows.length

const cases = [...blocks, ...allows].sort((a, b) =>
  (a.transcript + a.id).localeCompare(b.transcript + b.id),
)

const body = {
  schema: 1,
  purpose:
    'Frozen replay corpus for the auto-mode upstream port. Blocks answer "did we fix over-blocking"; allows answer "did we break working behaviour".',
  allowCaseCaveat:
    'permissionMode is recorded at session start, not per tool call, and can change mid-session. An allow case means the work completed and was not objected to, not that the classifier passed this exact call.',
  counts: {
    blocks: blocks.length,
    allows: allows.length,
    allowsAvailable: allowsAll.length,
    allowsDropped: droppedAllows,
    toolsCovered: byTool.size,
  },
  cases,
}
// Hash the exact bytes written, so `shasum -a 256 <file>` verifies the record.
// Hashing the JSON while writing JSON+newline makes the recorded hash
// unverifiable, which defeats the point of freezing it.
const fileText = `${JSON.stringify(body, null, 2)}\n`
const sha256 = createHash('sha256').update(fileText).digest('hex')

mkdirSync(dirname(OUT), { recursive: true })
const shaPath = `${OUT.replace(/\.json$/, '')}.sha256`
const corpusTempPath = `${OUT}.tmp-${process.pid}`
const shaTempPath = `${shaPath}.tmp-${process.pid}`
writeFileSync(corpusTempPath, fileText)
writeFileSync(shaTempPath, `${sha256}  ${OUT.split('/').pop()}\n`)
renameSync(corpusTempPath, OUT)
renameSync(shaTempPath, shaPath)

console.log(`wrote ${OUT}`)
console.log(`  blocks ${blocks.length}`)
console.log(
  `  allows ${allows.length} of ${allowsAll.length} available ` +
    `(${droppedAllows} dropped by the per-tool cap, ${byTool.size} tools covered)`,
)
console.log(`  sha256 ${sha256}`)
