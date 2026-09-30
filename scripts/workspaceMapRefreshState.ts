#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeFileAtomicDurableSync } from '../src/utils/atomicFile.js'
import { acquireMutationLockSync } from '../src/utils/lockfile.js'
import { validateWorkspaceMaps, type MapLintResult } from './workspaceMapLint.js'

// Git is the durable map snapshot. This one file owns the successful cursor and
// the current transaction; memory.md is only a human-readable projection.
type Cursor = { sourceSha: string; mapCommitSha: string; runId: string; completedAt: string }
type ChangedPath = { path: string; status: string; previousPath?: string }
type PreparedCommit = { mapHash: string; paths: string[]; summary: string }
export type RefreshRun = {
  runId: string
  targetSha: string
  branch: string
  coverage: 'incremental' | 'baseline' | 'divergence'
  baseSha: string | null
  legacyHintSha: string | null
  createdAt: string
  leaseUntil: string
  status: 'reviewing' | 'committing' | 'blocked' | 'complete'
  changedPaths: ChangedPath[]
  adoptedPaths: string[]
  blockers: string[]
  prepared: PreparedCommit | null
  validation: MapLintResult | null
  mapCommitSha: string | null
}
export type RefreshState = { schemaVersion: 2; repositoryRoot: string; cursor: Cursor | null; run: RefreshRun | null }
type Options = { repoRoot: string; stateDir: string }
const MAP_PATH = /^docs\/maps\/[^/]+\.md$/
const LEASE_MS = 6 * 60 * 60 * 1000
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const now = () => new Date().toISOString()
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  })
}
function gitDiffExists(repo: string, args: string[]): boolean {
  try {
    git(repo, args)
    return false
  } catch (error) {
    if ((error as { status?: number }).status === 1) return true
    throw error
  }
}
function ancestor(repo: string, a: string, b: string): boolean {
  try { git(repo, ['merge-base', '--is-ancestor', a, b]); return true } catch { return false }
}
function identity(repo: string) {
  const root = realpathSync(repo)
  if (git(root, ['rev-parse', '--show-toplevel']).trim() !== root) throw new Error('repository root mismatch')
  const branch = git(root, ['symbolic-ref', '--short', 'HEAD']).trim()
  return { root, branch, head: git(root, ['rev-parse', 'HEAD']).trim() }
}
function safeFile(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing symlink: ${path}`)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
}
function withState<T>(options: Options, fn: (state: RefreshState, save: () => void, dir: string) => T): T {
  safeFile(options.stateDir)
  mkdirSync(options.stateDir, { recursive: true })
  const dir = realpathSync(options.stateDir)
  for (const name of ['state.json', 'memory.md', 'legacy-memory.md', 'refresh-run-lock']) safeFile(join(dir, name))
  const release = acquireMutationLockSync(join(dir, 'refresh-run-lock'), { label: 'workspace map refresh', waitMs: 5_000 })
  try {
    const root = realpathSync(options.repoRoot)
    const file = join(dir, 'state.json')
    const state: RefreshState = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { schemaVersion: 2, repositoryRoot: root, cursor: null, run: null }
    if (state.schemaVersion !== 2 || state.repositoryRoot !== root || !('cursor' in state) || !('run' in state)) throw new Error('invalid refresh state or repository identity')
    const save = () => writeFileAtomicDurableSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    return fn(state, save, dir)
  } finally { release() }
}
function workingMaps(repo: string): Record<string, string> {
  safeFile(join(repo, 'docs'))
  safeFile(join(repo, 'docs/maps'))
  return Object.fromEntries(readdirSync(join(repo, 'docs/maps')).filter(name => name.endsWith('.md')).sort().map(name => {
    const path = `docs/maps/${name}`
    safeFile(join(repo, path))
    if (!lstatSync(join(repo, path)).isFile()) throw new Error(`map is not a regular file: ${path}`)
    return [path, hash(readFileSync(join(repo, path)))]
  }))
}
function committedMaps(repo: string, sha: string): Record<string, string> {
  return Object.fromEntries(git(repo, ['ls-tree', '-r', '-z', '--name-only', sha, '--', 'docs/maps']).split('\0').filter(Boolean).sort().map(path => {
    if (!MAP_PATH.test(path)) throw new Error(`unsupported map path: ${path}`)
    return [path, hash(git(repo, ['show', `${sha}:${path}`]))]
  }))
}
function mapHash(files: Record<string, string>): string { return hash(JSON.stringify(files)) }
function changedMaps(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]).sort()
}
function changedPaths(repo: string, base: string | null, target: string): ChangedPath[] {
  if (!base) return git(repo, ['ls-tree', '-r', '-z', '--name-only', target]).split('\0').filter(Boolean).map(path => ({ path, status: 'BASELINE' }))
  const fields = git(repo, ['diff', '--name-status', '-z', '--find-renames', base, target]).split('\0').filter(Boolean)
  const paths: ChangedPath[] = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]!
    if (status.startsWith('R') || status.startsWith('C')) paths.push({ status, previousPath: fields[i++]!, path: fields[i++]! })
    else paths.push({ status, path: fields[i++]! })
  }
  return paths
}
function legacyHint(dir: string): string | null {
  const path = join(dir, 'memory.md')
  if (!existsSync(path)) return null
  const entries = readFileSync(path, 'utf8').split(/(?=^Last run:)/m).map(entry => ({
    time: Date.parse(entry.match(/^Last run:\s*(.+)$/m)?.[1] ?? ''),
    sha: entry.match(/^\s*- Processed source SHA:\s*([a-f0-9]{40,64})\s*$/m)?.[1],
  })).filter(entry => entry.sha && Number.isFinite(entry.time)).sort((a, b) => b.time - a.time)
  return entries[0]?.sha ?? null
}
function requireRun(state: RefreshState, runId: string): RefreshRun {
  if (!state.run || state.run.runId !== runId) throw new Error('run ID does not match the current refresh')
  return state.run
}
function assertTarget(repo: string, run: RefreshRun): void {
  const current = identity(repo)
  if (current.head !== run.targetSha || current.branch !== run.branch) throw new Error('HEAD or branch moved during refresh; record a block and restart from the new target')
}
function projectMemory(state: RefreshState, dir: string): void {
  const cursor = state.cursor!
  const file = join(dir, 'memory.md')
  // Preserve the historical migration input once; it is never used as a cursor.
  if (!existsSync(join(dir, 'legacy-memory.md')) && existsSync(file)) writeFileAtomicDurableSync(join(dir, 'legacy-memory.md'), readFileSync(file, 'utf8'), { mode: 0o600 })
  writeFileAtomicDurableSync(file, [
    `Last run: ${cursor.completedAt}`, '', `- Run ID: ${cursor.runId}`,
    `- Processed source SHA: ${cursor.sourceSha}`, `- Map commit SHA: ${cursor.mapCommitSha}`,
    `- Result: ${state.run?.prepared?.paths.length ? 'committed map changes' : 'verified no-op'}`,
    `- Summary: ${state.run?.prepared?.summary ?? ''}`,
    '- Authoritative cursor and run status: state.json. Legacy manifest/snapshot/patch files are retired.', '',
  ].join('\n'), { mode: 0o600 })
}
function complete(state: RefreshState, run: RefreshRun, commit: string, save: () => void, dir: string): void {
  state.cursor = { sourceSha: run.targetSha, mapCommitSha: commit, runId: run.runId, completedAt: now() }
  run.status = 'complete'
  run.mapCommitSha = commit
  run.blockers = []
  save() // The cursor and completion are one atomic write; memory is derived.
  projectMemory(state, dir)
}
function verifyCommit(repo: string, run: RefreshRun, sha: string): void {
  const prepared = run.prepared!
  if (git(repo, ['rev-parse', `${sha}^`]).trim() !== run.targetSha) throw new Error('map commit has an unexpected parent')
  const paths = git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).trim().split('\n').filter(Boolean).sort()
  if (!same(paths, prepared.paths) || paths.some(path => !MAP_PATH.test(path))) throw new Error('map commit contains unexpected paths')
  if (mapHash(committedMaps(repo, sha)) !== prepared.mapHash) throw new Error('committed maps differ from the reviewed bytes; cursor unchanged')
}
function recover(state: RefreshState, save: () => void, dir: string): void {
  const run = state.run
  if (!run) return
  const repo = state.repositoryRoot
  if (run.status === 'complete') { projectMemory(state, dir); return }
  if (run.prepared) {
    const current = identity(repo)
    if (current.branch !== run.branch || !ancestor(repo, run.targetSha, current.head)) throw new Error('cannot recover on a different branch or divergent history')
    if (run.prepared.paths.length === 0 && current.head === run.targetSha && mapHash(committedMaps(repo, current.head)) === run.prepared.mapHash) {
      complete(state, run, current.head, save, dir)
      return
    }
    const commits = git(repo, ['log', '--format=%H', '--fixed-strings', `--grep=Map-Refresh-Run: ${run.runId}`, `${run.targetSha}..HEAD`]).trim().split('\n').filter(Boolean)
    for (const sha of commits) {
      const message = git(repo, ['show', '-s', '--format=%B', sha])
      if (!message.split('\n').includes(`Map-Refresh-Run: ${run.runId}`)) continue
      verifyCommit(repo, run, sha)
      complete(state, run, sha, save, dir)
      return
    }
  }
  if (['reviewing', 'committing'].includes(run.status) && Date.now() > Date.parse(run.leaseUntil)) {
    run.status = 'blocked'
    run.blockers = [...new Set([...run.blockers, 'refresh lease expired before completion; inspect retained map edits before restarting'])]
    save()
  }
}
export function recoverRefresh(options: Options): RefreshState {
  return withState(options, (state, save, dir) => { recover(state, save, dir); return state })
}
export function startRefresh(options: Options & { adoptMaps?: string[] }): RefreshState {
  return withState(options, (state, save, dir) => {
    recover(state, save, dir)
    if (state.run && ['reviewing', 'committing'].includes(state.run.status)) throw new Error(`refresh ${state.run.runId} still holds its lease; do not recover a live review as interrupted`)
    const current = identity(options.repoRoot)
    const committed = committedMaps(current.root, current.head)
    const dirty = [...new Set([
      ...changedMaps(committed, workingMaps(current.root)),
      ...git(current.root, ['diff', '--cached', '--name-only', '--', 'docs/maps']).trim().split('\n').filter(Boolean),
    ])].sort()
    const adopted = [...new Set(options.adoptMaps ?? [])].sort()
    const cursor = state.cursor
    const trusted = cursor && ancestor(current.root, cursor.sourceSha, current.head) && ancestor(current.root, cursor.mapCommitSha, current.head)
    const coverage = !cursor ? 'baseline' : trusted ? 'incremental' : 'divergence'
    state.run = {
      runId: randomUUID(), targetSha: current.head, branch: current.branch, coverage,
      baseSha: trusted ? cursor.sourceSha : null, legacyHintSha: cursor ? null : legacyHint(dir),
      createdAt: now(), leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), status: 'reviewing',
      changedPaths: changedPaths(current.root, trusted ? cursor.sourceSha : null, current.head),
      adoptedPaths: adopted, blockers: state.run?.blockers ?? [], prepared: null, validation: null, mapCommitSha: null,
    }
    if (adopted.some(path => !MAP_PATH.test(path)) || !same(dirty, adopted)) {
      state.run.status = 'blocked'
      const reason = `pre-existing map edits require explicit reviewed adoption, or must be left untouched: ${dirty.join(', ') || '(none)'}`
      state.run.blockers = [...new Set([...state.run.blockers, reason])]
      save()
      throw new Error(reason)
    }
    save()
    return state
  })
}
function check(repo: string, run: RefreshRun) {
  assertTarget(repo, run)
  const files = workingMaps(repo)
  const validation = validateWorkspaceMaps(repo, { sourceCommit: run.targetSha })
  git(repo, ['diff', run.targetSha, '--check', '--', 'docs/maps'])
  if (!same(files, workingMaps(repo))) throw new Error('map files changed during validation')
  if (validation.errors.length) throw new Error(validation.errors.join('\n'))
  return { mapHash: mapHash(files), changedMaps: changedMaps(committedMaps(repo, run.targetSha), files), validation }
}
export function checkRefresh(options: Options & { runId: string }) {
  return withState(options, state => check(state.repositoryRoot, requireRun(state, options.runId)))
}
export function blockRefresh(options: Options & { runId: string; blocker: string }): RefreshState {
  return withState(options, (state, save) => {
    const run = requireRun(state, options.runId)
    if (run.status === 'complete') throw new Error('cannot block a completed run')
    if (!options.blocker.trim()) throw new Error('a blocker reason is required')
    run.status = 'blocked'
    run.blockers = [...new Set([...run.blockers, options.blocker])]
    save() // Deliberately independent of Git, map parsing, and validation.
    return state
  })
}
export function finishRefresh(options: Options & { runId: string; reviewedMapHash: string; maps: string[]; summary: string; baselineReviewed?: boolean }): RefreshState {
  return withState(options, (state, save, dir) => {
    const run = requireRun(state, options.runId)
    recover(state, save, dir)
    if (run.status === 'complete') return state
    try {
      if (Date.now() > Date.parse(run.leaseUntil)) throw new Error('review lease expired; restart after inspecting retained work')
      if (run.coverage !== 'incremental' && !options.baselineReviewed) throw new Error('full routing baseline review must be explicitly acknowledged')
      if (!options.summary.trim()) throw new Error('a semantic review summary is required')
      const checked = check(state.repositoryRoot, run)
      const paths = [...new Set(options.maps)].sort()
      if (!same(paths, checked.changedMaps) || paths.some(path => !MAP_PATH.test(path))) throw new Error('explicit map paths do not match the reviewed map diff')
      if (options.reviewedMapHash !== checked.mapHash) throw new Error('map bytes changed since review; review the new diff before finishing')
      if (paths.length === 0 && git(state.repositoryRoot, ['diff', '--cached', '--name-only', '--', 'docs/maps']).trim()) throw new Error('staged map edits prevent a no-op')
      for (const path of paths) {
        const staged = gitDiffExists(state.repositoryRoot, ['diff', '--cached', '--quiet', '--', path])
        const workingDiffersFromIndex = gitDiffExists(state.repositoryRoot, ['diff', '--quiet', '--', path])
        if (staged && workingDiffersFromIndex) {
          throw new Error(`staged map content differs from the reviewed working file: ${path}`)
        }
      }
      run.prepared = { mapHash: checked.mapHash, paths, summary: options.summary.trim() }
      run.validation = checked.validation
      run.status = 'committing'
      save() // This intent identifies an already-created commit after a crash.
      if (paths.length === 0) {
        assertTarget(state.repositoryRoot, run)
        complete(state, run, run.targetSha, save, dir)
        return state
      }
      git(state.repositoryRoot, ['add', '--', ...paths])
      git(state.repositoryRoot, ['diff', '--cached', '--check', '--', ...paths])
      assertTarget(state.repositoryRoot, run)
      if (mapHash(workingMaps(state.repositoryRoot)) !== checked.mapHash) throw new Error('map files changed before commit')
      git(state.repositoryRoot, ['commit', '--only', '-m', `docs(maps): refresh workspace routes\n\n${run.prepared.summary}\n\nMap-Refresh-Run: ${run.runId}\nMap-Source-SHA: ${run.targetSha}`, '--', ...paths])
      const commit = git(state.repositoryRoot, ['rev-parse', 'HEAD']).trim()
      verifyCommit(state.repositoryRoot, run, commit)
      complete(state, run, commit, save, dir)
      return state
    } catch (error) {
      if (state.run?.status !== 'complete') {
        run.status = 'blocked'
        run.blockers = [...new Set([...run.blockers, error instanceof Error ? error.message : String(error)])]
        save()
      }
      throw error
    }
  })
}

if (import.meta.main) {
  try {
    const [command = 'help', ...args] = process.argv.slice(2)
    const flags = new Map<string, string[]>()
    const booleanFlags = new Set(['baseline-reviewed'])
    const allowed: Record<string, string[]> = {
      start: ['repo-root', 'state-dir', 'adopt-map'], recover: ['repo-root', 'state-dir'],
      check: ['repo-root', 'state-dir', 'run-id'], block: ['repo-root', 'state-dir', 'run-id', 'blocker'],
      finish: ['repo-root', 'state-dir', 'run-id', 'reviewed-map-hash', 'map', 'summary', 'baseline-reviewed'],
    }
    if (command === 'help' || args.includes('--help')) {
      console.log('Workspace map refresh: start → review → check → finish (validates, commits, records cursor).\nCommands: start, check, finish, block, recover.\nAll commands: --state-dir <path> [--repo-root <path>]\nstart: [--adopt-map <reviewed dirty map>] (repeatable; normal runs require clean maps)\ncheck: --run-id <id>\nfinish: --run-id <id> --reviewed-map-hash <hash from check> --summary <semantic review> [--map <owned path>]... [--baseline-reviewed]\nblock: --run-id <id> --blocker <reason>\nrecover: finish a recorded commit, or expire a review after six hours. Never steals an active lease.\nstate.json is authoritative; Git replaces legacy snapshots and recovery patches.')
    } else {
      for (let i = 0; i < args.length; i++) {
        const key = args[i]!.replace(/^--/, '')
        if (!args[i]!.startsWith('--') || !allowed[command]?.includes(key)) throw new Error(`unknown option or command: ${args[i]}`)
        const value = booleanFlags.has(key) ? 'true' : args[++i]
        if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`)
        flags.set(key, [...(flags.get(key) ?? []), value])
      }
      const required = (key: string) => { const value = flags.get(key)?.[0]; if (!value) throw new Error(`--${key} is required`); return value }
      const options = { repoRoot: resolve(flags.get('repo-root')?.[0] ?? process.cwd()), stateDir: resolve(required('state-dir')) }
      let result: unknown
      if (command === 'start') result = startRefresh({ ...options, adoptMaps: flags.get('adopt-map') })
      else if (command === 'recover') result = recoverRefresh(options)
      else if (command === 'check') result = checkRefresh({ ...options, runId: required('run-id') })
      else if (command === 'block') result = blockRefresh({ ...options, runId: required('run-id'), blocker: required('blocker') })
      else if (command === 'finish') result = finishRefresh({ ...options, runId: required('run-id'), reviewedMapHash: required('reviewed-map-hash'), maps: flags.get('map') ?? [], summary: required('summary'), baselineReviewed: flags.has('baseline-reviewed') })
      else throw new Error(`unknown command: ${command}`)
      // Keep thousands of paths in state.json rather than flooding a model's context.
      if (result && typeof result === 'object' && 'run' in result && result.run) {
        const run = (result as RefreshState).run!
        const { changedPaths, ...summary } = run
        result = { ...(result as RefreshState), run: { ...summary, changedPathCount: changedPaths.length }, stateFile: join(options.stateDir, 'state.json') }
      }
      console.log(JSON.stringify(result, null, 2))
    }
  } catch (error) {
    console.error(`workspace-map-refresh: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
