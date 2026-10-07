#!/usr/bin/env bun
// Usage: bun detect.ts <runHome> --setup mandatory|nomap --stage <staged dir> [--seed <home-seed dir>] [--json out]
// Post-run access detector (plan step 4). Scans every transcript the run wrote
// (main, delegated workers, persisted tool results) for tool calls or tool
// results that touch forbidden locations. Exits 1 on any hit; hits are evidence.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
const home = args[0]!
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const setup = opt('--setup')!
const stage = opt('--stage')!
const ALWAYS: [string, RegExp][] = [
  ['live checkout', /\/Users\/pt\/cat-code(?![\w-])/],
  ['repo worktrees', /\.worktrees\//],
  ['codex worktrees', /(\/Users\/pt|~|\$HOME)\/\.codex\/worktrees/],
  ['live user state', /\/Users\/pt\/\.(cat-code|claude|codex|agents)\b/],
  ['study folder', /\/Users\/pt\/workspace-map-study|workspace-map-study/],
  ['engine checkout', /\/Users\/Shared\/cce\b/],
  ['other staged copy', new RegExp(`/Users/Shared/ccw/(?!${stage.split('/').pop()})[0-9a-z]`)],
]
const NOMAP: [string, RegExp][] = [['map files', /docs\/maps|WORKSPACE_MAP/]]
const seed = opt('--seed')
// Location patterns are access attempts, so they apply to tool inputs; the
// content an input transcript returns may name those places legitimately (the
// sandbox denies the reads themselves). Map text counts anywhere in tool traffic.
const forInputs = setup === 'nomap' ? [...ALWAYS, ...NOMAP] : ALWAYS
const forResults = setup === 'nomap' ? NOMAP : []

function files(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) files(p, acc)
    else if (/\.(jsonl|txt|json)$/.test(n)) acc.push(p)
  }
  return acc
}

// Only tool traffic counts as access: tool_use inputs and tool_result contents,
// plus persisted tool-result files. System context and model prose are not access.
const hits: { file: string; kind: string; pattern: string; excerpt: string }[] = []
function scan(file: string, kind: string, s: string) {
  for (const [name, re] of kind.startsWith('tool_use') ? forInputs : forResults) {
    const m = s.match(re)
    if (m) hits.push({ file, kind, pattern: name, excerpt: s.slice(Math.max(0, m.index! - 80), m.index! + 80).replace(/\s+/g, ' ') })
  }
}
const seeded = (f: string) => !!seed && existsSync(join(seed, relative(home, f)))
for (const f of files(join(home, '.cat-code', 'projects'))) {
  if (seeded(f)) continue
  if (f.includes('/tool-results/')) { scan(f, 'tool-result-file', readFileSync(f, 'utf8')); continue }
  if (!f.endsWith('.jsonl')) continue
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    for (const part of Array.isArray(r.message?.content) ? r.message.content : []) {
      if (part?.type === 'tool_use') scan(f, `tool_use:${part.name}`, JSON.stringify(part.input))
      if (part?.type === 'tool_result') scan(f, 'tool_result', JSON.stringify(part.content))
    }
  }
}
const out = opt('--json')
if (out) writeFileSync(out, JSON.stringify(hits, null, 1))
console.log(JSON.stringify({ setup, transcriptsScanned: files(join(home, '.cat-code', 'projects')).length, hits: hits.length, sample: hits.slice(0, 5) }, null, 1))
process.exit(hits.length ? 1 : 0)
