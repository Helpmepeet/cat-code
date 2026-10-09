#!/usr/bin/env bun
// Usage: bun runManifest.ts --credential <file>
// Writes ~/workspace-map-study/runs/manifest.json: the 32 approved-run commands
// (16 tasks x 2 setups) in execution order. Arm order alternates by task so
// neither setup always runs first; the two runs of a task are back to back.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STUDY = '/Users/pt/workspace-map-study'
const args = process.argv.slice(2)
const credential = args[args.indexOf('--credential') + 1] ?? '<credential file>'
const sel = JSON.parse(readFileSync(join(STUDY, 'selection-v2/selection.json'), 'utf8'))
// Per-run caps; t8 is a long orchestration (about 168M input in the original).
const CAPS: Record<string, { minutes: number; input: number }> = { t8: { minutes: 180, input: 150e6 } }
const runs: unknown[] = []
sel.tasks.forEach((t: any, i: number) => {
  const order = i % 2 === 0 ? ['mandatory', 'nomap'] : ['nomap', 'mandatory']
  const m = JSON.parse(readFileSync(join(STUDY, 'copies', t.id, 'manifest.json'), 'utf8'))
  for (const setup of order) {
    const dir = join(STUDY, 'copies', t.id, setup)
    const cap = CAPS[t.id] ?? { minutes: 60, input: 40e6 }
    const cmd = ['bun', join(import.meta.dir, 'harness/harness.ts'), '--live', '--credential', credential,
      '--engine', m.copies[setup].engine, '--copy', dir, '--out', join(STUDY, 'runs', t.id, setup), '--prompt-file', join(dir, 'prompt.txt'),
      '--model', 'gpt-6.1-sol', '--effort', 'high', '--mode', 'auto',
      '--max-minutes', String(cap.minutes), '--max-input-tokens', String(cap.input)]
    for (const [flag, f] of [['--images', 'images'], ['--bin', 'bin'], ['--abs', 'abs.json']] as const) {
      if (existsSync(join(dir, f))) cmd.push(flag, join(dir, f))
    }
    runs.push({ n: runs.length + 1, task: t.id, category: t.category, author: t.author, setup, cap, command: cmd })
  }
})
mkdirSync(join(STUDY, 'runs'), { recursive: true })
writeFileSync(join(STUDY, 'runs/manifest.json'), JSON.stringify({ generated: new Date().toISOString(), model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'auto', fastMode: false, runs }, null, 1))
console.log(JSON.stringify({ runs: runs.length }))
