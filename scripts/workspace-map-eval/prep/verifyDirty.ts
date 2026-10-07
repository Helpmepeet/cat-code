#!/usr/bin/env bun
// Usage: bun verifyDirty.ts --path <rel> --candidate <file> --base <commit> --at <promptTs>
//          --transcripts <a.jsonl,b.jsonl> [--until <ts>] [--root /Users/pt/cat-code]
// Checks a reconstructed task-time file against what sessions actually saw.
// Evidence is taken only from tool outputs produced at/after --at minus 2h and
// before the first logged edit of the path after --at (or --until), so later
// edits cannot be mistaken for task-time content.
//  - diff: `diff --git a/<rel>` hunks in outputs, applied to the base blob.
//  - numbered: runs of `N<TAB>text` / `N→text` lines (nl -ba, Read) of >= 3
//    lines; a run that matches the candidate supports it, a run that matches
//    the base or another offset of the candidate contradicts it.
//  - added: distinctive lines the candidate adds over the base, and whether
//    any output contains them.
// Exit 1 when any contradiction is found.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { outputs } from './outputs.ts'

const args = process.argv.slice(2)
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const rel = opt('--path')!, cand = readFileSync(opt('--candidate')!, 'utf8'), base = opt('--base')!
const at = opt('--at')!, root = opt('--root') ?? '/Users/pt/cat-code'
const transcripts = (opt('--transcripts') ?? '').split(',').filter(Boolean)
const abs = `${root}/${rel}`
let baseText = ''
try { baseText = execFileSync('git', ['-C', root, 'show', `${base}:${rel}`], { encoding: 'utf8', maxBuffer: 64 << 20 }) } catch {}

const ledger = readFileSync('/Users/pt/workspace-map-study/ledger/edits.jsonl', 'utf8').split('\n')
let until = opt('--until') ?? '9999'
let lastBefore = ''
for (const l of ledger) {
  if (!l.includes(abs)) continue
  const r = JSON.parse(l)
  if (!(r.paths ?? []).includes(abs)) continue
  if (r.ts > at && r.ts < until) until = r.ts
  if (r.ts <= at && r.ts > lastBefore) lastBefore = r.ts
}
// Outputs older than the last edit before the prompt show an earlier state.
const twoHours = new Date(Date.parse(at) - 2 * 3600e3).toISOString()
const from = lastBefore > twoHours ? lastBefore : twoHours

if (!transcripts.length) {
  // Every transcript written during the window: any session may have seen the file.
  const fromMs = Date.parse(from)
  const walk = (d: string): string[] => { try { return readdirSync(d).flatMap(n => { const q = join(d, n); const st = statSync(q); return st.isDirectory() ? walk(q) : n.endsWith('.jsonl') && st.mtimeMs >= fromMs ? [q] : [] }) } catch { return [] } }
  const h = homedir()
  transcripts.push(...walk(join(h, '.cat-code/projects')), ...walk(join(h, '.claude/projects')), ...walk(join(h, '.codex/sessions')))
}
const all = transcripts.flatMap(t => outputs(t)).filter(o => o.ts >= from && o.ts < until).map(o => o.text)
const candLines = cand.split('\n'), baseLines = baseText.split('\n')
const result: any = { path: rel, window: { from, until }, outputs: all.length, diff: [], numbered: { support: 0, contradict: [] as any[] }, added: { distinctive: 0, seen: 0 } }

// diff hunks: comparable only when the diff is against our base blob.
const hashOf = (text: string) => execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim()
const baseHash = baseText ? hashOf(baseText) : '0000000'
const candHash = hashOf(cand)
for (const o of all) {
  for (let idx = o.indexOf(`diff --git a/${rel} b/${rel}`); idx >= 0; idx = o.indexOf(`diff --git a/${rel} b/${rel}`, idx + 10)) {
    const m = /\nindex ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(o.slice(idx, idx + 400))
    if (!m || !baseHash.startsWith(m[1]!)) continue
    result.diff.push({ matches: candHash.startsWith(m[2]!), new: m[2] })
  }
}

// numbered runs
const NUM = /^\s*(\d+)(?:\t|→)(.*)$/
for (const o of all) {
  const lines = o.split('\n')
  let run: [number, string][] = []
  const flush = () => {
    if (run.length >= 3) {
      const ok = run.every(([n, t]) => candLines[n - 1] === t)
      if (ok) result.numbered.support++
      else {
        const baseOk = baseText && run.every(([n, t]) => baseLines[n - 1] === t)
        const elsewhere = candLines.join('\n').includes(run.map(x => x[1]).join('\n'))
        // Only a run that is evidently this file (matches base at those numbers,
        // or appears in the candidate at another offset) contradicts it.
        if (baseOk || elsewhere) result.numbered.contradict.push({ first: run[0]![0], len: run.length, matchesBase: !!baseOk, shifted: elsewhere })
      }
    }
    run = []
  }
  for (const l of lines) {
    const m = NUM.exec(l)
    if (m && (!run.length || Number(m[1]) === run[run.length - 1]![0] + 1)) run.push([Number(m[1]), m[2]!])
    else { flush(); if (m) run.push([Number(m[1]), m[2]!]) }
  }
  flush()
}

// distinctive added lines
const baseSet = new Set(baseLines.map(s => s.trim()))
const counts = new Map<string, number>()
for (const l of candLines) counts.set(l.trim(), (counts.get(l.trim()) ?? 0) + 1)
const added = [...new Set(candLines.map(s => s.trim()))].filter(s => s.length >= 25 && !baseSet.has(s) && counts.get(s) === 1)
const blob = all.join('\n')
result.added = { distinctive: added.length, seen: added.filter(s => blob.includes(s)).length }
result.transcripts = transcripts.length
result.pass = result.numbered.contradict.length === 0 && result.diff.every((d: any) => d.matches)
console.log(JSON.stringify(result))
process.exit(result.pass ? 0 : 1)
