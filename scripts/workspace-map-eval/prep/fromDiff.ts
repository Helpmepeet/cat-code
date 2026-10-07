#!/usr/bin/env bun
// Usage: bun fromDiff.ts --path <rel> --base <commit> --transcripts <a,b> --from <ts> --until <ts> --out <file>
// Reconstructs a dirty tracked file from a `git diff` that a session printed
// between --from and --until: the base blob plus that diff. Accepted only when
// the result's blob hash matches the diff's `index <old>..<new>` line, so a
// truncated or stale diff cannot pass. Untracked files (new file mode) are
// rebuilt from /dev/null the same way. Uses the latest qualifying diff.
// With --at <ts> instead of --from/--until/--transcripts, the window is the
// span between the last logged edit of the path at/before --at and the first
// one after it (the file did not change in between), searched across every
// Cat Code, Claude Code, and Codex transcript written during that span.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { outputs } from './outputs.ts'

const args = process.argv.slice(2)
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const rel = opt('--path')!, base = opt('--base')!, out = opt('--out')!
const root = opt('--root') ?? '/Users/pt/cat-code'
let from = opt('--from') ?? '', until = opt('--until') ?? '9999'
let transcripts = (opt('--transcripts') ?? '').split(',').filter(Boolean)
const at = opt('--at')
if (at) {
  const abs = `${root}/${rel}`
  from = ''
  for (const l of readFileSync('/Users/pt/workspace-map-study/ledger/edits.jsonl', 'utf8').split('\n')) {
    if (!l.includes(abs)) continue
    const r = JSON.parse(l)
    if (!(r.paths ?? []).includes(abs)) continue
    if (r.ts <= at && r.ts > from) from = r.ts
    if (r.ts > at && r.ts < until) until = r.ts
  }
  if (!from) from = new Date(Date.parse(at) - 7 * 86400e3).toISOString()
  if (!transcripts.length) {
    const fromMs = Date.parse(from)
    const walk = (d: string): string[] => { try { return readdirSync(d).flatMap(n => { const q = join(d, n); const st = statSync(q); return st.isDirectory() ? walk(q) : n.endsWith('.jsonl') && st.mtimeMs >= fromMs ? [q] : [] }) } catch { return [] } }
    const h = homedir()
    transcripts = [...walk(join(h, '.cat-code/projects')), ...walk(join(h, '.claude/projects')), ...walk(join(h, '.codex/sessions'))]
  }
}

const header = `diff --git a/${rel} b/${rel}`
const found: { ts: string; patch: string; newHash: string }[] = []
for (const t of transcripts) {
  for (const o of outputs(t)) {
    if (o.ts < from || o.ts >= until) continue
    // Claude Read/numbered output is not a diff; take raw git diff text only.
    let idx = o.text.indexOf(header)
    while (idx >= 0) {
      const next = o.text.indexOf('\ndiff --git ', idx + header.length)
      const patch = o.text.slice(idx, next < 0 ? undefined : next + 1)
      const m = /\nindex ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(patch)
      if (m) found.push({ ts: o.ts, patch: patch.endsWith('\n') ? patch : patch + '\n', newHash: m[2]! })
      idx = o.text.indexOf(header, idx + header.length)
    }
  }
}
found.sort((a, b) => a.ts.localeCompare(b.ts))
const tried: unknown[] = []
for (const f of found.reverse()) {
  const dir = mkdtempSync(join(tmpdir(), 'fromdiff-'))
  try {
    const file = join(dir, rel)
    mkdirSync(dirname(file), { recursive: true })
    let baseText = ''
    if (!/\nnew file mode/.test(f.patch)) baseText = execFileSync('git', ['-C', root, 'show', `${base}:${rel}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
    writeFileSync(file, baseText)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: dir, input: f.patch })
    const hash = execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim()
    tried.push({ ts: f.ts, newHash: f.newHash, got: hash.slice(0, 12) })
    if (hash.startsWith(f.newHash)) {
      writeFileSync(out, readFileSync(file))
      console.log(JSON.stringify({ path: rel, ok: true, diffAt: f.ts, window: { from, until }, blob: hash, candidates: found.length }))
      process.exit(0)
    }
  } catch (e: any) {
    tried.push({ ts: f.ts, error: String(e.stderr ?? e.message ?? e).slice(0, 160) })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
console.log(JSON.stringify({ path: rel, ok: false, window: { from, until }, transcripts: transcripts.length, candidates: found.length, tried }))
process.exit(1)
