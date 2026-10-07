#!/usr/bin/env bun
// Usage: bun tokenCost.ts <src> <idPrefix> <ts> [--first-turn]: model tokens and wall time of the original session
// (main thread + subagent files). --first-turn stops at the next real user prompt after <ts>, which is what a run replays.
// Claude-like transcripts repeat one message's usage on every content-block record: counted once per message id.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const [src, id, ts] = process.argv.slice(2)
const ev = JSON.parse(execFileSync('bun', ['taskEvidence.ts', src!, id!, ts!], { encoding: 'utf8', maxBuffer: 1 << 28 }))
const path: string = ev.path
let input = 0, output = 0, cached = 0, first = '', last = '', turns = 0
const firstTurn = process.argv.includes('--first-turn')
let stop = '9999'
if (firstTurn) for (const line of readFileSync(path, 'utf8').split('\n')) {
  let r: any; try { r = JSON.parse(line) } catch { continue }
  if (!r.timestamp || r.timestamp <= ts!) continue
  const p = r.payload ?? {}
  const codexUser = r.type === 'response_item' && p.type === 'message' && p.role === 'user' && !(p.content ?? []).every((c: any) => /^\s*<|^# AGENTS\.md/.test(c?.text ?? ''))
  const c = r.message?.content
  const claudeUser = r.type === 'user' && !r.isMeta && !r.isSidechain && !r.isCompactSummary && (typeof c === 'string' ? !/^<(local-command|command-name|task-notification)/.test(c) : Array.isArray(c) && c.some((x: any) => x?.type === 'text' && !/^<(local-command|command-name|task-notification|system-reminder)/.test(x.text ?? '')) && !c.some((x: any) => x?.type === 'tool_result'))
  if (codexUser || claudeUser) { stop = r.timestamp; break }
}
const seen = new Set<string>()
const files = [path]
const sub = path.replace(/\.jsonl$/, '/subagents')
if (existsSync(sub)) for (const n of readdirSync(sub)) if (n.endsWith('.jsonl')) files.push(`${sub}/${n}`)
for (const f of files) for (const line of readFileSync(f, 'utf8').split('\n')) {
  let r: any; try { r = JSON.parse(line) } catch { continue }
  if (r.timestamp && (r.timestamp >= stop || (firstTurn && r.timestamp < ts!))) continue
  if (r.timestamp) { if (!first || r.timestamp < first) first = r.timestamp; if (r.timestamp > last) last = r.timestamp }
  if (src === 'codex') {
    if (r.type === 'event_msg' && r.payload?.type === 'token_count') {
      const t = r.payload.info?.total_token_usage
      if (t) { input = t.input_tokens ?? input; output = t.output_tokens ?? output; cached = t.cached_input_tokens ?? cached }
    }
  } else if (r.type === 'assistant' && r.message?.usage && r.message?.id && !seen.has(r.message.id)) {
    seen.add(r.message.id)
    const u = r.message.usage; turns++
    input += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); output += u.output_tokens ?? 0; cached += u.cache_read_input_tokens ?? 0
  }
}
console.log(JSON.stringify({ src, id, firstTurn, stop: stop === '9999' ? null : stop, input, output, cached, minutes: Math.round((Date.parse(last) - Date.parse(first)) / 60000), files: files.length, calls: ev.callCount }))
