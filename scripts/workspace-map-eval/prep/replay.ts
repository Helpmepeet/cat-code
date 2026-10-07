#!/usr/bin/env bun
// Usage: bun replay.ts <relPath> <isoTs> <baseCommit|none> [--root /Users/pt/cat-code] [--out file] [--after isoTs]
// Reconstructs a main-tree file as it stood at <isoTs>: the base commit's blob
// (or empty for an untracked file) plus every successful logged edit on that
// path after the base commit time (or --after) and at/before <isoTs>.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const [rel, ts, base] = args as [string, string, string]
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const root = opt('--root') ?? '/Users/pt/cat-code'
const abs = `${root}/${rel}`
const T = Date.parse(ts)

let content = ''
let since = 0
if (base !== 'none') {
  try { content = execFileSync('git', ['-C', root, 'show', `${base}:${rel}`], { encoding: 'utf8', maxBuffer: 1 << 28 }) } catch { content = '' }
  const last = execFileSync('git', ['-C', root, 'log', '-1', '--format=%cI', base, '--', rel], { encoding: 'utf8' }).trim()
  since = last ? Date.parse(last) : 0
}
if (opt('--after')) since = Date.parse(opt('--after')!)
const trueSince = since
// Partial (hunk-staged) commits leave earlier edits uncommitted: replay edits from
// before the last commit too, skipping hunks whose result is already present.
const lookbackH = Number(opt('--lookback-hours') ?? 0)
since -= lookbackH * 3600e3

const ledger = readFileSync('/Users/pt/workspace-map-study/ledger/edits.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
const rows = ledger
  .filter(r => (r.ok === true && r.tool !== 'Bash-write' && (r.paths ?? []).includes(abs)) || (r.tool === 'Bash-write' && r.ok !== false && heredocFor(r) !== null))
  .filter(r => { const t = Date.parse(r.ts); return t > since && t <= T })
  .sort((a, b) => a.ts.localeCompare(b.ts))
  .filter((r, i, all) => {
    // The same tool call can appear in several transcript files (resumed or forked sessions).
    const key = r.ts + JSON.stringify(r.payload)
    return all.findIndex(o => o.ts + JSON.stringify(o.payload) === key) === i
  })

function commandText(r: any): string {
  if (typeof r.payload === 'object' && r.payload?.command) return String(r.payload.command)
  const s = String(r.payload)
  const parts: string[] = []
  for (const m of s.matchAll(/cmd:\s*"((?:[^"\\]|\\.)*)"/g)) { try { parts.push(JSON.parse('"' + m[1] + '"')) } catch {} }
  return parts.join('\n')
}

