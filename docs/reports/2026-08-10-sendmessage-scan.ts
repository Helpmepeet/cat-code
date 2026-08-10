/**
 * Analysis script for docs/reports/2026-08-10-sendmessage-structured-message-schema-gate.md
 *
 * Read-only. Walks every Cat Code session transcript, pairs each `tool_use`
 * block with its `tool_result` by `tool_use_id`, and reports:
 *
 *   1. SendMessage outcomes bucketed by message shape (string vs structured)
 *      and recipient form (`@name` vs bare)
 *   2. ResumeAgent success/failure tally, with each failure's message
 *   3. A manifest of every structured-message failure (timestamp, session,
 *      recipient, message type, error)
 *
 * Counts in the report were produced by this script on 2026-08-10 against
 * 1,883 transcripts. The corpus grows, so re-running will not reproduce the
 * absolute totals; the 0% structured / 100% plain-text split is the claim.
 *
 *   bun docs/reports/2026-08-10-sendmessage-scan.ts
 */
import { createReadStream, readdirSync } from 'fs'
import { basename, join } from 'path'
import * as readline from 'readline'
import { homedir } from 'os'

const ROOT = join(homedir(), '.cat-code', 'projects')

function transcripts(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) transcripts(path, out)
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

type Call = { file: string; timestamp: string; input: Record<string, unknown> }

const files = transcripts(ROOT)
const calls = new Map<string, Call & { name: string }>()
const results = new Map<string, string>()

for (const file of files) {
  const rl = readline.createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    // Cheap prefilter; the JSON parse below is the expensive part.
    if (
      !line.includes('SendMessage') &&
      !line.includes('ResumeAgent') &&
      !line.includes('tool_result')
    )
      continue
    let entry: any
    try {
      entry = JSON.parse(line)
    } catch {
      continue // torn/partial line — counted as skipped, never silently merged
    }
    const content = entry?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block?.type === 'tool_use' &&
        (block.name === 'SendMessage' || block.name === 'ResumeAgent')
      ) {
        calls.set(block.id, {
          file,
          timestamp: entry.timestamp,
          input: block.input ?? {},
          name: block.name,
        })
      } else if (block?.type === 'tool_result') {
        results.set(
          block.tool_use_id,
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content),
        )
      }
    }
  }
}

const isError = (result: string) => result.includes('tool_use_error')

// 1. SendMessage outcome table
const buckets = new Map<string, { ok: number; err: number; errs: Set<string> }>()
for (const [id, call] of calls) {
  if (call.name !== 'SendMessage') continue
  const result = results.get(id) ?? '(no result)'
  const structured = typeof call.input.message === 'object'
  const at = typeof call.input.to === 'string' && call.input.to.startsWith('@')
  const key = `${structured ? 'structured' : 'plain text'} / ${at ? '@name' : 'bare'}`
  const bucket = buckets.get(key) ?? { ok: 0, err: 0, errs: new Set<string>() }
  if (isError(result)) {
    bucket.err++
    bucket.errs.add(result.replace(/<\/?tool_use_error>/g, '').trim())
  } else bucket.ok++
  buckets.set(key, bucket)
}

console.log(`transcripts scanned: ${files.length}\n`)
console.log('SendMessage outcomes')
for (const [key, b] of [...buckets].sort()) {
  console.log(`  ${key.padEnd(22)} ok=${String(b.ok).padStart(3)} err=${String(b.err).padStart(3)}`)
  for (const e of b.errs) console.log(`      ! ${e}`)
}

// 2. ResumeAgent tally
let resumeOk = 0
const resumeFailures: string[] = []
for (const [id, call] of calls) {
  if (call.name !== 'ResumeAgent') continue
  const result = results.get(id) ?? '(no result)'
  if (isError(result) || result.includes('"success":false')) {
    resumeFailures.push(
      `  ${call.timestamp}  ${basename(call.file)}\n      agentId=${String(call.input.agentId)}\n      ${result.slice(0, 220)}`,
    )
  } else resumeOk++
}
console.log(
  `\nResumeAgent: ok=${resumeOk} err=${resumeFailures.length}`,
)
for (const f of resumeFailures) console.log(f)

// 3. Structured-message failure manifest
const manifest: {
  timestamp: string
  session: string
  project: string
  to: unknown
  kind: unknown
  error: string
}[] = []
for (const [id, call] of calls) {
  if (call.name !== 'SendMessage') continue
  const result = results.get(id) ?? '(no result)'
  if (!isError(result)) continue
  const message = call.input.message
  if (typeof message !== 'object' || message === null) continue
  manifest.push({
    timestamp: call.timestamp,
    session: basename(call.file).replace('.jsonl', '').slice(0, 8),
    project: call.file.replace(`${ROOT}/`, '').split('/')[0]!,
    to: call.input.to,
    kind: (message as { type?: unknown }).type,
    error: result.replace(/<\/?tool_use_error>/g, '').trim(),
  })
}
manifest.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
console.log(`\nStructured-message failures: ${manifest.length}`)
for (const row of manifest) {
  console.log(
    `  ${row.timestamp}  ${row.project.padEnd(22)} ${row.session}  to=${String(row.to).padEnd(18)} ${String(row.kind).padEnd(17)} -> ${row.error}`,
  )
}
console.log(
  `\ndistinct sessions: ${new Set(manifest.map(r => r.session)).size}` +
    ` · distinct message types: ${[...new Set(manifest.map(r => r.kind))].join(', ')}`,
)
