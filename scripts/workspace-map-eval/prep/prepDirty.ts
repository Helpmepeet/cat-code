#!/usr/bin/env bun
// Usage: bun prepDirty.ts <taskDir> <base> <promptTs> <sessionTranscript> [--status-only]
// Determines the task-time dirty set of the main checkout and reconstructs
// each file (restoreFile.ts). Results: <taskDir>/dirty.json, <taskDir>/files/.
//
// Evidence is a full-tree `git status` snapshot. Only reliable ones count: a
// Claude-like Bash call that ran git status alone (an empty result proves a
// clean tree), or a Codex output that lists porcelain entries from an exec
// with no path-limited status. Path-limited statuses are partial and ignored.
// Choice, in order: the task's own session after the prompt and before its
// first write; the latest main-tree snapshot within 2h before the prompt; the
// earliest within 1h after it; the latest within 12h before it. A snapshot
// before the prompt is rolled forward (paths edited in between are added,
// paths committed in between with no later edit are dropped); one after it is
// rolled back (paths with no edit between their last commit and the prompt
// are dropped). Untracked directories expand to logged files under them.
// Generated test fixtures (fixtures/token-count-*) are recorded and skipped.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { outputs } from './outputs.ts'

const [taskDirArg, base, at, session] = process.argv.slice(2) as [string, string, string, string]
const statusOnly = process.argv.includes('--status-only')
const taskDir = resolve(taskDirArg)
const root = '/Users/pt/cat-code'
const ledger = readFileSync('/Users/pt/workspace-map-study/ledger/edits.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const sessionId = session.split('/').pop()!.replace(/\.jsonl$/, '').slice(-36)
const own = (f: string) => f === session || f.includes(`/${sessionId}/subagents/`)
const inMain = (p: string) => p.startsWith(root + '/') && !/\/\.(?:claude\/)?worktrees\//.test(p)
const mainEdits = ledger.filter(r => r.ok !== false && (r.cwd === root || (typeof r.cwd === 'string' && inMain(r.cwd)) || (r.paths ?? []).some(inMain)))
const firstOwnWrite = mainEdits.filter(r => own(r.file) && r.ts > at).map(r => r.ts).sort()[0] ?? '9999'
const T = Date.parse(at)

type Block = { ts: string; entries: { code: string; path: string }[]; file: string }
const PORCELAIN = /^(?: M|M |MM|AM|A | D|D |R |\?\?) (\S.*)$/
const FULL_STATUS = /^\s*git (?:--no-optional-locks )?(?:-c \S+ )*status(?: --short| -s| --porcelain(?:=v1)?| -b| -uall| --untracked-files=\w+)*\s*$/
function reliableBlocks(file: string): Block[] {
  const res: Block[] = []
  for (const o of outputs(file)) {
    const entries = o.text.split('\n').flatMap(l => { const m = PORCELAIN.exec(l.replace(/^\s*\d+\t/, '')); return m ? [{ code: l.slice(0, 2), path: m[1]! }] : [] })
    let cmd: string | undefined
    try { cmd = JSON.parse(o.command).command } catch {}
    if (typeof cmd === 'string') {
      // git status alone, or one full-tree status inside an && chain that
      // succeeded (its porcelain lines, if any, appear in the output).
      const segs = cmd.split(/\s*&&\s*/)
      const statusSegs = segs.filter(x => /\bgit\b.*\bstatus\b/.test(x))
      if (statusSegs.length !== 1 || !FULL_STATUS.test(statusSegs[0]!) || /[|;]/.test(cmd)) continue
      if (/^Exit code [1-9]|^fatal:/m.test(o.text)) continue
      const clean = segs.length > 1 || !o.text.split('\n').some(l => l.trim() && !/fsmonitor|^Exit code 0$|completed with no output/i.test(l))
      if (entries.length || clean) res.push({ ts: o.ts, entries, file })
    } else if (entries.length && /status --short/.test(o.command) && !/status --short(?: --)? [\w./]/.test(o.command)) {
      res.push({ ts: o.ts, entries, file })
    }
  }
  return res
}
function mainTree(f: string): boolean {
  try {
    for (const l of readFileSync(f, 'utf8').split('\n', 40)) {
      const r = JSON.parse(l)
      const cwd = r.payload?.cwd ?? r.cwd
      if (typeof cwd === 'string') return cwd.replace(/^file:\/\//, '') === root
    }
  } catch {}
  return false
}

let source = 'own'
let block = reliableBlocks(session).find(b => b.ts >= at && b.ts < firstOwnWrite)
if (!block) {
  const lo = T - 12 * 3600e3, hi = T + 3600e3
  const walk = (d: string): string[] => { try { return readdirSync(d).flatMap(n => { const q = join(d, n); const st = statSync(q); return st.isDirectory() ? walk(q) : n.endsWith('.jsonl') && st.mtimeMs >= lo ? [q] : [] }) } catch { return [] } }
  const h = homedir()
  const all = [...walk(join(h, '.cat-code/projects')), ...walk(join(h, '.claude/projects')), ...walk(join(h, '.codex/sessions'))].filter(mainTree)
  const blocks = all.flatMap(reliableBlocks).filter(b => Date.parse(b.ts) >= lo && Date.parse(b.ts) <= hi)
  const before = blocks.filter(b => b.ts <= at).sort((a, b) => b.ts.localeCompare(a.ts))
  const after = blocks.filter(b => b.ts > at).sort((a, b) => a.ts.localeCompare(b.ts))
  if (before[0] && T - Date.parse(before[0].ts) <= 2 * 3600e3) { block = before[0]; source = 'before' }
  else if (after[0]) { block = after[0]; source = 'after' }
  else if (before[0]) { block = before[0]; source = 'before (over 2h)' }
}
if (!block) throw new Error('no reliable full-tree git status within 12h before or 1h after the prompt')
const statusAt = block.ts

// Structured writes name the path; shell writes may name only a distinctive
// basename (after cd, or inside a helper script). Short common basenames
// (schemas.ts) would match unrelated commands, so they need the full path.
const touches = (r: any, rel: string) => {
  if ((r.paths ?? []).includes(`${root}/${rel}`)) return true
  if (r.tool !== 'Bash-write') return false
  const payload = JSON.stringify(r.payload ?? '')
  const name = rel.split('/').pop()!
  return payload.includes(rel) || (name.length >= 20 && payload.includes(name))
}
const git = (args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).stdout.trim()
const tracked = (rel: string) => spawnSync('git', ['-C', root, 'cat-file', '-e', `${base}:${rel}`]).status === 0
const lastCommitBefore = (rel: string, ts: string) => { const r = git(['log', '-1', `--before=${ts}`, '--format=%cI', base, '--', rel]); return r ? new Date(r).toISOString() : '' }

const paths: { path: string; code: string; why?: string }[] = []
for (const e of block.entries) {
  if (!e.path.endsWith('/')) { paths.push({ path: e.path, code: e.code }); continue }
  const prefix = `${root}/${e.path}`
  const files = new Set<string>()
  for (const r of ledger) for (const p of r.paths ?? []) if (p.startsWith(prefix) && r.ts <= at && r.ok !== false) files.add(p.slice(root.length + 1))
  for (const f of files) paths.push({ path: f, code: e.code })
}
const dropped: { path: string; why: string }[] = []
if (statusAt > at) {
  for (let k = paths.length - 1; k >= 0; k--) {
    const rel = paths[k]!.path, c = lastCommitBefore(rel, at)
    if (!mainEdits.some(r => r.ts > c && r.ts <= at && touches(r, rel))) { dropped.push({ path: rel, why: 'first changed after the prompt' }); paths.splice(k, 1) }
  }
} else if (statusAt < at) {
  for (const r of mainEdits) if (r.ts > statusAt && r.ts <= at) for (const p of r.paths ?? []) {
    const rel = inMain(p) && !/[$`{}*]/.test(p) ? p.slice(root.length + 1) : ''
    if (rel && !paths.some(x => x.path === rel)) paths.push({ path: rel, code: tracked(rel) ? ' M' : '??', why: 'edited between snapshot and prompt' })
  }
  for (let k = paths.length - 1; k >= 0; k--) {
    const rel = paths[k]!.path, c = lastCommitBefore(rel, at)
    if (c && c > statusAt && !mainEdits.some(r => r.ts > c && r.ts <= at && touches(r, rel))) { dropped.push({ path: rel, why: `committed ${c} before the prompt` }); paths.splice(k, 1) }
  }
}

const results: any[] = []
for (const { path, code, why } of paths) {
  if (/^fixtures\/token-count-/.test(path)) { results.push({ path, code, skipped: 'generated test fixture' }); continue }
  if (code.includes('D')) { results.push({ path, code, deleted: true }); continue }
  if (statusOnly) { results.push({ path, code, why }); continue }
  const out = join(taskDir, 'files', path)
  mkdirSync(dirname(out), { recursive: true })
  const r = spawnSync('bun', [join(import.meta.dir, 'restoreFile.ts'), '--path', path, '--base', base, '--at', at, '--out', out], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
  const line = r.stdout.trim().split('\n').pop() ?? '{}'
  let j: any; try { j = JSON.parse(line) } catch { j = { ok: false, error: (r.stderr || line).slice(0, 300) } }
  results.push({ path, code, why, ...j })
  console.error(`${j.ok ? 'ok  ' : 'FAIL'} ${j.method ?? ''} ${path}`)
}
const summary = { base, at, statusSource: source, statusFile: block.file.split('/').pop(), statusAt, dropped, results }
if (!statusOnly) writeFileSync(join(taskDir, 'dirty.json'), JSON.stringify(summary, null, 1))
console.log(JSON.stringify({ source, statusFile: summary.statusFile, statusAt, files: results.length, ok: results.filter(r => r.ok).length, failed: results.filter(r => r.ok === false).map(r => r.path), dropped: dropped.length, ...(statusOnly ? { paths: results.map(r => r.path) } : {}) }))
