#!/usr/bin/env bun
// Usage: bun makeSpecs.ts [taskId...]
// Writes tasks-v2/<id>/spec.json for buildPair.ts from the prepared pieces:
// selection-v2/tasks.tsv (id, inventory index, base commit), dirty.json
// (restored task-time files), prompt.{mandatory,nomap}.txt, images/,
// home-seed/{mandatory,nomap}, abs.json, and per-task stubs.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STUDY = '/Users/pt/workspace-map-study'
const inv = JSON.parse(readFileSync(join(STUDY, 'selection-v2/tasks.json'), 'utf8')).tasks
const STUBS: Record<string, unknown[]> = {
  n122: [{ name: 'gh', from: join(import.meta.dir, 'stubs/gh'), data: {
    mandatory: [{ from: join(STUDY, 'tasks-v2/n122/gh-data'), to: 'gh-data' }],
    nomap: [{ from: join(STUDY, 'tasks-v2/n122/gh-data-nomap'), to: 'gh-data' }],
  } }],
}
// Dirty files deliberately left out, as a unit, with the reason.
const EXCLUDE: Record<string, { paths: string[]; why: string }> = {
  t21: {
    paths: ['app/sidecar/historyProjection.test.ts', 'app/renderer/src/paneStructure.dom.test.ts', 'app/sidecar/historyProjection.ts', 'app/renderer/src/SessionPane.tsx', 'app/renderer/src/App.tsx'],
    why: 'concurrent session n34 in-progress edits (history auto-recovery); SessionPane.tsx cannot be verified (the only in-window diff is truncated) and a partial set would be inconsistent; unrelated to the workspace-jump design task',
  },
}
const only = process.argv.slice(2)
for (const line of readFileSync(join(STUDY, 'selection-v2/tasks.tsv'), 'utf8').trim().split('\n')) {
  const [id, idx, base] = line.split('\t') as [string, string, string]
  if (only.length && !only.includes(id)) continue
  const dir = join(STUDY, 'tasks-v2', id)
  const dirty = JSON.parse(readFileSync(join(dir, 'dirty.json'), 'utf8'))
  const ex = EXCLUDE[id]
  const restore = dirty.results.filter((r: any) => r.ok && !ex?.paths.includes(r.path)).map((r: any) => ({ path: r.path, from: join(dir, 'files', r.path), method: r.method }))
  const notRestored = dirty.results.filter((r: any) => (!r.ok && !r.deleted) || ex?.paths.includes(r.path)).map((r: any) => ({ path: r.path, why: ex?.paths.includes(r.path) ? ex.why : r.skipped ?? `no verified reconstruction (${r.method ?? r.error ?? 'unknown'})` }))
  // Images as the desktop composer would send them (prepareImages.ts).
  const images = existsSync(join(dir, 'images-prepared')) ? readdirSync(join(dir, 'images-prepared')).sort((a, b) => parseInt(a) - parseInt(b)).map(f => join(dir, 'images-prepared', f)) : []
  if (!images.length && existsSync(join(dir, 'images')) && readdirSync(join(dir, 'images')).length) throw new Error(`${id}: run prepareImages.ts first`)
  const spec = {
    id, inventoryIndex: Number(idx), src: inv[Number(idx)].src, session: inv[Number(idx)].id,
    ts: inv[Number(idx)].ts, baseCommit: base,
    dirtyStatus: { source: dirty.statusSource, file: dirty.statusFile, at: dirty.statusAt },
    restore, deleted: dirty.results.filter((r: any) => r.deleted).map((r: any) => r.path), notRestored,
    prompt: { file: join(dir, 'prompt.mandatory.txt'), nomapFile: join(dir, 'prompt.nomap.txt'), images },
    ...(existsSync(join(dir, 'home-seed')) ? { homeSeed: { mandatory: join(dir, 'home-seed/mandatory'), nomap: join(dir, 'home-seed/nomap') } } : {}),
    ...(existsSync(join(dir, 'abs.json')) ? { abs: join(dir, 'abs.json') } : {}),
    ...(STUBS[id] ? { stubs: STUBS[id] } : {}),
  }
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 1))
  console.log(JSON.stringify({ id, restore: restore.length, notRestored: notRestored.length, images: images.length, homeSeed: !!spec.homeSeed, stubs: !!STUBS[id] }))
}