function heredocFor(r: any): string | null {
  const cmd = commandText(r)
  for (const m of cmd.matchAll(/cat\s*>\s*(\S+)\s*<<-?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\2(?:\n|$)/g)) {
    const target = m[1]!.replace(/^['"]|['"]$/g, '')
    const full = target.startsWith('/') ? target : `${(cmd.match(/^cd\s+(\S+)/)?.[1]) ?? r.cwd ?? root}/${target}`
    if (full.replace(/\/\.\//g, '/') === abs) return m[3]! + '\n'
  }
  return null
}

function extractPatch(payload: unknown): string {
  if (typeof payload === 'object' && payload) {
    const p = payload as Record<string, unknown>
    if (typeof p.input === 'string') return p.input
    if (typeof p.patch === 'string') return p.patch
  }
  const s = String(payload)
  const i = s.indexOf('*** Begin Patch')
  if (i < 0) throw new Error('no patch')
  const q = s[i - 1]
  if (q === '"') {
    let j = i
    while (j < s.length) { if (s[j] === '\\') { j += 2; continue } if (s[j] === '"') break; j++ }
    return JSON.parse('"' + s.slice(i, j) + '"')
  }
  if (q === '`') {
    const j = s.indexOf('`', i)
    return s.slice(i, j).replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\')
  }
  if (q === "'") {
    let j = i
    while (j < s.length) { if (s[j] === '\\') { j += 2; continue } if (s[j] === "'") break; j++ }
    return JSON.parse('"' + s.slice(i, j).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"')
  }
  throw new Error('unknown patch quoting')
}

function sectionFor(patch: string, cwdPrefix: string): { kind: string; lines: string[] } | null {
  const lines = patch.split('\n')
  let cur: { kind: string; lines: string[] } | null = null
  for (const line of lines) {
    const m = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/)
    if (m) {
      const p = m[2]!.trim()
      const full = p.startsWith('/') ? p : `${cwdPrefix}/${p}`
      if (cur) return cur
      cur = full === abs ? { kind: m[1]!, lines: [] } : null
      continue
    }
    if (/^\*\*\* (End Patch|Move to:)/.test(line)) { if (cur) return cur; continue }
    if (cur) cur.lines.push(line)
  }
  return cur
}

let skippedHunks = 0
function applyUpdate(text: string, lines: string[]): string {
  const hunks: string[][] = []
  let h: string[] = []
  for (const line of lines) {
    if (line.startsWith('@@')) { if (h.length) hunks.push(h); h = []; continue }
    if (line === '*** End of File') continue
    h.push(line)
  }
  if (h.length) hunks.push(h)
  let pos = 0
  for (const hunk of hunks) {
    const oldL = hunk.filter(l => !l.startsWith('+')).map(l => l.slice(1))
    const newL = hunk.filter(l => !l.startsWith('-')).map(l => l.slice(1))
    const oldS = oldL.join('\n')
    let at = text.indexOf(oldS, pos)
    if (at < 0) at = text.indexOf(oldS)
    const newS = newL.join('\n')
    if (at < 0 && newS.length > 0 && text.includes(newS)) { skippedHunks++; continue }
    if (at < 0) {
      // Codex seek_sequence order: exact, trim_end, trim, then punctuation-normalized trim.
      const norm = (s: string) => s.trim().replace(/[‐-―−]/g, '-').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/[  -   　]/g, ' ')
      const fileLines = text.split('\n')
      let found = -1
      for (const f of [(s: string) => s.trimEnd(), (s: string) => s.trim(), norm]) {
        const want = oldL.map(f)
        const startAt = text.slice(0, pos).split('\n').length - 1
        for (const begin of [startAt, 0]) {
          for (let k = begin; k + want.length <= fileLines.length && found < 0; k++) {
            if (want.every((l, n) => f(fileLines[k + n]!) === l)) found = k
          }
          if (found >= 0) break
        }
        if (found >= 0) break
      }
      const trimmed = oldL
      if (found < 0) throw new Error(`hunk not found: ${oldS.slice(0, 120)}`)
      fileLines.splice(found, trimmed.length, ...newL)
      text = fileLines.join('\n')
      continue
    }
    text = text.slice(0, at) + newL.join('\n') + text.slice(at + oldS.length)
    pos = at + newL.join('\n').length
  }
  return text
}

const log: string[] = []
for (const r of rows) {
  const p = r.payload
  try {
    const early = Date.parse(r.ts) <= trueSince
    if ((r.tool === 'Write' || r.tool === 'Bash-write') && early && base !== 'none') { log.push(`skip ${r.ts} early full write`); continue }
    if (r.tool === 'Bash-write') content = heredocFor(r)!
    else if (r.tool === 'Write') content = p.content
    else if (r.tool === 'Edit') {
      if (!content.includes(p.old_string)) { if (p.new_string && content.includes(p.new_string)) { skippedHunks++; log.push(`skip ${r.ts} already applied`); continue } throw new Error('old_string not found') }
      content = p.replace_all ? content.split(p.old_string).join(p.new_string) : content.replace(p.old_string, () => p.new_string)
    } else if (r.tool === 'MultiEdit') {
      for (const e of p.edits) {
        if (!content.includes(e.old_string)) throw new Error('multiedit old_string not found')
        content = e.replace_all ? content.split(e.old_string).join(e.new_string) : content.replace(e.old_string, () => e.new_string)
      }
    } else if (/apply_patch/i.test(r.tool)) {
      const sec = sectionFor(extractPatch(p), r.cwd ?? root)
      if (!sec) throw new Error('file section not found in patch')
      if (sec.kind === 'Add') content = sec.lines.map(l => l.slice(1)).join('\n') + '\n'
      else if (sec.kind === 'Delete') content = ''
      else content = applyUpdate(content, sec.lines)
    } else throw new Error(`unsupported ${r.tool}`)
    log.push(`ok   ${r.ts} ${r.src} ${r.tool}`)
  } catch (e) {
    log.push(`FAIL ${r.ts} ${r.src} ${r.tool}: ${(e as Error).message}`)
  }
}
const out = opt('--out')
if (out) writeFileSync(out, content)
console.error(log.join('\n'))
const failed = log.filter(l => l.startsWith('FAIL')).length
const sha = new Bun.CryptoHasher('sha256').update(content).digest('hex')
console.error(`edits=${rows.length} failed=${failed} skippedHunks=${skippedHunks} bytes=${content.length} sha256=${sha}`)
if (!out) process.stdout.write(content)
// An incomplete replay is not a reconstruction: callers must treat it as failed
// even though the partial file is kept for inspection.
if (failed > 0) process.exit(2)
