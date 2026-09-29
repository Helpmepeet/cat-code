import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blockRefresh, checkRefresh, finishRefresh, recoverRefresh, startRefresh, type RefreshState } from './workspaceMapRefreshState.js'

const roots: string[] = []
const map = 'docs/maps/domain.md'
const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
function fixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'map-refresh-repo-'))
  const stateDir = mkdtempSync(join(tmpdir(), 'map-refresh-state-'))
  roots.push(repoRoot, stateDir)
  mkdirSync(join(repoRoot, 'docs/maps'), { recursive: true })
  mkdirSync(join(repoRoot, 'src'))
  writeFileSync(join(repoRoot, 'src/owner.ts'), 'export const owner = 1\n')
  writeFileSync(join(repoRoot, 'docs/maps/WORKSPACE_MAP.md'), '# Workspace Map\n\n| Sub-map | Scope | Last refreshed |\n|---|---|---|\n| [`docs/maps/domain.md`](domain.md) | Domain. | 2026-09-29 |\n')
  writeFileSync(join(repoRoot, map), '# Domain\n\nLast refreshed: 2026-09-29\n\n## First Files To Inspect\n\n`src/owner.ts`\n\n## Tests And Validation\n\nRead source.\n\n## Traps And Stale Assumptions\n\nVerify source.\n')
  git(repoRoot, 'init', '-q')
  git(repoRoot, 'config', 'user.email', 'map-fixture@example.com')
  git(repoRoot, 'config', 'user.name', 'Map Fixture')
  git(repoRoot, 'config', 'commit.gpgsign', 'false')
  git(repoRoot, 'add', '--', 'src/owner.ts', map, 'docs/maps/WORKSPACE_MAP.md')
  git(repoRoot, 'commit', '-q', '-m', 'fixture')
  return { repoRoot, stateDir }
}
function append(repo: string, path: string, text: string) { writeFileSync(join(repo, path), readFileSync(join(repo, path), 'utf8') + text) }
function state(options: { stateDir: string }): RefreshState { return JSON.parse(readFileSync(join(options.stateDir, 'state.json'), 'utf8')) }
function finish(options: ReturnType<typeof fixture>, runId: string, baselineReviewed = true) {
  const checked = checkRefresh({ ...options, runId })
  return finishRefresh({ ...options, runId, reviewedMapHash: checked.mapHash, maps: checked.changedMaps, summary: 'Reviewed owner and validation routes.', baselineReviewed })
}
function hook(repo: string, name: string, script: string) {
  const path = join(repo, '.git/hooks', name)
  writeFileSync(path, `#!/bin/sh\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}
afterEach(() => { setSystemTime(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })

describe('Git-backed workspace map refresh', () => {
  test('commits maps in a large repository and preserves unrelated staged and unstaged work', () => {
    const options = fixture()
    const { repoRoot, stateDir } = options
    writeFileSync(join(repoRoot, 'large.dat'), 'x'.repeat(2 * 1024 * 1024))
    git(repoRoot, 'add', '--', 'large.dat')
    git(repoRoot, 'commit', '-q', '-m', 'large source tree')
    const target = git(repoRoot, 'rev-parse', 'HEAD')
    const run = startRefresh(options).run!
    append(repoRoot, map, '\nOwner routing remains source-backed.\n')
    writeFileSync(join(repoRoot, 'unrelated.txt'), 'staged work\n')
    git(repoRoot, 'add', '--', 'unrelated.txt')
    append(repoRoot, 'src/owner.ts', '// uncommitted source\n')
    const stagedBefore = git(repoRoot, 'show', ':unrelated.txt')
    const result = finish(options, run.runId)
    expect(result.cursor?.sourceSha).toBe(target)
    expect(result.cursor?.mapCommitSha).not.toBe(target)
    expect(git(repoRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe(map)
    expect(git(repoRoot, 'show', ':unrelated.txt')).toBe(stagedBefore)
    expect(git(repoRoot, 'diff', '--cached', '--name-only')).toBe('unrelated.txt')
    expect(readFileSync(join(repoRoot, 'src/owner.ts'), 'utf8')).toContain('uncommitted source')
    expect(readFileSync(join(stateDir, 'memory.md'), 'utf8')).toContain(result.cursor!.mapCommitSha)
    expect(existsSync(join(stateDir, 'last-run.snapshot.json'))).toBe(false)
    expect(existsSync(join(stateDir, 'last-run.patch'))).toBe(false)
  })

  test.each([false, true])('uses dated legacy hints in either order, requiring baseline review (reverse=%s)', reverse => {
    const options = fixture()
    const first = git(options.repoRoot, 'rev-parse', 'HEAD')
    append(options.repoRoot, 'src/owner.ts', '// next\n')
    git(options.repoRoot, 'add', '--', 'src/owner.ts')
    git(options.repoRoot, 'commit', '-q', '-m', 'next')
    const latest = git(options.repoRoot, 'rev-parse', 'HEAD')
    const entries = [`Last run: 2026-08-25T03:00:00Z\n- Processed source SHA: ${first}`, `Last run: 2026-09-05T03:00:00Z\n- Processed source SHA: ${latest}`]
    writeFileSync(join(options.stateDir, 'memory.md'), (reverse ? entries.reverse() : entries).join('\n\n'))
    const started = startRefresh(options)
    expect(started.run?.legacyHintSha).toBe(latest)
    expect(started.run?.coverage).toBe('baseline')
    expect(started.cursor).toBeNull()
    expect(() => finish(options, started.run!.runId, false)).toThrow('baseline review')
    expect(state(options).cursor).toBeNull()
    const completed = finish(options, started.run!.runId)
    expect(completed.cursor?.mapCommitSha).toBe(latest)
    expect(git(options.repoRoot, 'rev-parse', 'HEAD')).toBe(latest)
    expect(existsSync(join(options.stateDir, 'legacy-memory.md'))).toBe(true)
    expect(startRefresh(options).run?.coverage).toBe('incremental')
  })

  test('checks immutable source including Markdown links and paths inside commands', () => {
    const options = fixture()
    const run = startRefresh(options).run!
    writeFileSync(join(options.repoRoot, 'src/new.ts'), 'uncommitted\n')
    writeFileSync(join(options.repoRoot, 'docs/guide.md'), 'uncommitted\n')
    append(options.repoRoot, map, '\n`bun test src/{owner,new}.ts`\n[Guide](../guide.md)\n')
    expect(() => checkRefresh({ ...options, runId: run.runId })).toThrow('src/new.ts')
    expect(() => finishRefresh({ ...options, runId: run.runId, maps: [map], reviewedMapHash: 'unused', summary: 'review', baselineReviewed: true })).toThrow('broken link target')
    expect(state(options).run?.status).toBe('blocked')
    expect(state(options).cursor).toBeNull()
    expect(blockRefresh({ ...options, runId: run.runId, blocker: 'source is not committed' }).run?.blockers).toContain('source is not committed')
  })

  test('rejects map drift after review and HEAD movement without advancing the cursor', () => {
    const options = fixture()
    const run = startRefresh(options).run!
    const reviewed = checkRefresh({ ...options, runId: run.runId })
    append(options.repoRoot, map, '\nconcurrent map edit\n')
    expect(() => finishRefresh({ ...options, runId: run.runId, maps: [map], reviewedMapHash: reviewed.mapHash, summary: 'review', baselineReviewed: true })).toThrow('map bytes changed')
    append(options.repoRoot, 'src/owner.ts', '// concurrent committed source\n')
    git(options.repoRoot, 'add', '--', 'src/owner.ts')
    git(options.repoRoot, 'commit', '-q', '-m', 'concurrent source')
    expect(() => checkRefresh({ ...options, runId: run.runId })).toThrow('HEAD or branch moved')
    expect(state(options).cursor).toBeNull()
  })

  test('requires explicit adoption of pre-existing map changes and explicit paths at finish', () => {
    const options = fixture()
    append(options.repoRoot, map, '\nprevious work\n')
    expect(() => startRefresh(options)).toThrow('pre-existing map edits')
    const run = startRefresh({ ...options, adoptMaps: [map] }).run!
    const checked = checkRefresh({ ...options, runId: run.runId })
    expect(() => finishRefresh({ ...options, runId: run.runId, reviewedMapHash: checked.mapHash, maps: [], summary: 'review', baselineReviewed: true })).toThrow('explicit map paths')
    expect(finish(options, run.runId).run?.status).toBe('complete')
  })

  test('does not steal a live review and carries blockers after a lease expires', () => {
    const options = fixture()
    const run = startRefresh(options).run!
    expect(recoverRefresh(options).run?.status).toBe('reviewing')
    expect(() => startRefresh(options)).toThrow('still holds its lease')
    setSystemTime(Date.now() + 7 * 60 * 60 * 1000)
    expect(recoverRefresh(options).run?.status).toBe('blocked')
    expect(startRefresh(options).run?.blockers.join(' ')).toContain('lease expired')
    expect(state(options).run?.runId).not.toBe(run.runId)
  })

  test('a real failing commit hook leaves a blocked run and the old cursor; retry honors hooks', () => {
    const options = fixture()
    const initial = startRefresh(options).run!
    finish(options, initial.runId)
    const cursor = state(options).cursor
    const run = startRefresh(options).run!
    append(options.repoRoot, map, '\nreviewed change\n')
    const failedHook = hook(options.repoRoot, 'pre-commit', 'echo fixture-commit-failure >&2\nexit 1')
    expect(() => finish(options, run.runId)).toThrow('fixture-commit-failure')
    expect(state(options).cursor).toEqual(cursor)
    expect(state(options).run?.status).toBe('blocked')
    rmSync(failedHook)
    expect(finish(options, run.runId).run?.status).toBe('complete')
  })

  test('recovers the real commit intent captured by a hook without replaying or losing newer edits', () => {
    const options = fixture()
    const run = startRefresh(options).run!
    append(options.repoRoot, map, '\nreviewed change\n')
    const savedIntent = join(options.stateDir, 'intent-at-commit.json')
    hook(options.repoRoot, 'post-commit', `cp ${quote(join(options.stateDir, 'state.json'))} ${quote(savedIntent)}`)
    const completed = finish(options, run.runId)
    const commit = git(options.repoRoot, 'rev-parse', 'HEAD')
    copyFileSync(savedIntent, join(options.stateDir, 'state.json'))
    expect(state(options).cursor).toBeNull()
    append(options.repoRoot, map, '\nnewer work after the completed commit\n')
    const recovered = recoverRefresh(options)
    expect(recovered.cursor).toEqual({ ...completed.cursor!, completedAt: recovered.cursor!.completedAt })
    expect(git(options.repoRoot, 'rev-parse', 'HEAD')).toBe(commit)
    expect(readFileSync(join(options.repoRoot, map), 'utf8')).toContain('newer work')
  })

  test('refuses to certify a hook-modified map commit', () => {
    const options = fixture()
    const run = startRefresh(options).run!
    append(options.repoRoot, map, '\nreviewed change\n')
    hook(options.repoRoot, 'pre-commit', `echo 'unreviewed hook change' >> ${quote(map)}\ngit add -- ${quote(map)}`)
    expect(() => finish(options, run.runId)).toThrow('committed maps differ')
    expect(state(options).cursor).toBeNull()
    expect(() => recoverRefresh(options)).toThrow('committed maps differ')
  })

  test('commits a new indexed subsystem map and then completes a no-op without an empty commit', () => {
    const options = fixture()
    const run = startRefresh(options).run!
    const fresh = 'docs/maps/new-domain.md'
    copyFileSync(join(options.repoRoot, map), join(options.repoRoot, fresh))
    append(options.repoRoot, 'docs/maps/WORKSPACE_MAP.md', '| [`docs/maps/new-domain.md`](new-domain.md) | New domain. | 2026-09-29 |\n')
    finish(options, run.runId)
    const head = git(options.repoRoot, 'rev-parse', 'HEAD')
    expect(git(options.repoRoot, 'show', `HEAD:${fresh}`)).toContain('src/owner.ts')
    const next = startRefresh(options).run!
    finish(options, next.runId, false)
    expect(git(options.repoRoot, 'rev-parse', 'HEAD')).toBe(head)
    expect(state(options).cursor?.sourceSha).toBe(head)
    const retirement = startRefresh(options).run!
    rmSync(join(options.repoRoot, fresh))
    const index = join(options.repoRoot, 'docs/maps/WORKSPACE_MAP.md')
    writeFileSync(index, readFileSync(index, 'utf8').split('\n').filter(line => !line.includes('new-domain.md')).join('\n'))
    finish(options, retirement.runId, false)
    expect(git(options.repoRoot, 'ls-tree', '--name-only', 'HEAD', '--', fresh)).toBe('')
  })

  test('uses a full baseline after branch divergence', () => {
    const options = fixture()
    const base = git(options.repoRoot, 'rev-parse', 'HEAD')
    append(options.repoRoot, 'src/owner.ts', '// other history\n')
    git(options.repoRoot, 'add', '--', 'src/owner.ts')
    git(options.repoRoot, 'commit', '-q', '-m', 'other history')
    finish(options, startRefresh(options).run!.runId)
    git(options.repoRoot, 'checkout', '-q', '-b', 'divergent', base)
    expect(startRefresh(options).run?.coverage).toBe('divergence')
  })

  test('rejects map and state symlinks without touching their targets', () => {
    const options = fixture()
    const outside = join(options.stateDir, 'outside.md')
    writeFileSync(outside, 'preserved\n')
    symlinkSync(outside, join(options.repoRoot, 'docs/maps/escape.md'))
    expect(() => startRefresh(options)).toThrow('symlink')
    expect(readFileSync(outside, 'utf8')).toBe('preserved\n')
    const alias = join(options.repoRoot, 'state-alias')
    symlinkSync(options.stateDir, alias)
    expect(() => startRefresh({ ...options, stateDir: alias })).toThrow('symlink')
  })

  test('a staged-only map edit cannot become a recovered no-op', () => {
    const options = fixture()
    const run = startRefresh(options).run!
    const original = readFileSync(join(options.repoRoot, map), 'utf8')
    append(options.repoRoot, map, '\nstaged concurrent work\n')
    git(options.repoRoot, 'add', '--', map)
    writeFileSync(join(options.repoRoot, map), original)
    expect(() => finish(options, run.runId)).toThrow('staged map edits prevent a no-op')
    expect(recoverRefresh(options).cursor).toBeNull()
    expect(git(options.repoRoot, 'diff', '--cached', '--name-only')).toBe(map)
  })

  test('CLI supports the start/check/finish contract without an audit JSON', () => {
    const options = fixture()
    const helper = join(import.meta.dir, 'workspaceMapRefreshState.ts')
    const cli = (...args: string[]) => JSON.parse(execFileSync('bun', [helper, ...args, '--repo-root', options.repoRoot, '--state-dir', options.stateDir], { encoding: 'utf8' }))
    const run = cli('start').run
    const checked = cli('check', '--run-id', run.runId)
    const result = cli('finish', '--run-id', run.runId, '--reviewed-map-hash', checked.mapHash, '--summary', 'Reviewed fixture ownership.', '--baseline-reviewed')
    expect(result.run.status).toBe('complete')
    expect(result.cursor.sourceSha).toBe(run.targetSha)
  })
})
