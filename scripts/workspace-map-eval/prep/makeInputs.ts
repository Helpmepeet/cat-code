#!/usr/bin/env bun
// Usage: bun makeInputs.ts <taskId>
// Materializes a task's home inputs as they stood at the prompt into
// tasks-v2/<id>/home-seed/{mandatory,nomap}/ (copied into the run's fresh HOME).
//   session: a Cat Code session (transcript, subagents/, tool-results/), JSONL cut
//            at the prompt time, other files kept only if modified by then.
//   dir:     a directory snapshot: files modified at or before the prompt.
//   file:    one file (JSONL cut at the prompt time).
// The no-map seed passes every text input through scrubTranscript.ts.
// Prints a manifest; exit 1 when a no-map input keeps map text.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const STUDY = '/Users/pt/workspace-map-study'
const H = '/Users/pt'
type Input = { kind: 'session' | 'dir' | 'file'; from: string; to: string }
const TASKS: Record<string, { at: string; inputs: Input[] }> = {
  t3: { at: '2026-10-06T02:29:04.304Z', inputs: [{ kind: 'file', from: `${H}/.claude/skills/eli5/SKILL.md`, to: '.cat-code/skills/eli5/SKILL.md' }] },
  t7: { at: '2026-10-05T16:06:16.385Z', inputs: [{ kind: 'session', from: `${H}/.cat-code/projects/-Users-pt-cat-code/9a12b48e-b2c2-4095-a20b-610afc45bba3`, to: '.cat-code/projects/-Users-pt-cat-code/9a12b48e-b2c2-4095-a20b-610afc45bba3' }] },
  n3: { at: '2026-10-06T04:31:23.808Z', inputs: [{ kind: 'session', from: `${H}/.cat-code/projects/-Users-pt-cat-code/9a12b48e-b2c2-4095-a20b-610afc45bba3`, to: '.cat-code/projects/-Users-pt-cat-code/9a12b48e-b2c2-4095-a20b-610afc45bba3' }] },
  t9: { at: '2026-10-05T14:19:24.759Z', inputs: [
    { kind: 'dir', from: `${H}/.cat-code/session-relocations`, to: '.cat-code/session-relocations' },
    { kind: 'session', from: `${H}/.cat-code/projects/-private-tmp-catcode-move-gui-j4s0gS-trusted-project/badacf31-9327-4356-b3c5-55ac27e4cfd9`, to: '.cat-code/projects/-private-tmp-catcode-move-gui-j4s0gS-trusted-project/badacf31-9327-4356-b3c5-55ac27e4cfd9' },
  ] },
}

const id = process.argv[2]!
const task = TASKS[id]
if (!task) { console.log(JSON.stringify({ id, inputs: 0 })); process.exit(0) }
const T = Date.parse(task.at)
const root = join(STUDY, 'tasks-v2', id, 'home-seed')
rmSync(root, { recursive: true, force: true })
const manifest: any[] = []
let residual = 0
const residualFiles = new Set<string>()

function cutJsonl(text: string): string {
  const keep: string[] = []
  for (const line of text.split('\n')) {
    let ts = ''
    try { ts = JSON.parse(line).timestamp ?? '' } catch {}
    if (ts && Date.parse(ts) > T) break
    keep.push(line)
  }
  return keep.join('\n')
}
function put(src: string, rel: string, data?: Buffer | string) {
  const buf = data ?? readFileSync(src)
  for (const setup of ['mandatory', 'nomap'] as const) {
    const dest = join(root, setup, rel)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buf)
    if (setup === 'nomap' && /\.(jsonl|json|txt|md)$/.test(dest)) {
      const r = spawnSync('bun', [join(import.meta.dir, 'scrubTranscript.ts'), dest, dest + '.scrubbed', '--report', dest + '.scrub.json'], { encoding: 'utf8' })
      if (r.status !== 0) { residual++; residualFiles.add(rel) }
      const scrubbed = readFileSync(dest + '.scrubbed')
      writeFileSync(dest, scrubbed)
      rmSync(dest + '.scrubbed')
      const rep = JSON.parse(readFileSync(dest + '.scrub.json', 'utf8'))
      rmSync(dest + '.scrub.json')
      if (rep.removedCalls || rep.editedStrings) manifest.push({ rel, nomapScrub: { removedCalls: rep.removedCalls, editedStrings: rep.editedStrings } })
    }
  }
  manifest.push({ rel, from: src, sha256: createHash('sha256').update(buf).digest('hex') })
}
function walk(d: string): string[] { return existsSync(d) ? readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] }) : [] }

for (const i of task.inputs) {
  if (i.kind === 'file') { put(i.from, i.to, i.from.endsWith('.jsonl') ? cutJsonl(readFileSync(i.from, 'utf8')) : undefined); continue }
  if (i.kind === 'session') {
    const main = `${i.from}.jsonl`
    put(main, `${i.to}.jsonl`, cutJsonl(readFileSync(main, 'utf8')))
    for (const f of walk(i.from)) {
      const rel = join(i.to, relative(i.from, f))
      if (f.endsWith('.jsonl')) {
        const cut = cutJsonl(readFileSync(f, 'utf8'))
        if (cut.trim()) put(f, rel, cut)
      } else if (statSync(f).mtimeMs <= T) put(f, rel)
    }
    continue
  }
  for (const f of walk(i.from)) if (statSync(f).mtimeMs <= T) put(f, join(i.to, relative(i.from, f)))
}
// A saved tool result whose call was removed from the no-map transcripts is
// orphaned there (it is the output of a map read): drop it from the no-map seed.
const nomapRoot = join(root, 'nomap')
const jsonlText = walk(nomapRoot).filter(f => f.endsWith('.jsonl')).map(f => readFileSync(f, 'utf8')).join('\n')
for (const f of walk(nomapRoot)) {
  if (!/\/tool-results\/[^/]+$/.test(f)) continue
  const name = f.split('/').pop()!
  if (!jsonlText.includes(name)) {
    const wasResidual = residualFiles.delete(relative(nomapRoot, f))
    rmSync(f)
    if (wasResidual) residual--
    manifest.push({ rel: relative(nomapRoot, f), nomapDropped: 'saved output of a removed map read' })
  }
}
writeFileSync(join(STUDY, 'tasks-v2', id, 'inputs.json'), JSON.stringify({ at: task.at, files: manifest }, null, 1))
console.log(JSON.stringify({ id, files: manifest.filter(m => m.from).length, nomapScrubbed: manifest.filter(m => m.nomapScrub).length, nomapDropped: manifest.filter(m => m.nomapDropped).length, residual, residualFiles: [...residualFiles] }))
process.exit(residual ? 1 : 0)
