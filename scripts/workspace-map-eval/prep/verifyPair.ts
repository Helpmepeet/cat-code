#!/usr/bin/env bun
// Usage: bun verifyPair.ts <taskId> [--expect-unavailable a,b] [--probe-bash '<cmd>']
// Startup verification for one built pair, through the production sidecar
// path: harness.ts for each setup (mandatory on the frozen engine, no-map on
// its clone without the routing sentence), then compare.ts over every captured
// request and detect.ts over every transcript the runs wrote. Results under
// ~/workspace-map-study/verify/<id>/. Exit 1 if any check fails.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const STUDY = '/Users/pt/workspace-map-study'
const args = process.argv.slice(2)
const id = args[0]!
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const manifest = JSON.parse(readFileSync(join(STUDY, 'copies', id, 'manifest.json'), 'utf8'))
const out = join(STUDY, 'verify', id)
mkdirSync(out, { recursive: true })
const run = (cmd: string[], log: string) => {
  const r = spawnSync('bun', cmd, { encoding: 'utf8', maxBuffer: 1 << 28 })
  writeFileSync(join(out, log), `${r.stdout}\n${r.stderr}`)
  return r
}
const result: Record<string, unknown> = { id }
for (const setup of ['mandatory', 'nomap'] as const) {
  const dir = join(STUDY, 'copies', id, setup)
  const h = ['--engine', manifest.copies[setup].engine, '--copy', dir, '--out', join(out, setup), '--prompt-file', join(dir, 'prompt.txt')]
  if (existsSync(join(dir, 'images'))) h.push('--images', join(dir, 'images'))
  if (existsSync(join(dir, 'bin'))) h.push('--bin', join(dir, 'bin'))
  if (existsSync(join(dir, 'abs.json'))) h.push('--abs', join(dir, 'abs.json'))
  if (opt('--probe-bash')) h.push('--probe-bash', opt('--probe-bash')!)
  const r = run([join(import.meta.dir, 'harness/harness.ts'), ...h], `${setup}-harness.log`)
  let summary: any = {}
  try { summary = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) } catch {}
  const stage = existsSync(join(out, setup, 'stage.json')) ? JSON.parse(readFileSync(join(out, setup, 'stage.json'), 'utf8')).stage : ''
  const d = run([join(import.meta.dir, 'detect.ts'), join(out, setup, 'home'), '--setup', setup, '--stage', stage, ...(existsSync(join(dir, 'home-seed')) ? ['--seed', join(dir, 'home-seed')] : []), '--json', join(out, `${setup}-detect.json`)], `${setup}-detect.log`)
  result[setup] = { harnessExit: r.status, turnCompleted: summary.turnCompleted, requests: summary.requests?.length, detectExit: d.status }
}
const c = run([join(import.meta.dir, 'harness/compare.ts'), join(out, 'mandatory'), join(out, 'nomap'), '--engine', manifest.copies.mandatory.engine, '--json', join(out, 'compare.json'), '--nomap-prompt', join(STUDY, 'copies', id, 'nomap', 'prompt.txt'), ...(opt('--expect-unavailable') ? ['--expect-unavailable', opt('--expect-unavailable')!] : [])], 'compare.log')
result.compareExit = c.status
const m = result.mandatory as any, n = result.nomap as any
result.pass = c.status === 0 && m.detectExit === 0 && n.detectExit === 0 && m.turnCompleted && n.turnCompleted
writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 1))
console.log(JSON.stringify(result))
process.exit(result.pass ? 0 : 1)
