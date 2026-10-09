#!/usr/bin/env bun
// Usage: bun scrubTranscript.ts <in> <out> [--report out.json]
// No-map version of a session input (JSONL transcript or a text file such as a
// saved tool result). In a no-map world the earlier session would not have read
// or edited maps, so:
//  - tool calls whose input targets map material (docs/maps, WORKSPACE_MAP, map
//    tooling) are removed together with their results (Claude-like content
//    blocks and toolUseResult; Codex function_call / *_output items);
//  - every other string goes through the document scrub (scrubCore.ts).
// Records are kept, so uuid/parentUuid chains stay intact; a record emptied by
// removal keeps an empty text block. Exit 1 when map text remains.
import { readFileSync, writeFileSync } from 'node:fs'
import { ANY, TOKEN, scrubText } from './scrubCore.ts'

const [src, out] = process.argv.slice(2) as [string, string]
const reportOut = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : undefined
const text = readFileSync(src, 'utf8')
const isJsonl = /\.jsonl$/.test(src)
const targetsMaps = (v: unknown) => new RegExp(TOKEN.source).test(JSON.stringify(v ?? ''))
let removedCalls = 0, editedStrings = 0

function scrubString(s: string): string {
  if (!ANY.test(s)) return s
  const t = scrubText('transcript.md', s)
  if (t !== s) editedStrings++
  return t
}
function deep(v: any): any {
  if (typeof v === 'string') return scrubString(v)
  if (Array.isArray(v)) return v.map(deep)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
  return v
}

let result: string
if (!isJsonl) result = scrubText(src.endsWith('.md') ? 'input.md' : 'input.txt', text)
else {
  const records = text.split('\n').map(l => { try { return l ? JSON.parse(l) : null } catch { return l } })
  const ids = new Set<string>()
  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    for (const c of Array.isArray(r.message?.content) ? r.message.content : []) if (c?.type === 'tool_use' && targetsMaps(c.input)) ids.add(c.id)
    const p = r.payload
    if (r.type === 'response_item' && (p?.type === 'function_call' || p?.type === 'custom_tool_call') && targetsMaps(p.arguments ?? p.input)) ids.add(p.call_id)
  }
  const outLines = records.map(r => {
    if (!r || typeof r !== 'object') return r ?? ''
    if (Array.isArray(r.message?.content)) {
      const before = r.message.content.length
      r.message.content = r.message.content.filter((c: any) => !(c?.type === 'tool_use' && ids.has(c.id)) && !(c?.type === 'tool_result' && ids.has(c.tool_use_id)))
      if (r.message.content.length < before) {
        removedCalls += before - r.message.content.length
        if (!r.message.content.length) r.message.content = [{ type: 'text', text: '' }]
        if ('toolUseResult' in r && !r.message.content.some((c: any) => c?.type === 'tool_result')) delete r.toolUseResult
      }
    }
    const p = r.payload
    if (r.type === 'response_item' && ids.has(p?.call_id)) { removedCalls++; return null }
    return JSON.stringify(deep(r))
  }).filter((l): l is string => l !== null)
  result = outLines.join('\n')
}
const left = result.split('\n').filter(l => ANY.test(l))
writeFileSync(out, result)
if (reportOut) writeFileSync(reportOut, JSON.stringify({ src, removedCalls, editedStrings, residual: left.map(l => l.slice(0, 300)) }, null, 1))
console.log(JSON.stringify({ removedCalls, editedStrings, residual: left.length }))
process.exit(left.length ? 1 : 0)
