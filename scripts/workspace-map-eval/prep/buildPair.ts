#!/usr/bin/env bun
// Usage: bun buildPair.ts <task-spec.json>
// Builds the mandatory-maps and no-maps working copies for one task under
// ~/workspace-map-study/copies/<id>/ and writes a manifest.
//
// Spec: { id, ts, baseCommit, restore: [{ path, from }], deleted: [path],
//         inputs: [{ from, to, until? }], prompt: { file, nomapFile?, images? },
//         nomapPromptEdits: [[from, to]], stubs: [{ name, from, data }],
//         homeSeed: { mandatory, nomap }, abs }
//   restore: task-time dirty files (from = reconstructed file), left uncommitted;
//            dirty docs/maps files land in the mandatory copy only.
//   stubs:   offline stand-ins for network CLIs, put first on the run's PATH.
// Map material: scrubMaps.ts removes earlier map-study conclusions from both
// copies, and every map direction from the no-map copy, before the baseline
// commit and again after restoring dirty files.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { MAP_PATTERN, noMapClaude, noMapTree } from './noMapTree.ts'

const LIVE = '/Users/pt/cat-code'
const COPIES = '/Users/pt/workspace-map-study/copies'
const ENGINE = '/Users/Shared/cce/5c23b91a'
const ENGINES = { mandatory: ENGINE, nomap: '/Users/Shared/cce/5c23b91a-nomap' }
const TOOLS = import.meta.dir
const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const T = Date.parse(spec.ts)
const root = join(COPIES, spec.id)
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const sh = (cmd: string, args: string[], cwd?: string, env?: Record<string, string>) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...env } })

rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const manifest: Record<string, any> = { id: spec.id, ts: spec.ts, baseCommit: spec.baseCommit, engine: '5c23b91abbcf6a7b4489b49a66acf7b91fc24811', engines: ENGINES, copies: {} }
function scrub(repo: string, setup: 'mandatory' | 'nomap', report: string) {
  try { return JSON.parse(sh('bun', [join(TOOLS, 'scrubMaps.ts'), repo, '--setup', setup, '--report', report]).trim()) }
  catch (e: any) { throw new Error(`scrubMaps left map text in the ${setup} copy (see ${report}): ${e.stdout ?? e}`) }
}

// 1. History-free export of the task-time commit.
const base = join(root, 'base')
mkdirSync(base)
execFileSync('/bin/sh', ['-c', `git -C ${LIVE} archive ${spec.baseCommit} | tar -x -C '${base}'`])

// 2. Untracked project-local guidance (.cat-code/skills, .claude/rules) has no
// history; an mtime is not proof of content at T (skill syncs can preserve
// mtimes). Include a file only when the spec lists it with content verified
// against a contemporaneous transcript read: { path, from, verifiedBy }.
const localGuidance: { path: string; sha256: string; verifiedBy: string }[] = []
for (const g of spec.localGuidance ?? []) {
  if (!g.verifiedBy) throw new Error(`local guidance ${g.path} lacks verification evidence`)
  mkdirSync(dirname(join(base, g.path)), { recursive: true })
  cpSync(g.from, join(base, g.path))
  localGuidance.push({ path: g.path, sha256: sha(g.from), verifiedBy: g.verifiedBy })
}
manifest.localGuidance = localGuidance

