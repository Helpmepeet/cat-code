#!/usr/bin/env bun
// Usage: bun scrubMaps.ts <repoCopyDir> --setup mandatory|nomap [--report out.json]
// Removes workspace-map material from a prepared working copy.
//  Both setups: earlier map-study conclusions (MAP_STUDY_FILES, measurement
//    entries in DONE.md) so neither arm reads prior verdicts on the maps.
//  No-map: also every other map-subject file and every map direction in text
//    documents. The smallest unit that carries the reference is removed: the
//    path/link/command token, then the sentence, then the list item, table row,
//    or section when nothing substantive is left. Source code is left intact
//    (it is the product under work; the study engine is frozen separately) and
//    reported. Remaining matches are reported for review; the build fails on
//    any that are not on the reviewed allowlist.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ANY, DONE_STUDY_ENTRY, MAP_STUDY_FILES, REVIEW, changes, scrubText, setCurrentFile } from './scrubCore.ts'
const residual: { file: string; line: number; text: string }[] = []
const sourceHits: { file: string; line: number; text: string }[] = []
const TEXT = /\.(md|mdx|txt|html?|json|ya?ml|toml|sh)$/i
const SOURCE = /\.(ts|tsx|js|mjs|cjs|css)$/i

const args = process.argv.slice(2)
const dir = args[0]!
const setup = args[args.indexOf('--setup') + 1] as 'mandatory' | 'nomap'
const reportOut = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined

function walk(d: string): string[] {
  return readdirSync(d).flatMap(n => {
    if (n === '.git' || n === 'node_modules') return []
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const remove = (rel: string, why: string) => { const p = join(dir, rel); if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); changes.push({ file: rel, action: `delete: ${why}` }) } }
for (const f of MAP_STUDY_FILES) remove(f, 'map-study conclusions')
const done = join(dir, 'DONE.md')
if (existsSync(done)) {
  const kept = readFileSync(done, 'utf8').split('\n').filter(l => { const hit = DONE_STUDY_ENTRY.test(l); if (hit) changes.push({ file: 'DONE.md', action: 'drop-entry: map-study conclusions', before: l.slice(0, 120) }); return !hit })
  writeFileSync(done, kept.join('\n'))
}

if (setup === 'nomap') {
  for (const p of walk(dir)) {
    const rel = relative(dir, p)
    if (!TEXT.test(p) && !SOURCE.test(p)) continue
    const text = readFileSync(p, 'utf8')
    if (!ANY.test(text)) continue
    setCurrentFile(rel)
    if (SOURCE.test(p)) {
      text.split('\n').forEach((l, n) => { if (ANY.test(l)) sourceHits.push({ file: rel, line: n + 1, text: l.trim().slice(0, 160) }) })
      continue
    }
    const next = scrubText(rel, text)
    if (next !== text) writeFileSync(p, next)
  }
}
const review: { file: string; line: number; text: string }[] = []
for (const p of walk(dir)) {
  const rel = relative(dir, p)
  if (!TEXT.test(p) || setup === 'mandatory') continue
  setCurrentFile(rel)
  readFileSync(p, 'utf8').split('\n').forEach((l, n) => {
    if (ANY.test(l)) residual.push({ file: rel, line: n + 1, text: l.trim().slice(0, 200) })
    else if (REVIEW.test(l)) review.push({ file: rel, line: n + 1, text: l.trim().slice(0, 200) })
  })
}
const report = { setup, review, changes: changes.length, deleted: changes.filter(c => c.action.startsWith('delete')).map(c => c.file), edited: [...new Set(changes.filter(c => !c.action.startsWith('delete')).map(c => c.file))], residual, sourceHits, detail: changes }
if (reportOut) writeFileSync(reportOut, JSON.stringify(report, null, 1))
console.log(JSON.stringify({ setup, review: review.length, changes: changes.length, deleted: report.deleted.length, edited: report.edited.length, residual: residual.length, sourceHits: sourceHits.length }))
process.exit(residual.length ? 1 : 0)