const todayHooks = join(LIVE, '.claude/hooks')
const hookEntry = (script: string, matcher: string) => ({ matcher, hooks: [{ type: 'command', command: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/${script}`, timeout: 10 }] })

const today = readFileSync(join(LIVE, 'CLAUDE.md'), 'utf8')
function mandatoryClaude(text: string): string {
  // Replace the snapshot's map clauses with today's wherever they differ.
  const clause = (s: string, re: RegExp) => s.match(re)?.[0]
  const pairs: RegExp[] = [
    /- `docs\/maps\/`[^\n]*\n[^\n]*\n/,
    /For repository work, read \[the workspace map\][\s\S]*?not the whole repository\.\n/,
  ]
  let t = text
  for (const re of pairs) {
    const mine = clause(t, re), theirs = clause(today, re)
    if (theirs && mine && mine !== theirs) t = t.replace(mine, theirs)
    if (theirs && !mine) throw new Error(`snapshot CLAUDE.md lacks map clause ${re}; manual mapping needed`)
  }
  return t
}

for (const setup of ['mandatory', 'nomap'] as const) {
  const repo = join(root, setup, 'cat-code')
  mkdirSync(dirname(repo), { recursive: true })
  execFileSync('cp', ['-c', '-R', base, repo])
  const notes: string[] = []
  const claudePath = join(repo, 'CLAUDE.md')
  const original = readFileSync(claudePath, 'utf8')
  const settings: Record<string, any> = { hooks: { PreToolUse: [] as unknown[] } }
  mkdirSync(join(repo, '.claude/hooks'), { recursive: true })
  cpSync(join(todayHooks, 'block-sweep-kill.sh'), join(repo, '.claude/hooks/block-sweep-kill.sh'))
  if (setup === 'mandatory') {
    writeFileSync(claudePath, mandatoryClaude(original))
    cpSync(join(todayHooks, 'map-routing-nudge.sh'), join(repo, '.claude/hooks/map-routing-nudge.sh'))
    cpSync(join(LIVE, 'scripts/mapRoutingNudge.ts'), join(repo, 'scripts/mapRoutingNudge.ts'))
    settings.hooks.PreToolUse.push(hookEntry('map-routing-nudge.sh', 'Grep|Glob|Bash'))
    for (const m of spec.maps ?? []) { cpSync(m.from, join(repo, m.path)); notes.push(`task-time dirty map restored: ${m.path}`) }
  } else {
    notes.push(...noMapTree(repo))
  }
  settings.hooks.PreToolUse.push(hookEntry('block-sweep-kill.sh', 'Bash'))
  mkdirSync(join(repo, '.cat-code'), { recursive: true })
  writeFileSync(join(repo, '.cat-code/settings.local.json'), JSON.stringify(settings, null, 2) + '\n')
  const scrubBase = scrub(repo, setup, join(root, setup, 'scrub-base.json'))

  // 3. One history-free root commit holding this copy's baseline, so git status
  // and diff behave as at task time while no-map leaves no deletion trail.
  const gitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Cat Code', GIT_AUTHOR_EMAIL: 'cat-code@localhost', GIT_COMMITTER_NAME: 'Cat Code', GIT_COMMITTER_EMAIL: 'cat-code@localhost', GIT_AUTHOR_DATE: spec.ts, GIT_COMMITTER_DATE: spec.ts }
  sh('git', ['init', '-q', '-b', 'main'], repo, gitEnv)
  // Mirror the live checkout's local excludes: .claude/ was never tracked.
  writeFileSync(join(repo, '.git/info/exclude'), '.claude/\n')
  sh('git', ['add', '-A'], repo, gitEnv)
  sh('git', ['commit', '-q', '-m', 'Initial commit'], repo, gitEnv)

  // 4. Task-time dirty files, left uncommitted as they were at the prompt.
  const restored: { path: string; sha256: string; sourceSha256?: string }[] = []
  for (const r of spec.restore ?? []) {
    if (setup === 'nomap' && r.path.startsWith('docs/maps/')) continue
    mkdirSync(dirname(join(repo, r.path)), { recursive: true })
    cpSync(r.from, join(repo, r.path))
    // A task-time dirty CLAUDE.md still gets this copy's treatment.
    if (r.path === 'CLAUDE.md') {
      const t = readFileSync(join(repo, r.path), 'utf8')
      const treated = setup === 'mandatory' ? mandatoryClaude(t) : noMapClaude(t)
      if (setup === 'nomap') { const left = treated.split('\n').filter(l => MAP_PATTERN.test(l)); if (left.length) throw new Error(`restored CLAUDE.md keeps map clauses:\n${left.join('\n')}`) }
      writeFileSync(join(repo, r.path), treated)
    }
    restored.push({ path: r.path, sha256: sha(join(repo, r.path)), sourceSha256: sha(r.from) })
  }
  for (const d of spec.deleted ?? []) { rmSync(join(repo, d), { force: true }); restored.push({ path: d, sha256: 'deleted' }) }
  const scrubRestored = scrub(repo, setup, join(root, setup, 'scrub-restored.json'))
  for (const r of restored) if (r.sha256 !== 'deleted' && existsSync(join(repo, r.path))) r.sha256 = sha(join(repo, r.path))

  // Inputs. to: "repo:<rel>" lands in the copy, "home:<rel>" in home-seed/
  // (copied into the run's fresh HOME), an absolute path must already hold the
  // identical file. until: cut a JSONL transcript at the prompt time.
  const inputs: Record<string, unknown>[] = []
  for (const i of spec.inputs ?? []) {
    let data = readFileSync(i.from)
    if (i.until) {
      const keep: string[] = []
      for (const line of data.toString('utf8').split('\n')) {
        let ts = ''
        try { ts = JSON.parse(line).timestamp ?? '' } catch {}
        if (ts && ts > i.until) break
        keep.push(line)
      }
      data = Buffer.from(keep.join('\n'))
    }
    let dest: string
    if (i.to.startsWith('repo:')) dest = join(repo, i.to.slice(5))
    else if (i.to.startsWith('home:')) dest = join(root, setup, 'home-seed', i.to.slice(5))
    else { if (sha(i.to) !== createHash('sha256').update(data).digest('hex')) throw new Error(`external input ${i.to} differs from source`); inputs.push({ ...i, dest: i.to, sha256: sha(i.to), external: true }); continue }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, data)
    inputs.push({ ...i, dest, sha256: sha(dest) })
  }

  // 5. Dependencies: clone the engine's install only when the lockfile matches.
  for (const [lock, nm] of [['bun.lock', 'node_modules'], ['app/bun.lock', 'app/node_modules']] as const) {
    const a = join(repo, lock), b = join(ENGINE, lock)
    if (existsSync(a) && existsSync(b) && sha(a) === sha(b)) { execFileSync('cp', ['-c', '-R', join(ENGINE, nm), join(repo, nm)]); notes.push(`${nm}: cloned (lockfile identical to engine)`) }
    else notes.push(`${nm}: NOT installed (lockfile differs from engine)`)
  }

  // Home inputs prepared per setup (makeInputs.ts): copied into the run's HOME.
  const seed = spec.homeSeed?.[setup]
  if (seed) { cpSync(seed, join(root, setup, 'home-seed'), { recursive: true }); notes.push(`home-seed from ${seed}`) }

  // Offline stand-ins for network CLIs (e.g. gh serving a pre-request snapshot).
  for (const st of spec.stubs ?? []) {
    const bin = join(root, setup, 'bin')
    mkdirSync(bin, { recursive: true })
    cpSync(st.from, join(bin, st.name))
    execFileSync('chmod', ['+x', join(bin, st.name)])
    // data: [{ from, to }] or per setup { mandatory: [...], nomap: [...] }
    const data = Array.isArray(st.data) ? st.data : st.data?.[setup] ?? []
    for (const d of data) { mkdirSync(dirname(join(bin, d.to)), { recursive: true }); cpSync(d.from, join(bin, d.to), { recursive: true }) }
    notes.push(`stub on PATH: ${st.name}`)
  }

  manifest.copies[setup] = {
    repo,
    engine: ENGINES[setup],
    scrub: { base: scrubBase, restored: scrubRestored },
    claudeMdSha256: sha(claudePath),
    claudeMdChanged: readFileSync(claudePath, 'utf8') !== original,
    restored,
    inputs,
    notes,
    headCommit: sh('git', ['rev-parse', 'HEAD'], repo).trim(),
  }
  writeFileSync(join(root, setup, 'CLAUDE.md.diff'), (() => { try { return sh('diff', ['-u', join(base, 'CLAUDE.md'), claudePath]) } catch (e: any) { return e.stdout ?? '' } })())
}

// 6. Prompts and inputs (outside the repo copies).
const promptText = readFileSync(spec.prompt.file, 'utf8')
writeFileSync(join(root, 'mandatory', 'prompt.txt'), promptText)
// The no-map prompt comes either from recorded anchor edits or from a file
// produced by the document scrub (makePrompts.ts), whose diff is kept.
let nomapPrompt = spec.prompt.nomapFile ? readFileSync(spec.prompt.nomapFile, 'utf8') : promptText
for (const [from, to] of spec.nomapPromptEdits ?? []) {
  if (!nomapPrompt.includes(from)) throw new Error(`prompt edit anchor missing: ${from}`)
  nomapPrompt = nomapPrompt.replace(from, to)
}
writeFileSync(join(root, 'nomap', 'prompt.txt'), nomapPrompt)
// Map text left in the no-map prompt must be a recorded, deliberate exception.
const promptMap = nomapPrompt.split('\n').filter(l => /docs\/maps|WORKSPACE_MAP|workspace map|focused maps?|maps:lint|map-first/i.test(l))
if (promptMap.length && !spec.nomapPromptKeep) throw new Error(`no-map prompt still directs to maps:\n${promptMap.join('\n')}`)
for (const setup of ['mandatory', 'nomap']) for (const [n, img] of (spec.prompt.images ?? []).entries()) {
  mkdirSync(join(root, setup, 'images'), { recursive: true })
  cpSync(img, join(root, setup, 'images', `${n + 1}${img.slice(img.lastIndexOf('.'))}`))
}
if (spec.abs) for (const setup of ['mandatory', 'nomap']) cpSync(spec.abs, join(root, setup, 'abs.json'))
manifest.prompt = { sha256: sha(join(root, 'mandatory', 'prompt.txt')), nomapSha256: sha(join(root, 'nomap', 'prompt.txt')), nomapEdits: spec.nomapPromptEdits ?? [], nomapDiff: (() => { try { return sh('diff', ['-u', join(root, 'mandatory', 'prompt.txt'), join(root, 'nomap', 'prompt.txt')]) } catch (e: any) { return e.stdout ?? '' } })(), images: (spec.prompt.images ?? []).map((p: string) => sha(p)) }
rmSync(base, { recursive: true, force: true })
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify(manifest, null, 2))
